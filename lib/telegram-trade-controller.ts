import { DerivAuthenticatedClient } from './deriv-server-client';
import { fetchDerivTickHistory } from '@/lib/ticks-helper';
import { getLiveRiseFallSymbols, type RiseFallSymbolMetadata } from './rise-fall-symbols';
import { getValidMarketRankingSnapshot, refreshLiveMarketRankings, type LiveMarketRankingSnapshot } from './market-ranking-cache';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString } from './db';
import { getGlobalTradingCircuitBreakerConfig, getTelegramBrandingRuntimeConfig } from './ops-runtime-config';
import {
  claimTelegramTradeIntent,
  decryptSecret,
  ensureTelegramSchema,
  updateTelegramTradeIntent,
} from './telegram-db';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const VALID_STAKES = new Set([1, 5, 10, 25, 50]);

const KNOWN_SYMBOL_DISPLAY_NAMES: Record<string, string> = {
  '1HZ10V': 'Volatility 10 (1s) Index',
  '1HZ25V': 'Volatility 25 (1s) Index',
  '1HZ50V': 'Volatility 50 (1s) Index',
  '1HZ75V': 'Volatility 75 (1s) Index',
  '1HZ100V': 'Volatility 100 (1s) Index',
  '1HZ150V': 'Volatility 150 (1s) Index',
  '1HZ250V': 'Volatility 250 (1s) Index',
  '1HZ300V': 'Volatility 300 (1s) Index',
  'HZ10V': 'Volatility 10 (1s) Index',
  'HZ25V': 'Volatility 25 (1s) Index',
  'HZ50V': 'Volatility 50 (1s) Index',
  'HZ75V': 'Volatility 75 (1s) Index',
  'HZ100V': 'Volatility 100 (1s) Index',
  'R_10': 'Volatility 10 Index',
  'R_25': 'Volatility 25 Index',
  'R_50': 'Volatility 50 Index',
  'R_75': 'Volatility 75 Index',
  'R_100': 'Volatility 100 Index',
  'R_150': 'Volatility 150 Index',
  'R_250': 'Volatility 250 Index',
  'R_300': 'Volatility 300 Index',
  'STPRNG': 'Step Index',
  'JD10': 'Jump 10 Index',
  'JD25': 'Jump 25 Index',
  'JD50': 'Jump 50 Index',
  'JD75': 'Jump 75 Index',
  'JD100': 'Jump 100 Index',
  'frxEURUSD': 'EUR/USD',
  'frxGBPUSD': 'GBP/USD',
  'frxUSDJPY': 'USD/JPY',
  'frxAUDUSD': 'AUD/USD',
  'frxUSDCAD': 'USD/CAD',
  'frxUSDCHF': 'USD/CHF',
  'frxNZDUSD': 'NZD/USD',
  'frxXAUUSD': 'Gold/USD',
};

