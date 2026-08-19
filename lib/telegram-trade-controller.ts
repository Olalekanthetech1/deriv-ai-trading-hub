import { DerivAuthenticatedClient } from './deriv-server-client';
import { fetchDerivTickHistory } from '@/lib/ticks-helper';
import { getLiveRiseFallSymbols, type RiseFallSymbolMetadata } from './rise-fall-symbols';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString } from './db';
import {
  claimTelegramTradeIntent,
  decryptSecret,
  ensureTelegramSchema,
  updateTelegramTradeIntent,
} from './telegram-db';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const VALID_STAKES = new Set([1, 5, 10, 25, 50]);

type LiveSignal = {
  prediction: {
    signal: 'CALL' | 'PUT';
    confidence: number;
    probabilityUp: number | null;
    probabilityDown: number | null;
    symbol: string;
    timestamp: number;
    modelVersion: string;
  };
  executionPlan: {
    executionPlanId: string;
    selectedHorizon: { value: number; unit: 't' | 's' | 'm' | 'h' | 'd'; label: string };
    predictionHorizon: { value: number; unit: 't' | 's' | 'm' | 'h' | 'd'; label: string };
    horizonAligned: boolean;
    strategyGateAccepted: boolean;
  };
  decisionSnapshot?: unknown;
  strategyGate?: { accepted?: boolean; confidenceGateThreshold?: number; riskTier?: string };
};

export interface TelegramUserRecord {
  chat_id: number;
  telegram_username?: string;
  first_name?: string;
  account_id: string;
  token_encrypted: string;
  account_type: 'demo' | 'real';
  currency: string;
  active_symbol: string;
  active_stake: number;
  active_duration_unit: string;
  active_duration_value: number;
  autotrade_strategy: string;
  scaling_factor: number;
  max_steps: number;
  max_trades: number;
  is_autotrading: boolean;
}

