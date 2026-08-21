import { DerivAuthenticatedClient } from './deriv-server-client';
import { fetchDerivTickHistory } from '@/lib/ticks-helper';
import { getLiveRiseFallSymbols, type RiseFallSymbolMetadata } from './rise-fall-symbols';
import { getValidMarketRankingSnapshot, refreshLiveMarketRankings, type LiveMarketRankingSnapshot } from './market-ranking-cache';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString } from './db';
import { getGlobalTradingCircuitBreakerConfig } from './ops-runtime-config';
import {
  claimTelegramTradeIntent,
  decryptSecret,
  ensureTelegramSchema,
  updateTelegramTradeIntent,
} from './telegram-db';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const VALID_STAKES = new Set([1, 5, 10, 25, 50]);

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[`])/g, '\\$1');
}

function markdownToHtml(md: string): string {
  if (!md) return '';
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const codes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (match, p1) => {
    codes.push(p1);
    return `__CODE_${codes.length - 1}__`;
  });

  const links: {text: string, url: string}[] = [];
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, p1, p2) => {
    links.push({text: p1, url: p2});
    return `__LINK_${links.length - 1}__`;
  });

  html = html.replace(/\*([^*]+)\*/g, '<b>$1</b>');
  html = html.replace(/(^|\W)_([^_]+)_(?!\w)/g, '$1<i>$2</i>');

  html = html.replace(/__LINK_(\d+)__/g, (match, p1) => {
    const link = links[parseInt(p1, 10)];
    return `<a href="${link.url}">${link.text}</a>`;
  });

  html = html.replace(/__CODE_(\d+)__/g, (match, p1) => {
    return `<code>${codes[parseInt(p1, 10)]}</code>`;
  });

  return html;
}

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
  language: string;
  support_state?: string;
}

function formatBrokerExecutionError(err: unknown): string {
  if (!(err instanceof Error)) return 'Broker execution unavailable.';
  const msg = err.message || '';
  if (msg.includes('OfferingsValidationError') || msg.includes('Trading is not offered') || msg.includes('OfferingsInvalidSymbol')) {
    return 'Trading is currently not offered or available for this asset on your account type.';
  }
  if (msg.includes('Input validation failed')) {
    return 'Invalid parameter format sent to broker.';
  }
  if (msg.includes('InsufficientBalance') || msg.toLowerCase().includes('insufficient balance')) {
    return 'Insufficient account balance to execute trade.';
  }
  if (msg.includes('MarketIsClosed') || msg.toLowerCase().includes('market is closed')) {
    return 'The market for this asset is currently closed.';
  }
  return msg;
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

    if (payload && payload.parse_mode === 'Markdown' && typeof payload.text === 'string') {
      payload = {
        ...payload,
        text: markdownToHtml(payload.text),
        parse_mode: 'HTML',
      };
    }

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
    if (updates.is_autotrading !== undefined) {
      await sql`UPDATE telegram_users SET is_autotrading = ${!!updates.is_autotrading}, updated_at = NOW() WHERE chat_id = ${chatId}`;
    }
    if (updates.scaling_factor !== undefined && Number.isFinite(Number(updates.scaling_factor))) {
      await sql`UPDATE telegram_users SET scaling_factor = ${Number(updates.scaling_factor)}, updated_at = NOW() WHERE chat_id = ${chatId}`;
    }
    if (updates.max_steps !== undefined && Number.isInteger(Number(updates.max_steps))) {
      await sql`UPDATE telegram_users SET max_steps = ${Number(updates.max_steps)}, updated_at = NOW() WHERE chat_id = ${chatId}`;
    }
    if (updates.max_trades !== undefined && Number.isInteger(Number(updates.max_trades))) {
      await sql`UPDATE telegram_users SET max_trades = ${Number(updates.max_trades)}, updated_at = NOW() WHERE chat_id = ${chatId}`;
    }
    if (updates.language !== undefined) {
      await sql`UPDATE telegram_users SET language = ${updates.language}, updated_at = NOW() WHERE chat_id = ${chatId}`;
    }
    if (updates.support_state !== undefined) {
      await sql`UPDATE telegram_users SET support_state = ${updates.support_state}, updated_at = NOW() WHERE chat_id = ${chatId}`;
    }
  }

  private async requestLiveSignal(
    user: TelegramUserRecord,
    symbol: string,
    authorizedSymbols?: ReadonlySet<string>
  ): Promise<LiveSignal> {
    const allowed = authorizedSymbols ?? new Set((await this.getAuthoritativeTelegramSymbols()).map((item) => item.symbol));
    if (!allowed.has(symbol)) throw new Error('UNSUPPORTED_TELEGRAM_SYMBOL');

    const isAuto = user.active_duration_unit === 'auto';

    const response = await fetch(`${this.getInternalBaseUrl()}/api/signals/predict`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({
        symbol,
        durationValue: isAuto ? 5 : user.active_duration_value,
        durationUnit: isAuto ? 't' : user.active_duration_unit,
        isAutoDuration: isAuto,
        mode: isAuto ? 'auto' : 'manual',
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
    const escapedName = escapeMarkdown(firstName || 'Trader');
    await this.safeSendApi('sendMessage', {
      chat_id: chatId,
      text:
        `👋 *Welcome ${escapedName} to Deriv AI Terminal*\n\n` +
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

    const appUrl = process.env.APP_URL ? (process.env.APP_URL.endsWith('/') ? process.env.APP_URL.slice(0, -1) : process.env.APP_URL) : null;
    const photoUrl = appUrl ? `${appUrl}/telegram-assets/main-menu.png` : null;
    let success = false;

    if (photoUrl) {
      if (messageId) {
        // Attempt to edit caption first (assuming it's already a photo)
        const editRes = await this.safeSendApi('editMessageCaption', {
          chat_id: chatId,
          message_id: messageId,
          caption: text,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        if (editRes && editRes.ok) {
          success = true;
        } else {
          // If editing caption failed (likely because it was a text message originally),
          // delete it and send a fresh photo message.
          await this.safeSendApi('deleteMessage', { chat_id: chatId, message_id: messageId });
          const sendRes = await this.safeSendApi('sendPhoto', {
            chat_id: chatId,
            photo: photoUrl,
            caption: text,
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
          if (sendRes && sendRes.ok) success = true;
        }
      } else {
        // No messageId, just send a fresh photo
        const sendRes = await this.safeSendApi('sendPhoto', {
          chat_id: chatId,
          photo: photoUrl,
          caption: text,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        if (sendRes && sendRes.ok) success = true;
      }
    }

    if (!success) {
      // Fallback: If image sending completely failed (e.g., image not uploaded yet)
      // or no APP_URL configured, we must use standard text messaging.
      // If we already deleted the message in the photo flow attempt, we can't edit it, so we fallback to sendMessage.
      const method = (messageId && !photoUrl) ? 'editMessageText' : 'sendMessage';
      await this.safeSendApi(method, {
        chat_id: chatId,
        ...(method === 'editMessageText' ? { message_id: messageId } : {}),
        text,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    }

    // Background pre-warm for live market rankings cache (Option 3 optimization)
    getValidMarketRankingSnapshot().then((snapshot) => {
      if (!snapshot) {
        refreshLiveMarketRankings().catch((err) =>
          console.warn('[Pre-Warm Market Rankings Error]:', err instanceof Error ? err.message : 'unknown')
        );
      }
    });
  }

  async renderTradeModeSelection(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return this.renderUnlinkedScreen(chatId);

    const text = 
      `⚙️ *SELECT TRADING MODE*\n\n` +
      `How would you like to execute this trade?\n\n` +
      `🎯 *Manual Single Trade*\n` +
      `Executes exactly one trade with your selected stake. No recovery steps.\n\n` +
      `🤖 *Automated Strategy Session*\n` +
      `Uses your preset configuration (Max Steps: \`${user.max_steps || 1}\`, Scaling: \`${Number(user.scaling_factor || 1.0).toFixed(2)}x\`). Automatically recovers losses via Martingale.\n`;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎯 Manual Single Trade', callback_data: 'mode_single_trade' }],
          [{ text: '🤖 Automated Strategy Session', callback_data: 'mode_auto_strategy' }],
          [{ text: '🔙 Main Menu', callback_data: 'nav_main_menu' }],
        ],
      },
    });
  }

  async renderAssetSelection(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return this.renderUnlinkedScreen(chatId);

    // Fast-Path: Check Freshness Gate for pre-computed Ranking Snapshot (Option 1)
    let rankingSnapshot = await getValidMarketRankingSnapshot();

    if (!rankingSnapshot) {
      // Cache Miss or Expired -> Show dynamic progress stages while running Option 2 refresh pipeline
      const sendProgress = async (text: string) => {
        await this.safeSendApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: text,
          parse_mode: 'Markdown',
        }).catch(err => console.warn('[Telegram Edit Error]:', err instanceof Error ? err.message : 'unknown'));
      };

      const step1Text = 
        `🤖 *AI IS ANALYZING THE MARKET*\n` +
        `_Establishing secure connection..._\n\n` +
        `📡 TERMINAL: Connecting to broker... ⏳`;
      
      await sendProgress(step1Text);

      try {
        rankingSnapshot = await refreshLiveMarketRankings(async (stage) => {
          if (stage === 'data_stream') {
            const step2Text = 
              `🤖 *AI IS ANALYZING THE MARKET*\n` +
              `_Ingesting live market data..._\n\n` +
              `📡 TERMINAL: Launched ✅\n` +
              `📊 Data stream: Fetching live ticks... 🔄`;
            await sendProgress(step2Text);
          } else if (stage === 'ai_analysis') {
            const step3Text = 
              `🤖 *AI IS ANALYZING THE MARKET*\n` +
              `_Evaluating market anomalies..._\n\n` +
              `📡 TERMINAL: Launched ✅\n` +
              `📊 Data stream: Connected ✅\n` +
              `🧠 AI analysis: Running multi-horizon ensemble... ⚙️`;
            await sendProgress(step3Text);
          } else if (stage === 'target_locked') {
            const step4Text = 
              `🤖 *AI IS ANALYZING THE MARKET*\n` +
              `_Optimizing your next trades..._\n\n` +
              `📡 TERMINAL: Launched ✅\n` +
              `📊 Data stream: Connected ✅\n` +
              `🧠 AI analysis: Signals ranked ✅\n` +
              `🎯 Target locked: Loading highest win rates... ⏳`;
            await sendProgress(step4Text);
          }
        });
      } catch (err) {
        console.warn('[Live Ranking Refresh Error]:', err instanceof Error ? err.message : 'unknown');
      }

      if (!rankingSnapshot || rankingSnapshot.rankings.length === 0) {
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
    } else {
      // Cache Hit (<100ms response) -> Trigger async background refresh to keep cache warm
      refreshLiveMarketRankings().catch((err) =>
        console.warn('[Background Warmup Error]:', err instanceof Error ? err.message : 'unknown')
      );
    }

    // Format dynamic leaderboard & choice buttons from validated ranking snapshot
    let leaderboardLines = '';
    const keyboardButtons: { text: string; callback_data: string }[][] = [];

    rankingSnapshot.rankings.forEach((res, index) => {
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

    const dataAgeSec = (rankingSnapshot.dataAgeMs / 1000).toFixed(1);
    const finalMessageText =
      `📊 *CHOOSE TRADING ASSET*\n` +
      `_Select your preferred market asset_\n\n` +
      `🏆 *Bot Prediction:* _(Freshness: ${dataAgeSec}s, \`${rankingSnapshot.modelVersion || 'v2-production'}\`)_\n` +
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

  async handleManualStakePrompt(chatId: number, messageId: number, symbol: string) {
    await this.updateUser(chatId, { support_state: `awaiting_stake_${symbol}` });
    const text = `🔢 *MANUAL STAKE AMOUNT*\n\n` +
      `Please enter your custom stake amount in USD for *${symbol}* (e.g. \`15.50\`):\n\n` +
      `_Reply directly to this message with a number._`;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Cancel', callback_data: `asset_${symbol}` }]
        ]
      }
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
          [{ text: `🔢 Manual amount set`, callback_data: `manual_stake_${symbol}` }],
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

    const circuitBreaker = await getGlobalTradingCircuitBreakerConfig();
    if (circuitBreaker.isHalted) {
      await updateTelegramTradeIntent(sql, idempotencyKey, 'blocked_circuit_breaker');
      const reasonText = circuitBreaker.haltReason ? `\n*Reason:* ${circuitBreaker.haltReason}` : '';
      await this.safeSendApi('sendMessage', {
        chat_id: chatId,
        text: `🚨 *TRADING HALTED BY OPERATIONAL CONTROL*\n\nAutomated trade execution is currently paused by system circuit breaker.${reasonText}\n\n*Status:* Execution Aborted (Fail-Closed)`,
        parse_mode: 'Markdown',
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

    const isAuto = user.is_autotrading;
    const maxTrades = isAuto ? (user.max_trades || 1) : 1;
    const maxSteps = isAuto ? (user.max_steps || 1) : 1;
    const scalingFactor = isAuto ? (Number(user.scaling_factor) || 1.0) : 1.0;

    let sessionLedger = `Trade session initialized...\n\n`;
    let totalNetProfit = 0;
    let finalBalance: any = null;
    let anyTradeExecuted = false;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: sessionLedger,
    });

    const client = new DerivAuthenticatedClient(token);
    try {
      const targetAccountId = await this.resolveTargetAccountId(client, user, chatId);
      await client.connect(targetAccountId);

      for (let tradeIdx = 1; tradeIdx <= maxTrades; tradeIdx++) {
        let currentStake = normalizedStake;

        for (let step = 1; step <= maxSteps; step++) {
          anyTradeExecuted = true;
          
          const pendingLine = `⚡ Trade ${tradeIdx} | Step ${step} | ${currentStake.toFixed(2)} USD -> Pending...`;
          await this.safeSendApi('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: sessionLedger + pendingLine,
          });

          const signal = await this.requestLiveSignal(user, symbol);
          const contractType = signal.prediction.signal === 'CALL' ? 'CALL' : 'PUT';
          const selectedHorizon = signal.executionPlan.selectedHorizon;

          const proposal = await client.getProposal({
            amount: currentStake,
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

          let durationMs = 0;
          switch (selectedHorizon.unit) {
            case 't': durationMs = selectedHorizon.value * 2500; break; // ~2.5s per tick buffer
            case 's': durationMs = selectedHorizon.value * 1000; break;
            case 'm': durationMs = selectedHorizon.value * 60000; break;
            case 'h': durationMs = selectedHorizon.value * 3600000; break;
            case 'd': durationMs = selectedHorizon.value * 86400000; break;
          }
          const dynamicTimeoutMs = durationMs + 30000; // 30 second settlement buffer

          const settlement = await client.waitForContractSettlement(buyRes.contract_id, dynamicTimeoutMs);
          finalBalance = await client.getBalance();
          const profit = Number(settlement.profit || 0);
          const payout = Number(settlement.payout || 0);

          totalNetProfit += profit;

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
              ${currentStake},
              ${payout},
              ${profit},
              ${settlement.is_won ? 'won' : settlement.is_settled ? 'lost' : 'timeout'},
              ${signal.executionPlan.executionPlanId},
              ${signal.prediction.modelVersion},
              ${signal.prediction.confidence / 100},
              ${JSON.stringify({ signal, settlement, buyRes })}
            )
          `;

          const icon = settlement.is_won ? '🟢' : settlement.is_settled ? '🔴' : '⚠️';
          const resultStr = settlement.is_won ? `+$${profit.toFixed(2)} USD` : `-$${Math.abs(profit).toFixed(2)} USD`;
          sessionLedger += `${icon} Trade ${tradeIdx} | Step ${step} | ${currentStake.toFixed(2)} USD -> ${resultStr}\n`;
          
          if (settlement.is_won) {
            break;
          } else {
            currentStake = currentStake * scalingFactor;
          }
        }
      }

      await updateTelegramTradeIntent(sql, idempotencyKey, 'completed');

      if (anyTradeExecuted && finalBalance) {
        const victoryStr = totalNetProfit > 0 
          ? `🎉 *Profit!*\nSession completed successfully\n`
          : totalNetProfit < 0
            ? `⚠️ *Loss!*\nSession completed with a deficit\n`
            : `ℹ️ *Session completed.*\n`;
            
        const finalMessage = 
          `${sessionLedger}\n` +
          `${victoryStr}` +
          `Result: ${totalNetProfit >= 0 ? '' : ''}${totalNetProfit.toFixed(2)} USD\n` +
          `Balance: ${Number(finalBalance.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${finalBalance.currency}\n\n` +
          `Choose your next step...`;

        await this.safeSendApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: finalMessage,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚀 New Trade', callback_data: 'menu_start_trade' }],
              [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
            ],
          },
        });
      }

    } catch (err) {
      await updateTelegramTradeIntent(sql, idempotencyKey, 'failed');
      const rawError = err instanceof Error ? err.message : 'unknown';
      console.error('[Trade Execution Failed]:', rawError);
      const userMessage = formatBrokerExecutionError(err);
      
      const partialLedger = sessionLedger ? `${sessionLedger}\n` : '';
      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `${partialLedger}❌ *Trade blocked*\n\n\`${userMessage}\``,
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

    const modeText = user.is_autotrading ? '🟢 AUTOTRADE ACTIVE' : '🔴 MANUAL ONLY';
    const langLabel = user.language === 'es' ? 'Español 🇪🇸' : user.language === 'fr' ? 'Français 🇫🇷' : 'English 🇺🇸';

    const isAuto = user.active_duration_unit === 'auto';
    const durationLabel = isAuto ? '🤖 Auto (AI Optimal)' : `${user.active_duration_value} ${user.active_duration_unit.toUpperCase()}`;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `⚙️ *SETTINGS*\n` +
        `_Configure your preferences and options_\n\n` +
        `⚙️ *Trading Options*\n\n` +
        `🎯 *Autotrade Settings*\n` +
        `Fine-tune the bot to match your style — full control at your fingertips.\n\n` +
        `⏳ *Expiration Time*\n` +
        `Decide when your trades close (Current: \`${durationLabel}\`).\n\n` +
        `🛠️ *Mode Selection*\n` +
        `Switch between Manual and Autotrade anytime (Current: \`${modeText}\`).\n\n` +
        `🌐 *Language*\n` +
        `Select your preferred interface language (Current: \`${langLabel}\`).`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎯 Autotrade Settings', callback_data: 'set_autotrade_settings_menu' }],
          [{ text: '⏳ Expiration Time', callback_data: 'set_duration_menu' }],
          [{ text: `🛠️ Mode: ${user.is_autotrading ? 'Autotrade 🟢' : 'Manual 🔴'}`, callback_data: 'toggle_autotrade' }],
          [{ text: '🌐 Language', callback_data: 'set_language_menu' }],
          [{ text: '🔙 Back', callback_data: 'nav_main_menu' }],
        ],
      },
    });
  }

  async renderAutotradeSettingsMenu(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return;

    let strategyLabel = 'Balanced ⚖️';
    if (user.autotrade_strategy === 'conservative') strategyLabel = 'Conservative 🛡️';
    else if (user.autotrade_strategy === 'profit') strategyLabel = 'Profit 📈';
    else if (user.autotrade_strategy === 'custom') strategyLabel = 'Custom Settings ⚙️';

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `🎯 *AUTOTRADE STRATEGY PRESETS*\n` +
        `_Select a pre-configured risk-and-recovery profile or customize parameters._\n\n` +
        `⚡ *Active Profile:* \`${strategyLabel}\`\n` +
        `📊 *Scaling Factor:* \`${Number(user.scaling_factor).toFixed(2)}\`\n` +
        `🔄 *Max Steps:* \`${user.max_steps}\`\n` +
        `📈 *Max Trades:* \`${user.max_trades}\`\n\n` +
        `• *Balanced ⚖️*: \`2.20x\` scaling, \`5\` max steps, \`2\` max trades.\n` +
        `• *Conservative 🛡️*: \`2.10x\` scaling, \`5\` max steps, \`1\` max trade.\n` +
        `• *Profit 📈*: \`2.30x\` scaling, \`10\` max steps, \`3\` max trades.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚖️ Balanced', callback_data: 'preset_strat_balanced' },
            { text: '🛡️ Conservative', callback_data: 'preset_strat_conservative' },
          ],
          [
            { text: '📈 Profit', callback_data: 'preset_strat_profit' },
            { text: '⚙️ Custom Settings', callback_data: 'set_custom_settings_menu' },
          ],
          [{ text: '🔙 Back to Settings', callback_data: 'menu_settings' }],
        ],
      },
    });
  }

  async renderCustomSettingsMenu(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `⚙️ *Custom Settings*\n\n` +
        `📊 *Scaling factor:* \`${Number(user.scaling_factor).toFixed(2)}\`\n` +
        `🔄 *Max Steps:* \`${user.max_steps}\`\n` +
        `📈 *Max Trades:* \`${user.max_trades}\`\n\n` +
        `Set up your strategy:`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Scaling factor', callback_data: 'adjust_scale_menu' }],
          [{ text: '🔄 Max Steps', callback_data: 'adjust_steps_menu' }],
          [{ text: '📈 Max Trades', callback_data: 'adjust_trades_menu' }],
          [{ text: '🔙 Back', callback_data: 'set_autotrade_settings_menu' }],
        ],
      },
    });
  }

  async renderScalingFactorAdjuster(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `📊 *ADJUST SCALING FACTOR*\n` +
        `_Configure the multiplier applied to recovery trade sizes._\n\n` +
        `📊 *Current Scaling Factor:* \`${Number(user.scaling_factor).toFixed(2)}\``,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➖ 0.10', callback_data: 'custom_scale_down' },
            { text: '➕ 0.10', callback_data: 'custom_scale_up' },
          ],
          [{ text: '🔙 Back to Custom Settings', callback_data: 'set_custom_settings_menu' }],
        ],
      },
    });
  }

  async renderMaxStepsAdjuster(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `🔄 *ADJUST MAX RECOVERY STEPS*\n` +
        `_Configure the maximum sequence steps for automated recovery._\n\n` +
        `🔄 *Current Max Steps:* \`${user.max_steps}\``,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➖ 1', callback_data: 'custom_steps_down' },
            { text: '➕ 1', callback_data: 'custom_steps_up' },
          ],
          [{ text: '🔙 Back to Custom Settings', callback_data: 'set_custom_settings_menu' }],
        ],
      },
    });
  }

  async renderMaxTradesAdjuster(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `📈 *ADJUST MAX TRADES*\n` +
        `_Configure the maximum overall concurrent active trades allowed._\n\n` +
        `📈 *Current Max Trades:* \`${user.max_trades}\``,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➖ 1', callback_data: 'custom_trades_down' },
            { text: '➕ 1', callback_data: 'custom_trades_up' },
          ],
          [{ text: '🔙 Back to Custom Settings', callback_data: 'set_custom_settings_menu' }],
        ],
      },
    });
  }

  async renderLanguageMenu(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    if (!user) return;

    const currentLang = user.language === 'es' ? 'Español 🇪🇸' : user.language === 'fr' ? 'Français 🇫🇷' : 'English 🇺🇸';

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `🌐 *LANGUAGE SETTINGS*\n` +
        `_Select your preferred interface language_\n\n` +
        `🌐 *Active Language:* \`${currentLang}\``,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🇺🇸 English', callback_data: 'set_lang_en' },
            { text: '🇪🇸 Español', callback_data: 'set_lang_es' },
            { text: '🇫🇷 Français', callback_data: 'set_lang_fr' },
          ],
          [{ text: '🔙 Back to Settings', callback_data: 'menu_settings' }],
        ],
      },
    });
  }

  async renderDurationMenu(chatId: number, messageId: number) {
    const user = await this.getUser(chatId);
    const currentText = user && user.active_duration_unit === 'auto'
      ? '🤖 Auto (AI Optimal)'
      : user
      ? `${user.active_duration_value} ${user.active_duration_unit.toUpperCase()}`
      : 'Unknown';

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `⏱ *EXPIRATION TIME SETTINGS*\n\n` +
        `Current Setting: \`${currentText}\`\n\n` +
        `Select your preferred trade expiration. Selecting a specific duration locks execution strictly to that choice. Selecting Auto lets the production AI ensemble dynamically optimize expiration for maximum confidence.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🤖 Auto (AI Optimal)', callback_data: 'set_dur_0_auto' }],
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
        `🧠 *1️⃣ How does this bot work?*\n` +
        `The bot obtains live predictions from our production market microstructure pipeline, verifies the authoritative horizon alignment, and executes trade proposals when pre-trade criteria are fully met.\n\n` +
        `🔒 *2️⃣ How are my credentials stored?*\n` +
        `Your Deriv credentials are encrypted at rest with industry-standard cryptographic protection and are never displayed in plain text in your Telegram interface.\n\n` +
        `🔄 *3️⃣ Can I switch between Demo and Real accounts?*\n` +
        `Yes. Switch account modes using the \`🎮 Demo / Real\` toggle. The bot dynamically re-resolves and connects to your respective Demo or Real account with the broker.\n\n` +
        `🤖 *4️⃣ Auto vs. Manual Expiration: What's the difference?*\n` +
        `• \`Auto (AI Optimal)\`: The system evaluates the currently eligible, validated trading horizons and selects the horizon that best fits current market conditions and available model evidence.\n` +
        `• \`Manual Select\`: Overrides the AI selection and strictly locks your trade execution to your chosen duration (e.g., 5 Ticks or 60 Seconds).\n\n` +
        `💬 *5️⃣ How does the Live Support system work?*\n` +
        `When you click **Live Support** below and type your message, your inquiry is securely routed to our administrator support channel, allowing our team to reply to your ticket directly in this chat.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Live Support', callback_data: 'nav_support_contact' }],
          [{ text: '🏠 Back to Main Menu', callback_data: 'nav_main_menu' }]
        ]
      },
    };

    await this.safeSendApi(messageId ? 'editMessageText' : 'sendMessage', messageId ? { ...payload, message_id: messageId } : payload);
  }

  async renderSupportContactPrompt(chatId: number, messageId?: number) {
    await this.updateUser(chatId, { support_state: 'awaiting_message' });

    const payload = {
      chat_id: chatId,
      text:
        `💬 *LIVE SUPPORT CHANNEL*\n\n` +
        `Your message will be sent directly to our Administrator team for live routing and response.\n\n` +
        `📝 *How to proceed:*\n` +
        `Simply type your support question, details, or feedback below and press *Send*.\n\n` +
        `⚠️ _To cancel and return, please click the button below._`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Cancel & Back', callback_data: 'cancel_support' }]
        ]
      }
    };

    await this.safeSendApi(messageId ? 'editMessageText' : 'sendMessage', messageId ? { ...payload, message_id: messageId } : payload);
  }

  async handleCancelSupport(chatId: number, messageId?: number) {
    await this.updateUser(chatId, { support_state: 'idle' });
    await this.renderFaqScreen(chatId, messageId);
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

  async createSupportTicket(chatId: number, messageId: number, adminMessageId: number) {
    const sql = await this.getSql();
    if (!sql) return;
    await sql`
      INSERT INTO telegram_support_tickets (chat_id, message_id, admin_message_id)
      VALUES (${chatId}, ${messageId}, ${adminMessageId})
    `;
  }

  async sendMessage(chatId: number, text: string) {
    return this.safeSendApi('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    });
  }
}