export function getSymbolDisplayName(symbol: string, fallbackName?: string): string {
  if (!symbol) return '';
  if (fallbackName && fallbackName !== symbol) {
    const cleaned = fallbackName.replace(/_/g, ' ');
    if (cleaned !== symbol && !/^[A-Z0-9_]+$/.test(cleaned)) {
      return cleaned;
    }
  }
  const upper = symbol.toUpperCase();
  const exact = KNOWN_SYMBOL_DISPLAY_NAMES[symbol] || KNOWN_SYMBOL_DISPLAY_NAMES[upper];
  if (exact) return exact;

  if (upper.startsWith('1HZ') && upper.endsWith('V')) {
    const num = upper.slice(3, -1);
    return `Volatility ${num} (1s) Index`;
  }
  if (upper.startsWith('R_')) {
    const num = upper.slice(2);
    return `Volatility ${num} Index`;
  }
  if (upper.startsWith('HZ') && upper.endsWith('V')) {
    const num = upper.slice(2, -1);
    return `Volatility ${num} (1s) Index`;
  }
  if (upper.startsWith('JD')) {
    const num = upper.slice(2);
    return `Jump ${num} Index`;
  }

  return symbol.replace(/_/g, ' ');
}

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
    const ALLOWED_CATEGORIES = new Set(['volatility_standard', 'volatility_1s', 'jump']);
    const eligible = discovered.filter(
      (item) => item.isAvailable && item.isOpen && item.isRiseFallSupported && item.categoryKeys.some((k) => ALLOWED_CATEGORIES.has(k))
    );
    if (eligible.length === 0) throw new Error('TELEGRAM_SYMBOL_UNIVERSE_EMPTY');
    return eligible;
  }

  async sendApi(method: string, payload: Record<string, any>): Promise<any> {
    if (!this.botToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

    if (payload && payload.parse_mode === 'Markdown') {
      if (typeof payload.text === 'string') {
        payload = {
          ...payload,
          text: markdownToHtml(payload.text),
          parse_mode: 'HTML',
        };
      } else if (typeof payload.caption === 'string') {
        payload = {
          ...payload,
          caption: markdownToHtml(payload.caption),
          parse_mode: 'HTML',
        };
      } else if (payload.media && typeof payload.media === 'object' && typeof payload.media.caption === 'string') {
        payload = {
          ...payload,
          media: {
            ...payload.media,
            caption: markdownToHtml(payload.media.caption),
            parse_mode: 'HTML',
          },
        };
      }
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

        const description = typeof data?.description === 'string' ? data.description : `HTTP ${res.status}`;

        // Graceful automatic recovery for Markdown entity parsing failures
        if (
          description.includes("can't parse entities") ||
          description.includes('parse entities') ||
          description.includes('entity starting at')
        ) {
          if (payload.parse_mode) {
            console.warn(`[Telegram API ${method}] Markdown parse failure: "${description}". Retrying without parse_mode...`);
            const fallbackPayload = { ...payload };
            delete fallbackPayload.parse_mode;
            if (fallbackPayload.media && typeof fallbackPayload.media === 'object') {
              fallbackPayload.media = { ...fallbackPayload.media };
              delete fallbackPayload.media.parse_mode;
            }
            return await this.sendApi(method, fallbackPayload);
          }
        }

        const retryable = res.status === 429 || res.status >= 500;
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

  public async safeSendApi(method: string, payload: Record<string, any>) {
    try {
      return await this.sendApi(method, payload);
    } catch (err) {
      console.error(`[TelegramBot Notification Failure ${method}]:`, err instanceof Error ? err.message : 'unknown');
      return null;
    }
  }

  /**
   * Unified Telegram screen renderer that enforces dynamic branding images, caption limits,
   * state transitions (editMessageMedia / editMessageText / editMessageCaption), and graceful
   * fail-safe fallbacks.
   */
  public async sendOrEditScreen(options: {
    chatId: number;
    messageId?: number;
    screenKey: string;
    text: string;
    parseMode?: 'Markdown' | 'HTML';
    replyMarkup?: any;
  }) {
    const { chatId, messageId, screenKey, text, parseMode = 'Markdown', replyMarkup } = options;

    let imageUrl: string | null = null;
    try {
      const branding = await getTelegramBrandingRuntimeConfig();
      if (branding) {
        const keyUpper = screenKey.toUpperCase();
        const candidateKeys = [
          screenKey,
          keyUpper,
          `TELEGRAM_${keyUpper}`,
          `TELEGRAM_${keyUpper}_IMAGE_URL`,
        ];

        // Specific alias fallbacks
        if (screenKey === 'main_menu') candidateKeys.push('TELEGRAM_MAIN_MENU_IMAGE_URL');
        else if (screenKey === 'signal_bullish') candidateKeys.push('TELEGRAM_BULLISH_IMAGE_URL', 'signal_card');
        else if (screenKey === 'signal_bearish') candidateKeys.push('TELEGRAM_BEARISH_IMAGE_URL', 'signal_card');
        else if (screenKey === 'trade_profit') candidateKeys.push('TELEGRAM_PROFIT_IMAGE_URL');
        else if (screenKey === 'trade_lost') candidateKeys.push('TELEGRAM_LOST_IMAGE_URL');
        else if (screenKey === 'settings_screen') candidateKeys.push('TELEGRAM_SETTINGS_IMAGE_URL');
        else if (screenKey === 'account_screen') candidateKeys.push('TELEGRAM_MY_ACCOUNT_IMAGE_URL');
        else if (screenKey === 'insufficient_balance') candidateKeys.push('TELEGRAM_INSUFFICIENT_BALANCE_IMAGE_URL');
        else if (screenKey === 'unlinked_screen' || screenKey === 'session_expired') candidateKeys.push('TELEGRAM_SESSION_EXPIRED_IMAGE_URL', 'unlinked_screen', 'session_expired');
        else if (screenKey === 'trade_execution_error') candidateKeys.push('TELEGRAM_TRADE_EXECUTION_ERROR_IMAGE_URL');
        else if (screenKey === 'faq_screen') candidateKeys.push('TELEGRAM_FAQ_IMAGE_URL');
        else if (screenKey === 'asset_select') candidateKeys.push('TELEGRAM_ASSET_SELECT_IMAGE_URL');
        else if (screenKey === 'trade_mode_select') candidateKeys.push('TELEGRAM_TRADE_MODE_SELECT_IMAGE_URL');
        else if (screenKey === 'ai_analyzing') candidateKeys.push('TELEGRAM_AI_ANALYZING_IMAGE_URL');

        for (const k of candidateKeys) {
          if (typeof branding[k] === 'string' && branding[k].trim().length > 0) {
            imageUrl = branding[k].trim();
            break;
          }
        }
      }
    } catch (err) {
      console.warn(`[TelegramBranding Resolution Error on screen ${screenKey}]:`, err instanceof Error ? err.message : 'unknown');
    }

    // Telegram photo caption length limit is strictly 1,024 characters.
    const canSendAsPhoto = Boolean(imageUrl && text.length <= 1024);

    if (!messageId) {
      // Fresh message (e.g., /start command or unlinked screen)
      if (canSendAsPhoto && imageUrl) {
        const photoRes = await this.safeSendApi('sendPhoto', {
          chat_id: chatId,
          photo: imageUrl,
          caption: text,
          parse_mode: parseMode,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        if (photoRes) return photoRes;
      }
      // Fallback or text-only fresh message
      return await this.safeSendApi('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    }

    // Editing an existing message (e.g. callback query)
    if (canSendAsPhoto && imageUrl) {
      try {
        return await this.sendApi('editMessageMedia', {
          chat_id: chatId,
          message_id: messageId,
          media: {
            type: 'photo',
            media: imageUrl,
            caption: text,
            parse_mode: parseMode,
          },
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      } catch (err: any) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[sendOrEditScreen editMessageMedia fallback on screen ${screenKey}]:`, errMsg);

        // Controlled fallback: Previous message was text-only or media mismatch occurred.
        // Delete previous message and send fresh photo message with reply markup.
        const deleted = await this.safeSendApi('deleteMessage', { chat_id: chatId, message_id: messageId });
        const photoSent = await this.safeSendApi('sendPhoto', {
          chat_id: chatId,
          photo: imageUrl,
          caption: text,
          parse_mode: parseMode,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });

        if (photoSent) return photoSent;

        // If photo send failed (e.g. URL unreachable), fall back to text message
        if (!deleted) {
          return await this.safeSendApi('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: parseMode,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          });
        } else {
          return await this.safeSendApi('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: parseMode,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          });
        }
      }
    }

    // Text-only screen or text length > 1024
    const captionScreens = new Set([
      'trade_progress',
      'trade_profit',
      'trade_lost',
      'manual_stake',
      'trade_error',
      'trade_execution_error',
      'insufficient_balance',
      'signal_bullish',
      'signal_bearish',
      'signal_error',
    ]);

    if (captionScreens.has(screenKey) && text.length <= 1024) {
      const captionRes = await this.safeSendApi('editMessageCaption', {
        chat_id: chatId,
        message_id: messageId,
        caption: text,
        parse_mode: parseMode,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      if (captionRes) return captionRes;
    }

    try {
      return await this.sendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: parseMode,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Ignore "message is not modified" gracefully
      if (errMsg.includes('message is not modified') || errMsg.includes('exactly the same')) {
        return null;
      }

      // If previous message was a photo message, editMessageText throws ("message to edit has no text")
      if (errMsg.includes('no text in the message to edit') || errMsg.includes('message to edit has no text')) {
        if (text.length <= 1024) {
          const captionRes = await this.safeSendApi('editMessageCaption', {
            chat_id: chatId,
            message_id: messageId,
            caption: text,
            parse_mode: parseMode,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          });
          if (captionRes) return captionRes;
        }

        // Controlled fallback if editMessageCaption fails or text > 1024: delete media message & send fresh text message
        await this.safeSendApi('deleteMessage', { chat_id: chatId, message_id: messageId });
        return await this.safeSendApi('sendMessage', {
          chat_id: chatId,
          text,
          parse_mode: parseMode,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      }

      console.warn(`[sendOrEditScreen editMessageText fallback on screen ${screenKey}]:`, errMsg);

      // Controlled fallback for any other error: delete previous message and send fresh message
      await this.safeSendApi('deleteMessage', { chat_id: chatId, message_id: messageId });
      return await this.safeSendApi('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
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

  async renderUnlinkedScreen(chatId: number, firstName?: string, messageId?: number) {
    const webUrl = process.env.APP_URL || 'https://deriv-trading.app';
    const escapedName = escapeMarkdown(firstName || 'Trader');
    const text =
      `👋 *Welcome ${escapedName} to Deriv AI Terminal*\n\n` +
      `Your intelligent microstructure trading terminal powered by the production signal pipeline.\n\n` +
      `⚠️ *No Account Connected*\nConnect your Deriv account from the Web App to begin.`;

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'unlinked_screen',
      text,
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: [
          [{ text: '📱 Connect via Web App', url: webUrl }],
          [{ text: '❓ How It Works & FAQ', callback_data: 'nav_faq' }],
        ],
      },
    });
  }

  async renderInsufficientBalanceScreen(
    chatId: number,
    messageId?: number,
    details?: {
      availableBalance?: number;
      requiredStake?: number;
      recoveryStep?: number;
      currency?: string;
    }
  ) {
    const currency = details?.currency || 'USD';
    const availStr = details?.availableBalance !== undefined
      ? `${details.availableBalance.toFixed(2)} ${currency}`
      : 'Unavailable';
    const reqStr = details?.requiredStake !== undefined
      ? `${details.requiredStake.toFixed(2)} ${currency}`
      : 'Unavailable';
    const stepStr = details?.recoveryStep !== undefined
      ? `Step ${details.recoveryStep}`
      : 'Step 1';

    const text =
      `⚠️ *INSUFFICIENT BALANCE*\n\n` +
      `Your available balance is not enough to place the next required stake for the current recovery step.\n\n` +
      `💵 *Available Balance:* \`${availStr}\`\n` +
      `🎯 *Required Stake:* \`${reqStr}\`\n` +
      `📊 *Recovery Step:* \`${stepStr}\`\n\n` +
      `_Your configured Martingale sequence remains preserved. Select an option below:_`;

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'insufficient_balance',
      text,
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: [
          [{ text: '💳 Deposit Funds', callback_data: 'menu_deposit' }],
          [{ text: '⚙️ Reset / Lower Stake', callback_data: 'set_stake_menu' }],
          [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'cashier_screen',
      text,
      parseMode: 'Markdown',
      replyMarkup: keyboard,
    });
  }

  async renderMainTerminal(chatId: number, messageId?: number) {
    const user = await this.getUser(chatId);
    if (!user) return this.renderUnlinkedScreen(chatId, undefined, messageId);

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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'main_menu',
      text,
      replyMarkup: keyboard,
    });

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
    if (!user) return this.renderUnlinkedScreen(chatId, undefined, messageId);

    const text = 
      `⚙️ *SELECT TRADING MODE*\n\n` +
      `How would you like to execute this trade?\n\n` +
      `🤖 *Automated Strategy Session*\n` +
      `Uses your preset configuration (Max Steps: \`${user.max_steps || 1}\`, Scaling: \`${Number(user.scaling_factor || 1.0).toFixed(2)}x\`). Automatically recovers losses via Martingale.\n\n` +
      `🎯 *Manual Single Trade*\n` +
      `Executes exactly one trade with your selected stake. No recovery steps.\n`;

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'trade_mode_select',
      text,
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: [
          [{ text: '🤖 Automated Strategy Session', callback_data: 'mode_auto_strategy' }],
          [{ text: '🎯 Manual Single Trade', callback_data: 'mode_single_trade' }],
          [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
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
        await this.sendOrEditScreen({
          chatId,
          messageId,
          screenKey: 'ai_analyzing',
          text,
          parseMode: 'Markdown',
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
        await this.sendOrEditScreen({
          chatId,
          messageId,
          screenKey: 'asset_select',
          text:
            `⚠️ *LIVE MARKET STREAM DEGRADED*\n\n` +
            `Unable to retrieve live AI model predictions from the signal engine. Per AGENTS.md safety rules, zero fallbacks or simulated values are permitted.\n\n` +
            `Please tap "🔄 Retry Scan" below to re-query the production signal pipeline.`,
          parseMode: 'Markdown',
          replyMarkup: {
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
      const cleanName = getSymbolDisplayName(res.symbol, res.name);
      leaderboardLines += `${medal} *${cleanName}*: Win rate = *${res.winRate}%*\n`;
      const btnIcon = index === 0 ? '🏆' : '📈';
      keyboardButtons.push([
        {
          text: `${btnIcon} ${cleanName}`,
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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'asset_select',
      text: finalMessageText,
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: keyboardButtons,
      },
    });
  }

  async handleManualStakePrompt(chatId: number, messageId: number, symbol: string) {
    await this.updateUser(chatId, { support_state: `awaiting_stake_${symbol}:${messageId}` });
    const displayName = getSymbolDisplayName(symbol);
    const text = `🔢 *MANUAL STAKE AMOUNT*\n\n` +
      `Please enter your custom stake amount in USD for *${displayName}* (e.g. \`15.50\`):\n\n` +
      `_Reply directly to this message with a number._`;

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'manual_stake',
      text,
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: [
          [{ text: '❌ Cancel', callback_data: `asset_${symbol}` }]
        ]
      }
    });
  }

  async renderSignalCard(chatId: number, messageId: number, symbol: string) {
    const user = await this.getUser(chatId);
    if (!user) return;
    await this.updateUser(chatId, { active_symbol: symbol, support_state: 'idle' });

    try {
      const signal = await this.requestLiveSignal(user, symbol);
      const directionText = signal.prediction.signal === 'CALL' ? '↗️ RISE / CALL' : '↘️ FALL / PUT';
      const probability = signal.prediction.confidence.toFixed(1);
      const horizon = signal.executionPlan.selectedHorizon;

      const displayName = getSymbolDisplayName(symbol);
      const text =
        `${signal.prediction.signal === 'CALL' ? '🟢' : '🔴'} *LIVE PRODUCTION AI SIGNAL*\n\n` +
        `🎯 *Asset:* \`${displayName}\`\n` +
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

      const signalScreenKey = signal.prediction.signal === 'CALL' ? 'signal_bullish' : 'signal_bearish';

      await this.sendOrEditScreen({
        chatId,
        messageId,
        screenKey: signalScreenKey,
        text,
        parseMode: 'Markdown',
        replyMarkup: keyboard,
      });
    } catch (err) {
      const code = err instanceof Error ? err.message : 'AI_SIGNAL_UNAVAILABLE';
      await this.sendOrEditScreen({
        chatId,
        messageId,
        screenKey: 'signal_error',
        text: `⚠️ *Live AI Signal Unavailable*\n\n\`${code}\`\n\nNo trade can be executed until an authoritative signal is available.`,
        parseMode: 'Markdown',
        replyMarkup: {
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
      await this.sendOrEditScreen({
        chatId,
        messageId,
        screenKey: 'trade_error',
        text: '❌ Invalid stake amount.',
        replyMarkup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }]] },
      });
      return;
    }

    if (!VALID_STAKES.has(normalizedStake) && normalizedStake !== Number(user.active_stake)) {
      await this.sendOrEditScreen({
        chatId,
        messageId,
        screenKey: 'trade_error',
        text: '❌ This stake is not an approved Telegram trading amount.',
        replyMarkup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }]] },
      });
      return;
    }

    const sql = await this.getSql();
    if (!sql) {
      await this.sendOrEditScreen({
        chatId,
        messageId,
        screenKey: 'trade_error',
        text: '❌ Database unavailable. Trade blocked.',
        replyMarkup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }]] },
      });
      return;
    }

    const claimed = await claimTelegramTradeIntent(sql, idempotencyKey, chatId);
    if (!claimed) {
      await this.sendOrEditScreen({
        chatId,
        messageId,
        screenKey: 'trade_error',
        text: 'ℹ️ This Telegram trade request was already processed or is still in progress.',
        replyMarkup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }]] },
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

    let initialSignal: LiveSignal;
    try {
      initialSignal = await this.requestLiveSignal(user, symbol);
    } catch (err) {
      const code = err instanceof Error ? err.message : 'AI_SIGNAL_UNAVAILABLE';
      await this.sendOrEditScreen({
        chatId,
        messageId,
        screenKey: 'trade_execution_error',
        text: `⚠️ *Live AI Signal Unavailable*\n\n\`${code}\`\n\nNo trade can be executed until an authoritative signal is available.`,
        parseMode: 'Markdown',
        replyMarkup: {
          inline_keyboard: [[{ text: '🔙 Back to Assets', callback_data: 'menu_start_trade' }]],
        },
      });
      return;
    }

    const dirLabel = initialSignal.prediction.signal === 'CALL' ? 'Buy ↗️' : 'Sell ↘️';
    const strategyName = user.autotrade_strategy
      ? user.autotrade_strategy.charAt(0).toUpperCase() + user.autotrade_strategy.slice(1)
      : 'Balanced';
    const displayName = getSymbolDisplayName(symbol);

    const sessionHeader =
      `🔹 *Selected asset:* \`${displayName}\`\n` +
      `🎯 *Direction:* *${dirLabel}*\n` +
      `💵 *Amount:* \`${normalizedStake.toFixed(2)} USD\`\n` +
      `⏱ *Timeframe:* \`${initialSignal.executionPlan.selectedHorizon.label}\`\n` +
      `⚖️ *Strategy:* \`${strategyName}\`\n\n` +
      `Trade session initialized...\n\n`;

    let sessionLedger = sessionHeader;
    let totalNetProfit = 0;
    let finalBalance: any = null;
    let anyTradeExecuted = false;
    let activeStep = 1;
    let activeStake = normalizedStake;

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'trade_progress',
      text: sessionLedger,
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: [
          [{ text: '⚡ Initializing Trade Session...', callback_data: 'noop' }]
        ]
      }
    });

    const client = new DerivAuthenticatedClient(token);
    try {
      const targetAccountId = await this.resolveTargetAccountId(client, user, chatId);
      await client.connect(targetAccountId);

      for (let tradeIdx = 1; tradeIdx <= maxTrades; tradeIdx++) {
        let currentStake = normalizedStake;

        for (let step = 1; step <= maxSteps; step++) {
          activeStep = step;
          activeStake = currentStake;

          // Check account balance before placing next required stake
          const liveBalanceObj = await client.getBalance().catch(() => null);
          const availBalance = liveBalanceObj ? Number(liveBalanceObj.balance) : null;

          if (availBalance !== null && availBalance < currentStake) {
            await updateTelegramTradeIntent(sql, idempotencyKey, 'failed');
            await this.renderInsufficientBalanceScreen(chatId, messageId, {
              availableBalance: availBalance,
              requiredStake: currentStake,
              recoveryStep: step,
              currency: user.currency || liveBalanceObj?.currency || 'USD',
            });
            return;
          }

          anyTradeExecuted = true;
          
          const pendingLine = `⚡ Trade ${tradeIdx} | Step ${step} | ${currentStake.toFixed(2)} USD -> Pending...`;
          await this.sendOrEditScreen({
            chatId,
            messageId,
            screenKey: 'trade_progress',
            text: sessionLedger + pendingLine,
            parseMode: 'Markdown',
            replyMarkup: {
              inline_keyboard: [
                [{ text: `⚡ Trade ${tradeIdx} | Step ${step} | ${currentStake.toFixed(2)} USD -> Pending...`, callback_data: 'noop' }]
              ]
            }
          });

          const signal = (step === 1 && tradeIdx === 1) ? initialSignal : await this.requestLiveSignal(user, symbol);
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

          const stepStatusBtn = settlement.is_won
            ? `🟢 Trade ${tradeIdx} | Step ${step} | ${currentStake.toFixed(2)} USD -> +$${profit.toFixed(2)} USD`
            : `🔴 Trade ${tradeIdx} | Step ${step} | ${currentStake.toFixed(2)} USD -> -$${Math.abs(profit).toFixed(2)} USD`;

          await this.sendOrEditScreen({
            chatId,
            messageId,
            screenKey: 'trade_progress',
            text: sessionLedger,
            parseMode: 'Markdown',
            replyMarkup: {
              inline_keyboard: [
                [{ text: stepStatusBtn, callback_data: 'noop' }]
              ]
            }
          });
          
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

        const sessionOutcomeKey = totalNetProfit > 0 ? 'trade_profit' : totalNetProfit < 0 ? 'trade_lost' : 'main_menu';

        await this.sendOrEditScreen({
          chatId,
          messageId,
          screenKey: sessionOutcomeKey,
          text: finalMessage,
          parseMode: 'Markdown',
          replyMarkup: {
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

      const isInsufficientBalance =
        rawError.includes('InsufficientBalance') ||
        rawError.toLowerCase().includes('insufficient balance') ||
        rawError.includes('INSUFFICIENT_BALANCE');

      if (isInsufficientBalance) {
        const latestBal = await client.getBalance().catch(() => null);
        await this.renderInsufficientBalanceScreen(chatId, messageId, {
          availableBalance: latestBal ? Number(latestBal.balance) : undefined,
          requiredStake: activeStake,
          recoveryStep: activeStep,
          currency: user.currency,
        });
        return;
      }

      const isSessionOrAuthError =
        rawError.includes('InvalidToken') ||
        rawError.includes('AuthorizationRequired') ||
        rawError.includes('SessionExpired') ||
        rawError.includes('UnlinkedAccount');

      if (isSessionOrAuthError) {
        await this.renderUnlinkedScreen(chatId, undefined, messageId);
        return;
      }

      const userMessage = formatBrokerExecutionError(err);
      const partialLedger = sessionLedger ? `${sessionLedger}\n` : '';

      await this.sendOrEditScreen({
        chatId,
        messageId,
        screenKey: 'trade_execution_error',
        text: `${partialLedger}⚠️ *TRADE EXECUTION ERROR*\n\n\`${userMessage}\``,
        parseMode: 'Markdown',
        replyMarkup: {
          inline_keyboard: [
            [{ text: '🔄 Retry Trade', callback_data: 'menu_start_trade' }],
            [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
          ],
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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'account_screen',
      text:
        `👤 *MY ACCOUNT*\n\n` +
        `🎮 *Trading Mode:* \`${user.account_type.toUpperCase()}\`\n` +
        `📧 *Login ID:* \`${user.account_id}\`\n` +
        `📬 *Email:* \`${emailStr}\`\n` +
        `💵 *Active Balance:* *${balanceStr}*\n` +
        `⚙️ *Risk Scaling:* \`${user.scaling_factor}x (Max ${user.max_steps} Steps)\``,
      parseMode: 'Markdown',
      replyMarkup: {
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
    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'cashier_screen',
      text:
        `💳 *DERIV CASHIER WITHDRAWAL*\n\n` +
        `To safely withdraw your balance and profits, access the official Deriv Cashier portal directly:\n\n` +
        `🔗 [Deriv Withdrawal Cashier Portal](https://app.deriv.com/cashier/withdrawal)`,
      parseMode: 'Markdown',
      replyMarkup: {
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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'settings_screen',
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
      parseMode: 'Markdown',
      replyMarkup: {
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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'settings_screen',
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
      parseMode: 'Markdown',
      replyMarkup: {
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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'settings',
      text:
        `⚙️ *Custom Settings*\n\n` +
        `📊 *Scaling factor:* \`${Number(user.scaling_factor).toFixed(2)}\`\n` +
        `🔄 *Max Steps:* \`${user.max_steps}\`\n` +
        `📈 *Max Trades:* \`${user.max_trades}\`\n\n` +
        `Set up your strategy:`,
      parseMode: 'Markdown',
      replyMarkup: {
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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'settings',
      text:
        `📊 *ADJUST SCALING FACTOR*\n` +
        `_Configure the multiplier applied to recovery trade sizes._\n\n` +
        `📊 *Current Scaling Factor:* \`${Number(user.scaling_factor).toFixed(2)}\``,
      parseMode: 'Markdown',
      replyMarkup: {
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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'settings',
      text:
        `🔄 *ADJUST MAX RECOVERY STEPS*\n` +
        `_Configure the maximum sequence steps for automated recovery._\n\n` +
        `🔄 *Current Max Steps:* \`${user.max_steps}\``,
      parseMode: 'Markdown',
      replyMarkup: {
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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'settings',
      text:
        `📈 *ADJUST MAX TRADES*\n` +
        `_Configure the maximum overall concurrent active trades allowed._\n\n` +
        `📈 *Current Max Trades:* \`${user.max_trades}\``,
      parseMode: 'Markdown',
      replyMarkup: {
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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'settings',
      text:
        `🌐 *LANGUAGE SETTINGS*\n` +
        `_Select your preferred interface language_\n\n` +
        `🌐 *Active Language:* \`${currentLang}\``,
      parseMode: 'Markdown',
      replyMarkup: {
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

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'settings',
      text:
        `⏱ *EXPIRATION TIME SETTINGS*\n\n` +
        `Current Setting: \`${currentText}\`\n\n` +
        `Select your preferred trade expiration. Selecting a specific duration locks execution strictly to that choice. Selecting Auto lets the production AI ensemble dynamically optimize expiration for maximum confidence.`,
      parseMode: 'Markdown',
      replyMarkup: {
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
    const text =
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
      `When you click **Live Support** below and type your message, your inquiry is securely routed to our administrator support channel, allowing our team to reply to your ticket directly in this chat.`;

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'faq_screen',
      text,
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: [
          [{ text: '💬 Live Support', callback_data: 'nav_support_contact' }],
          [{ text: '🏠 Back to Main Menu', callback_data: 'nav_main_menu' }]
        ]
      },
    });
  }

  async renderSupportContactPrompt(chatId: number, messageId?: number) {
    await this.updateUser(chatId, { support_state: 'awaiting_message' });

    const text =
      `💬 *LIVE SUPPORT CHANNEL*\n\n` +
      `Your message will be sent directly to our Administrator team for live routing and response.\n\n` +
      `📝 *How to proceed:*\n` +
      `Simply type your support question, details, or feedback below and press *Send*.\n\n` +
      `⚠️ _To cancel and return, please click the button below._`;

    await this.sendOrEditScreen({
      chatId,
      messageId,
      screenKey: 'support_screen',
      text,
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: [
          [{ text: '❌ Cancel & Back', callback_data: 'cancel_support' }]
        ]
      },
    });
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