export class TelegramBotController {
  private botToken: string;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  }

  private getInternalBaseUrl(): string {
    const configured = process.env.APP_URL || process.env.RENDER_BACKEND_URL;
    if (configured) return configured.replace(/\/$/, '');
    return `http://127.0.0.1:${process.env.PORT || '3000'}`;
  }

  private async getAuthoritativeTelegramSymbols(): Promise<RiseFallSymbolMetadata[]> {
    const discovered = await getLiveRiseFallSymbols(true, false);
    const eligible = discovered.filter(
      (item) => item.isAvailable && item.isOpen && item.isRiseFallSupported && item.categoryKeys.includes('volatility')
    );
    if (eligible.length === 0) throw new Error('TELEGRAM_SYMBOL_UNIVERSE_EMPTY');
    return eligible;
  }

  async sendApi(method: string, payload: Record<string, any>) {
    if (!this.botToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(`${TELEGRAM_API_BASE}${this.botToken}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => null);

        if (res.ok && data?.ok === true) return data;

        const retryable = res.status === 429 || res.status >= 500;
        const description = typeof data?.description === 'string' ? data.description : `HTTP ${res.status}`;
        lastError = new Error(`[Telegram API ${method}] ${description}`);
        if (!retryable || attempt === 3) throw lastError;
      } catch (err) {
        lastError = err;
        if (attempt === 3) break;
      } finally {
        clearTimeout(timer);
      }

      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }

    console.error(`[TelegramBot Error ${method}]:`, lastError instanceof Error ? lastError.message : 'unknown');
    throw lastError instanceof Error ? lastError : new Error(`Telegram ${method} failed`);
  }

  private async safeSendApi(method: string, payload: Record<string, any>) {
    try {
      return await this.sendApi(method, payload);
    } catch (err) {
      console.error(`[TelegramBot Notification Failure ${method}]:`, err instanceof Error ? err.message : 'unknown');
      return null;
    }
  }

  private async getSql() {
    const dbUrl = getDbConnectionString();
    if (!dbUrl) return null;
    const sql = neon(dbUrl);
    await ensureTelegramSchema(sql);
    return sql;
  }

  async getUser(chatId: number): Promise<TelegramUserRecord | null> {
    const sql = await this.getSql();
    if (!sql) return null;
    const rows = await sql`
      SELECT * FROM telegram_users WHERE chat_id = ${chatId} LIMIT 1
    `;
    return rows.length ? (rows[0] as unknown as TelegramUserRecord) : null;
  }

  private async resolveTargetAccountId(
    client: DerivAuthenticatedClient,
    user: TelegramUserRecord,
    chatId: number
  ): Promise<string> {
    const accounts = await client.getAccountsList();
    const desiredType = user.account_type;
    const exact = accounts.find(
      (account) => account.account_id === user.account_id &&
        ((desiredType === 'demo' && account.is_virtual === 1) ||
         (desiredType === 'real' && account.is_virtual === 0))
    );
    const matched = exact || accounts.find(
      (account) => desiredType === 'demo' ? account.is_virtual === 1 : account.is_virtual === 0
    );

    if (!matched) {
      throw new Error(`No ${desiredType} Deriv trading account is available for this credential`);
    }

    if (matched.account_id !== user.account_id || matched.currency !== user.currency) {
      const sql = await this.getSql();
      if (sql) {
        await sql`
          UPDATE telegram_users
          SET account_id = ${matched.account_id}, currency = ${matched.currency}, updated_at = NOW()
          WHERE chat_id = ${chatId}
        `;
      }
      user.account_id = matched.account_id;
      user.currency = matched.currency;
    }

    return matched.account_id;
  }

  async unlinkUser(chatId: number) {
    const sql = await this.getSql();
    if (!sql) return;
    await sql`DELETE FROM telegram_users WHERE chat_id = ${chatId}`;
  }

  async updateUser(chatId: number, updates: Partial<TelegramUserRecord>) {
    const sql = await this.getSql();
    if (!sql) return;

    if (updates.active_symbol) {
      await sql`UPDATE telegram_users SET active_symbol = ${updates.active_symbol}, updated_at = NOW() WHERE chat_id = ${chatId}`;
    }
    if (updates.active_stake !== undefined && Number.isFinite(Number(updates.active_stake))) {
      await sql`UPDATE telegram_users SET active_stake = ${Number(updates.active_stake)}, updated_at = NOW() WHERE chat_id = ${chatId}`;
    }
    if (updates.active_duration_unit && updates.active_duration_value !== undefined) {
      await sql`
        UPDATE telegram_users
        SET active_duration_unit = ${updates.active_duration_unit},
            active_duration_value = ${Number(updates.active_duration_value)},
            updated_at = NOW()
        WHERE chat_id = ${chatId}
      `;
    }
    if (updates.account_type) {
      await sql`UPDATE telegram_users SET account_type = ${updates.account_type}, updated_at = NOW() WHERE chat_id = ${chatId}`;
    }
    if (updates.autotrade_strategy) {
      await sql`UPDATE telegram_users SET autotrade_strategy = ${updates.autotrade_strategy}, updated_at = NOW() WHERE chat_id = ${chatId}`;
    }
  }

  private async requestLiveSignal(
    user: TelegramUserRecord,
    symbol: string,
    authorizedSymbols?: ReadonlySet<string>
  ): Promise<LiveSignal> {
    const allowed = authorizedSymbols ?? new Set((await this.getAuthoritativeTelegramSymbols()).map((item) => item.symbol));
    if (!allowed.has(symbol)) throw new Error('UNSUPPORTED_TELEGRAM_SYMBOL');

    const response = await fetch(`${this.getInternalBaseUrl()}/api/signals/predict`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({
        symbol,
        durationValue: user.active_duration_value,
        durationUnit: user.active_duration_unit,
        isAutoDuration: true,
        mode: 'auto',
        autoHorizonMode: 'auto',
      }),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || data?.success !== true || !data.prediction || !data.executionPlan) {
      const code = typeof data?.error === 'string' ? data.error : 'AI_SIGNAL_UNAVAILABLE';
      throw new Error(code);
    }

    const signal = data as LiveSignal;
    if (!signal.executionPlan.horizonAligned || signal.executionPlan.strategyGateAccepted !== true) {
      throw new Error('AI_SIGNAL_NOT_EXECUTABLE');
    }
    if (signal.prediction.symbol !== symbol) {
      throw new Error('AI_SIGNAL_SYMBOL_MISMATCH');
    }

    return signal;
  }

  async renderUnlinkedScreen(chatId: number, firstName?: string) {
    const webUrl = process.env.APP_URL || 'https://deriv-trading.app';
    await this.safeSendApi('sendMessage', {
      chat_id: chatId,
      text:
        `👋 *Welcome ${firstName || 'Trader'} to Deriv AI Terminal*\n\n` +
        `Your intelligent microstructure trading terminal powered by the production signal pipeline.\n\n` +
        `⚠️ *No Account Connected*\nConnect your Deriv account from the Web App to begin.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 Connect via Web App', url: webUrl }],
          [{ text: '❓ How It Works & FAQ', callback_data: 'nav_faq' }],
        ],
      },
    });
  }

  async renderDepositScreen(chatId: number, messageId: number) {
    const text =
      `💳 *DERIV CASHIER & DEPOSIT*\n\n` +
      `To make a deposit into your Real Deriv account, please use the official Deriv Cashier:\n\n` +
      `https://app.deriv.com/cashier/deposit`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🌐 Open Deriv Cashier', url: 'https://app.deriv.com/cashier/deposit' }],
        [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
      ],
    };

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  async renderMainTerminal(chatId: number, messageId?: number) {
    const user = await this.getUser(chatId);
    if (!user) return this.renderUnlinkedScreen(chatId);

    const token = decryptSecret(user.token_encrypted);
    let realBalanceStr = '0.00 USD';
    let demoBalanceStr = '0.00 USD';

    if (token) {
      const client = new DerivAuthenticatedClient(token);
      try {
        const accounts = await client.getAccountsList();
        const realAcc = accounts.find((a) => a.is_virtual === 0);
        const demoAcc = accounts.find((a) => a.is_virtual === 1);

        if (realAcc) {
          realBalanceStr = `${Number(realAcc.balance).toFixed(2)} ${realAcc.currency || 'USD'}`;
        }
        if (demoAcc) {
          demoBalanceStr = `${Number(demoAcc.balance).toFixed(2)} ${demoAcc.currency || 'USD'}`;
        }
      } catch (err) {
        console.error('[Deriv Accounts Fetch Error]:', err instanceof Error ? err.message : 'unknown');
      } finally {
        client.close();
      }
    }

    const text =
      `🎮 Trading mode: ${user.account_type.toUpperCase()} 🎮\n\n` +
      `💰 Real Balance: ${realBalanceStr}\n` +
      `🎮 Demo Balance: ${demoBalanceStr}\n\n` +
      `Press 🚀 Start Trade to analyze markets and execute trades.`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🚀 Start Trade', callback_data: 'menu_start_trade' }],
        [
          { text: '💰 Deposit', callback_data: 'menu_deposit' },
          { text: '📱 My Account', callback_data: 'menu_account' },
        ],
        [
          { text: '🎮 Demo / Real', callback_data: 'action_switch_demo_real' },
          { text: '💬 Support', callback_data: 'nav_faq' },
        ],
      ],
    };

    await this.safeSendApi(messageId ? 'editMessageText' : 'sendMessage', {
      chat_id: chatId,
      ...(messageId ? { message_id: messageId } : {}),
      text,
      reply_markup: keyboard,
    });
  }

  async renderAssetSelection(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return this.renderUnlinkedScreen(chatId);

    // Step 1: Display initial live scanning status card
    const scanningText =
      `🤖 *AI IS ANALYZING THE MARKET*\n` +
      `_Optimizing your next trades..._\n\n` +
      `📡 *TERMINAL:* Launched ✅\n` +
      `📶 *Data stream:* Connected ✅\n` +
      `🤖 *AI analysis:* Running...\n` +
      `⌛ *Next Signal:* Pending...`;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: scanningText,
      parse_mode: 'Markdown',
    });

    // Step 2: Resolve the live Deriv volatility universe from the authoritative discovery layer.
    let candidateSymbols: RiseFallSymbolMetadata[];
    try {
      candidateSymbols = await this.getAuthoritativeTelegramSymbols();
    } catch (err) {
      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `⚠️ *LIVE MARKET UNIVERSE UNAVAILABLE*\n\n\`${err instanceof Error ? err.message : 'TELEGRAM_SYMBOL_UNIVERSE_UNAVAILABLE'}\`\n\nNo static market list or simulated symbols will be used. Retry when the authoritative Deriv discovery service is available.`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Retry Scan', callback_data: 'menu_start_trade' }]] },
      });
      return;
    }

    const authorizedSymbols = new Set(candidateSymbols.map((item) => item.symbol));
    const scanResults: { symbol: string; name: string; winRate: number; signal: string }[] = [];

    await Promise.all(
      candidateSymbols.map(async (metadata) => {
        try {
          const signal = await this.requestLiveSignal(user, metadata.symbol, authorizedSymbols);
          const winRate = Math.round(signal.prediction.confidence);
          scanResults.push({
            symbol: metadata.symbol,
            name: metadata.displayName,
            winRate,
            signal: signal.prediction.signal,
          });
        } catch (err) {
          console.warn(`[Live ML signal unavailable for ${metadata.symbol}]:`, err instanceof Error ? err.message : 'unknown');
        }
      })
    );

    // If live predictions from /api/signals/predict could not be retrieved for any asset, display DEGRADED state
    if (scanResults.length === 0) {
      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text:
          `⚠️ *LIVE MARKET STREAM DEGRADED*\n\n` +
          `Unable to retrieve live AI model predictions from the signal engine. Per AGENTS.md safety rules, zero fallbacks or simulated values are permitted.\n\n` +
          `Please tap "🔄 Retry Scan" below to re-query the production signal pipeline.`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Retry Scan', callback_data: 'menu_start_trade' }],
            [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
          ],
        },
      });
      return;
    }

    // Sort scanned assets by win rate descending
    scanResults.sort((a, b) => b.winRate - a.winRate);

    // Step 3: Format dynamic leaderboard & choice buttons
    let leaderboardLines = '';
    const keyboardButtons: { text: string; callback_data: string }[][] = [];

    scanResults.forEach((res, index) => {
      const medal = index === 0 ? '🏆' : '✅';
      leaderboardLines += `${medal} *${res.name}*: Win rate = *${res.winRate}%*\n`;
      const btnIcon = index === 0 ? '🏆' : '📈';
      keyboardButtons.push([
        {
          text: `${btnIcon} ${res.name}`,
          callback_data: `asset_${res.symbol}`,
        },
      ]);
    });

    keyboardButtons.push([{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }]);

    const finalMessageText =
      `📊 *CHOOSE TRADING ASSET*\n` +
      `_Select your preferred market asset_\n\n` +
      `🏆 *Bot Prediction:*\n` +
      `Highest chance to win right now:\n` +
      `${leaderboardLines}\n` +
      `📌 *Make your choice below*`;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: finalMessageText,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboardButtons,
      },
    });
  }

  async renderSignalCard(chatId: number, messageId: number, symbol: string) {
    const user = await this.getUser(chatId);
    if (!user) return;
    await this.updateUser(chatId, { active_symbol: symbol });

    try {
      const signal = await this.requestLiveSignal(user, symbol);
      const directionText = signal.prediction.signal === 'CALL' ? '↗️ RISE / CALL' : '↘️ FALL / PUT';
      const probability = signal.prediction.confidence.toFixed(1);
      const horizon = signal.executionPlan.selectedHorizon;

      const text =
        `${signal.prediction.signal === 'CALL' ? '🟢' : '🔴'} *LIVE PRODUCTION AI SIGNAL*\n\n` +
        `🎯 *Asset:* \`${symbol}\`\n` +
        `🧭 *Direction:* *${directionText}*\n` +
        `🤖 *Model:* \`${signal.prediction.modelVersion}\`\n` +
        `📈 *Confidence:* *${probability}%*\n` +
        `⏱ *Authoritative Horizon:* \`${horizon.label}\`\n` +
        `🛡 *Strategy Gate:* \`ACCEPTED\`\n` +
        `🔗 *Execution Plan:* \`${signal.executionPlan.executionPlanId}\`\n\n` +
        `The signal above is live and must be revalidated immediately before execution.`;

      const keyboard = {
        inline_keyboard: [
          [
            ...[1, 5, 10, 25, 50].map((stake) => ({ text: `${stake} USD`, callback_data: `stake_${symbol}_${stake}` })),
          ],
          [{ text: `⚡ Execute Default ($${Number(user.active_stake).toFixed(2)})`, callback_data: `exec_${symbol}_${Number(user.active_stake)}` }],
          [
            { text: '🔙 Back to Assets', callback_data: 'menu_start_trade' },
            { text: '🏠 Main Menu', callback_data: 'nav_main_menu' },
          ],
        ],
      };

      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (err) {
      const code = err instanceof Error ? err.message : 'AI_SIGNAL_UNAVAILABLE';
      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `⚠️ *Live AI Signal Unavailable*\n\n\`${code}\`\n\nNo trade can be executed until an authoritative signal is available.`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Back to Assets', callback_data: 'menu_start_trade' }]],
        },
      });
    }
  }

  async executeTrade(chatId: number, messageId: number, symbol: string, stake: number, idempotencyKey: string) {
    const user = await this.getUser(chatId);
    if (!user) return;

    const normalizedStake = Number(stake);
    if (!Number.isFinite(normalizedStake) || normalizedStake <= 0 || normalizedStake > 100000) {
      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: '❌ Invalid stake amount.',
      });
      return;
    }

    if (!VALID_STAKES.has(normalizedStake) && normalizedStake !== Number(user.active_stake)) {
      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: '❌ This stake is not an approved Telegram trading amount.',
      });
      return;
    }

    const sql = await this.getSql();
    if (!sql) {
      await this.safeSendApi('editMessageText', { chat_id: chatId, message_id: messageId, text: '❌ Database unavailable. Trade blocked.' });
      return;
    }

    const claimed = await claimTelegramTradeIntent(sql, idempotencyKey, chatId);
    if (!claimed) {
      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: 'ℹ️ This Telegram trade request was already processed or is still in progress.',
      });
      return;
    }

    const token = decryptSecret(user.token_encrypted);
    if (!token) {
      await updateTelegramTradeIntent(sql, idempotencyKey, 'failed');
      await this.safeSendApi('sendMessage', {
        chat_id: chatId,
        text: '❌ *Session unavailable.* Please reconnect the Deriv account before trading.',
        parse_mode: 'Markdown',
      });
      return;
    }

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `⚡ *Trade Processing*\n\`$${normalizedStake.toFixed(2)}\` on \`${symbol}\`\n\nRefreshing the production AI signal and authoritative horizon...`,
      parse_mode: 'Markdown',
    });

    const client = new DerivAuthenticatedClient(token);
    try {
      const signal = await this.requestLiveSignal(user, symbol);
      const contractType = signal.prediction.signal === 'CALL' ? 'CALL' : 'PUT';
      const selectedHorizon = signal.executionPlan.selectedHorizon;
      const targetAccountId = await this.resolveTargetAccountId(client, user, chatId);
      await client.connect(targetAccountId);

      const proposal = await client.getProposal({
        amount: normalizedStake,
        currency: user.currency,
        contract_type: contractType,
        duration: selectedHorizon.value,
        duration_unit: selectedHorizon.unit,
        symbol,
      });
      if (!proposal) throw new Error('DERIV_PROPOSAL_UNAVAILABLE');

      const buyRes = await client.buyContract(proposal.id, proposal.ask_price);
      if (!buyRes) throw new Error('DERIV_BUY_REJECTED');

      await sql`
        UPDATE telegram_trade_intents
        SET contract_id = ${buyRes.contract_id}, updated_at = NOW()
        WHERE idempotency_key = ${idempotencyKey}
      `;

      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text:
          `⚡ *Live Trade Active*\n` +
          `• *Asset:* \`${symbol}\`\n` +
          `• *Direction:* \`${contractType}\`\n` +
          `• *Stake:* \`$${normalizedStake.toFixed(2)}\`\n` +
          `• *Horizon:* \`${selectedHorizon.label}\`\n` +
          `• *Confidence:* \`${signal.prediction.confidence.toFixed(1)}%\`\n` +
          `• *Model:* \`${signal.prediction.modelVersion}\`\n` +
          `• *Contract:* \`#${buyRes.contract_id}\`\n\n` +
          `_Waiting for broker settlement..._`,
        parse_mode: 'Markdown',
      });

      const settlement = await client.waitForContractSettlement(buyRes.contract_id, 45000);
      const newBal = await client.getBalance();
      const profit = Number(settlement.profit || 0);
      const payout = Number(settlement.payout || 0);

      await sql`
        INSERT INTO telegram_trade_logs (
          chat_id,
          contract_id,
          symbol,
          contract_type,
          stake,
          payout,
          profit,
          status,
          execution_plan_id,
          model_id,
          win_probability,
          raw_response
        ) VALUES (
          ${chatId},
          ${buyRes.contract_id},
          ${symbol},
          ${contractType},
          ${normalizedStake},
          ${payout},
          ${profit},
          ${settlement.is_won ? 'won' : settlement.is_settled ? 'lost' : 'timeout'},
          ${signal.executionPlan.executionPlanId},
          ${signal.prediction.modelVersion},
          ${signal.prediction.confidence / 100},
          ${JSON.stringify({ signal, settlement, buyRes })}
        )
      `;

      await updateTelegramTradeIntent(sql, idempotencyKey, 'completed', buyRes.contract_id);

      const resultText = settlement.is_won
        ? `🎉 *PROFIT*\n\n*Result:* *+$${profit.toFixed(2)}*\n💵 *Balance:* *$${Number(newBal.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${newBal.currency}*`
        : settlement.is_settled
          ? `🔴 *TRADE CLOSED*\n\n*Result:* *$${profit.toFixed(2)}*\n💵 *Balance:* *$${Number(newBal.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${newBal.currency}*`
          : `⚠️ *Settlement not confirmed within the monitoring window.*\n\n💵 *Latest Balance:* *$${Number(newBal.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${newBal.currency}*`;

      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `${resultText}\n\n🧾 *Execution Plan:* \`${signal.executionPlan.executionPlanId}\``,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 New Trade', callback_data: 'menu_start_trade' }],
            [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
          ],
        },
      });
    } catch (err) {
      await updateTelegramTradeIntent(sql, idempotencyKey, 'failed');
      console.error('[Trade Execution Failed]:', err instanceof Error ? err.message : 'unknown');
      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `❌ *Trade blocked*\n\n\`${err instanceof Error ? err.message : 'Broker execution unavailable'}\``,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }]],
        },
      });
    } finally {
      client.close();
    }
  }

  async renderAccountScreen(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return;

    const token = decryptSecret(user.token_encrypted);
    let balanceStr = 'Unavailable';
    let emailStr = 'Unavailable';

    if (token) {
      const client = new DerivAuthenticatedClient(token);
      try {
        const targetAccountId = await this.resolveTargetAccountId(client, user, chatId);
        const authInfo = await client.connect(targetAccountId);
        balanceStr = `$${Number(authInfo.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${authInfo.currency}`;
        emailStr = authInfo.email || 'Unavailable';
      } catch (err) {
        console.error('[Deriv Account Fetch Error]:', err instanceof Error ? err.message : 'unknown');
      } finally {
        client.close();
      }
    }

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `👤 *MY ACCOUNT*\n\n` +
        `🎮 *Trading Mode:* \`${user.account_type.toUpperCase()}\`\n` +
        `📧 *Login ID:* \`${user.account_id}\`\n` +
        `📬 *Email:* \`${emailStr}\`\n` +
        `💵 *Active Balance:* *${balanceStr}*\n` +
        `⚙️ *Risk Scaling:* \`${user.scaling_factor}x (Max ${user.max_steps} Steps)\``,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💰 Deposit', callback_data: 'menu_deposit' }],
          [
            { text: '💵 Withdraw', callback_data: 'menu_withdrawal' },
            { text: '⚙️ Settings', callback_data: 'menu_settings' },
          ],
          [
            { text: '↪️ Logout', callback_data: 'action_logout' },
            { text: '📘 F.A.Q.', callback_data: 'nav_faq' },
          ],
          [{ text: '⬅️ Main menu', callback_data: 'nav_main_menu' }],
        ],
      },
    });
  }

  async renderWithdrawalScreen(chatId: number, messageId: number) {
    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `💳 *DERIV CASHIER WITHDRAWAL*\n\n` +
        `To safely withdraw your balance and profits, access the official Deriv Cashier portal directly:\n\n` +
        `🔗 [Deriv Withdrawal Cashier Portal](https://app.deriv.com/cashier/withdrawal)`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Open Withdrawal Portal', url: 'https://app.deriv.com/cashier/withdrawal' }],
          [{ text: '⬅️ Main menu', callback_data: 'nav_main_menu' }],
        ],
      },
    });
  }

  async renderSettingsScreen(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `⚙️ *SETTINGS & RISK CONTROLS*\n\n` +
        `🎯 *Configured Duration:* \`${user.active_duration_value} ${user.active_duration_unit.toUpperCase()}\`\n` +
        `⚡ *Autotrade Strategy:* \`${user.autotrade_strategy.toUpperCase()}\`\n` +
        `📈 *Scaling Factor:* \`${user.scaling_factor}x\`\n` +
        `🛑 *Max Recovery Steps:* \`${user.max_steps}\`\n` +
        `🔒 *HDE Lineage Gate:* \`Active\``,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⏱ Expiration Duration', callback_data: 'set_duration_menu' }],
          [{ text: '🔙 Back to Dashboard', callback_data: 'nav_main_menu' }],
        ],
      },
    });
  }

  async renderDurationMenu(chatId: number, messageId: number) {
    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `⏱ *EXPIRATION TIME SETTINGS*\n\n` +
        `The selected duration is passed to the authoritative horizon engine; the live execution horizon is still re-evaluated before trade.` ,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '5 Ticks', callback_data: 'set_dur_5_t' }, { text: '10 Ticks', callback_data: 'set_dur_10_t' }],
          [{ text: '15 Seconds', callback_data: 'set_dur_15_s' }, { text: '30 Seconds', callback_data: 'set_dur_30_s' }, { text: '60 Seconds', callback_data: 'set_dur_60_s' }],
          [{ text: '🔙 Back to Settings', callback_data: 'menu_settings' }],
        ],
      },
    });
  }

  async renderFaqScreen(chatId: number, messageId?: number) {
    const payload = {
      chat_id: chatId,
      text:
        `📖 *DERIV TRADING TERMINAL — FAQ*\n\n` +
        `1️⃣ *How does this bot work?*\nIt obtains live predictions from the production ensemble, validates the authoritative horizon, and only then sends a Deriv proposal/buy request.\n\n` +
        `2️⃣ *How are credentials stored?*\nDeriv credentials are encrypted at rest with AES-256-GCM. TELEGRAM_AUTH_SECRET is mandatory; there is no hardcoded fallback key.\n\n` +
        `3️⃣ *Can I switch between Demo and Real?*\nYes. The account is re-resolved against the verified Deriv credential each time.\n\n` +
        `4️⃣ *Are Telegram signals hardcoded?*\nNo. Signal cards and execution use fresh production API predictions and authoritative horizon decisions.`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🏠 Back to Main Menu', callback_data: 'nav_main_menu' }]] },
    };

    await this.safeSendApi(messageId ? 'editMessageText' : 'sendMessage', messageId ? { ...payload, message_id: messageId } : payload);
  }

  async handlePairingCode(chatId: number, pairingCode: string, fromUser: any) {
    if (!/^[a-f0-9]{32}$/i.test(pairingCode)) {
      return this.safeSendApi('sendMessage', { chat_id: chatId, text: '❌ Invalid or expired pairing link.', parse_mode: 'Markdown' });
    }

    const sql = await this.getSql();
    if (!sql) {
      return this.safeSendApi('sendMessage', { chat_id: chatId, text: '❌ Database unavailable.', parse_mode: 'Markdown' });
    }

    const rows = await sql`
      UPDATE telegram_pairing_tokens
      SET used = TRUE
      WHERE pairing_code = ${pairingCode}
        AND used = FALSE
        AND expires_at > NOW()
      RETURNING account_id, token_encrypted, account_type, currency
    `;

    if (!rows.length) {
      return this.safeSendApi('sendMessage', {
        chat_id: chatId,
        text: '❌ *Invalid or expired pairing link.*\nPlease start a new pairing from the Web App.',
        parse_mode: 'Markdown',
      });
    }

    const pairRecord = rows[0];
    await sql`
      INSERT INTO telegram_users (
        chat_id,
        telegram_username,
        first_name,
        account_id,
        token_encrypted,
        account_type,
        currency
      ) VALUES (
        ${chatId},
        ${fromUser.username || null},
        ${fromUser.first_name || null},
        ${pairRecord.account_id},
        ${pairRecord.token_encrypted},
        ${pairRecord.account_type || 'demo'},
        ${pairRecord.currency || 'USD'}
      )
      ON CONFLICT (chat_id) DO UPDATE SET
        telegram_username = EXCLUDED.telegram_username,
        first_name = EXCLUDED.first_name,
        account_id = EXCLUDED.account_id,
        token_encrypted = EXCLUDED.token_encrypted,
        account_type = EXCLUDED.account_type,
        currency = EXCLUDED.currency,
        updated_at = NOW()
    `;

    const token = decryptSecret(pairRecord.token_encrypted);
    let balanceStr = 'Unavailable';
    if (token) {
      const client = new DerivAuthenticatedClient(token);
      try {
        const auth = await client.connect(pairRecord.account_id);
        balanceStr = `$${Number(auth.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${auth.currency}`;
      } catch (err) {
        console.error('[Telegram Pair Verification Error]:', err instanceof Error ? err.message : 'unknown');
      } finally {
        client.close();
      }
    }

    await this.safeSendApi('sendMessage', {
      chat_id: chatId,
      text:
        `🎉 *Account Connected Successfully!*\n\n` +
        `Welcome *${fromUser.first_name || 'Trader'}*!\n` +
        `💼 *Account:* \`${pairRecord.account_id}\` (${String(pairRecord.account_type || 'demo').toUpperCase()})\n` +
        `💵 *Live Balance:* *${balanceStr}*\n\n` +
        `The bot will request a fresh AI signal before every trade.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Start Trade', callback_data: 'menu_start_trade' }],
          [{ text: '🏠 Main Dashboard', callback_data: 'nav_main_menu' }],
        ],
      },
    });
  }
}
