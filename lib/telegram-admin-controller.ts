import {
  getGlobalTradingCircuitBreakerConfig,
  updateGlobalTradingCircuitBreakerConfig,
  resumeGlobalTradingWithHealthCheck,
} from './ops-runtime-config';
import { getLiveRiseFallSymbols } from './rise-fall-symbols';
import { getValidMarketRankingSnapshot } from './market-ranking-cache';
import { getDbConnectionString, initDbSchema } from './db';
import { neon } from '@neondatabase/serverless';
import { generateDailyOperationsSummary } from './telegram-telemetry-alert-engine';

const ALERT_TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

export class TelegramAdminController {
  private getBotToken(): string {
    const token = process.env.ALERT_TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      throw new Error('ALERT_TELEGRAM_BOT_TOKEN_MISSING');
    }
    return token;
  }

  async sendApi(method: string, payload: Record<string, unknown>) {
    const token = this.getBotToken();
    const url = `${ALERT_TELEGRAM_API_BASE}${token}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({ ok: false, description: 'Non-JSON response' }));
    if (!res.ok || data.ok !== true) {
      console.error(`[Telegram Admin API Error] ${method}:`, data.description || 'Unknown error');
    }
    return data;
  }

  async renderHealthDashboard(chatId: number, messageId?: number, bannerNotice?: string) {
    let dbStatus = '🟢 Connected';
    try {
      await initDbSchema();
    } catch {
      dbStatus = '🔴 Disconnected';
    }

    let symbolsStatus = '0 symbols';
    let availableSymbolsCount = 0;
    try {
      const symbols = await getLiveRiseFallSymbols();
      availableSymbolsCount = symbols.filter((s) => s.isAvailable && s.isOpen).length;
      symbolsStatus = `${availableSymbolsCount}/${symbols.length} Active`;
    } catch {
      symbolsStatus = '⚠️ Discovery Failed';
    }

    let rankingAgeText = 'Stale / Unwarmed';
    try {
      const snapshot = await getValidMarketRankingSnapshot();
      if (snapshot) {
        const ageSec = Math.round((Date.now() - snapshot.tickTimestamp) / 1000);
        rankingAgeText = `Fresh (${ageSec}s ago, ${snapshot.rankings.length} assets)`;
      }
    } catch {
      rankingAgeText = '⚠️ Error reading snapshot';
    }

    const cbConfig = await getGlobalTradingCircuitBreakerConfig();
    const statusHeader = cbConfig.isHalted
      ? '🚨 *SYSTEM STATUS: HALTED (CIRCUIT BREAKER)*'
      : '🟢 *SYSTEM STATUS: OPERATIONAL*';

    const noticeHeader = bannerNotice ? `\n\n${bannerNotice}\n` : '';

    const text =
      `${statusHeader}${noticeHeader}\n\n` +
      `*Operational Health Control Plane*\n` +
      `• *Database:* ${dbStatus}\n` +
      `• *Volatility Symbols:* ${symbolsStatus}\n` +
      `• *ML Ranking Cache:* ${rankingAgeText}\n` +
      `• *Execution Circuit Breaker:* ${cbConfig.isHalted ? '🔴 HALTED' : '🟢 NORMAL'}\n` +
      (cbConfig.isHalted && cbConfig.haltReason ? `  └ _Reason:_ ${cbConfig.haltReason}\n` : '') +
      (cbConfig.haltedBy ? `  └ _Operator:_ \`${cbConfig.haltedBy}\`\n` : '') +
      (cbConfig.haltedAt ? `  └ _Time:_ ${new Date(cbConfig.haltedAt).toISOString()}\n` : '') +
      `\n_Last Refreshed: ${new Date().toISOString()}_`;

    const inlineKeyboard = [
      [
        { text: '📊 Refresh Health', callback_data: 'admin_health_status' },
        { text: '🤖 Model Status', callback_data: 'admin_models' },
      ],
      [
        { text: '📈 Daily Summary', callback_data: 'admin_summary' },
        { text: '📋 Telemetry Logs', callback_data: 'admin_logs' },
      ],
      [
        cbConfig.isHalted
          ? { text: '✅ Resume Automated Trading', callback_data: 'admin_resume_trading' }
          : { text: '🚨 Emergency Halt Trading', callback_data: 'admin_emergency_halt' },
      ],
    ];

    if (messageId) {
      await this.sendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } else {
      await this.sendApi('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    }
  }

  async renderModelsDashboard(chatId: number, messageId?: number) {
    const dbUrl = getDbConnectionString();
    let modelRows: Array<{ model_id: string; status: string; brier_score: number; win_rate: number }> = [];

    if (dbUrl) {
      try {
        const sql = neon(dbUrl);
        const rows = await sql`
          SELECT model_id, status, COALESCE(calibrated_brier_score, 0) as brier_score, COALESCE(walkforward_win_rate, 0) as win_rate
          FROM ml_model_registry_v2
          ORDER BY created_at DESC
          LIMIT 5
        `;
        modelRows = rows as typeof modelRows;
      } catch (err) {
        console.warn('[Telegram Admin Controller] Error reading model registry:', err);
      }
    }

    let modelListText = '_No registered models found in database._';
    if (modelRows.length > 0) {
      modelListText = modelRows
        .map(
          (m) =>
            `• \`${m.model_id.slice(0, 12)}...\` | *${m.status.toUpperCase()}*\n  └ Brier: \`${Number(m.brier_score).toFixed(4)}\` | Win Rate: \`${(Number(m.win_rate) * 100).toFixed(1)}%\``
        )
        .join('\n');
    }

    const text =
      `🤖 *ML MODEL REGISTRY & DRIFT STATUS*\n\n` +
      `${modelListText}\n\n` +
      `_Last Checked: ${new Date().toISOString()}_`;

    const inlineKeyboard = [
      [
        { text: '📊 System Health', callback_data: 'admin_health_status' },
        { text: '📋 Telemetry Logs', callback_data: 'admin_logs' },
      ],
    ];

    if (messageId) {
      await this.sendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } else {
      await this.sendApi('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    }
  }

  async renderLogsDashboard(chatId: number, messageId?: number) {
    const dbUrl = getDbConnectionString();
    let trades: Array<{
      execution_plan_id: string;
      symbol: string;
      handshake_latency_ms: number;
      buy_latency_ms: number;
      contract_id: string;
      created_at: string;
    }> = [];

    if (dbUrl) {
      try {
        const sql = neon(dbUrl);
        const rows = await sql`
          SELECT execution_plan_id, symbol, COALESCE(handshake_latency_ms, 0) as handshake_latency_ms, COALESCE(buy_latency_ms, 0) as buy_latency_ms, COALESCE(contract_id, 'N/A') as contract_id, created_at
          FROM execution_trades
          ORDER BY created_at DESC
          LIMIT 5
        `;
        trades = rows as typeof trades;
      } catch (err) {
        console.warn('[Telegram Admin Controller] Error reading execution trades:', err);
      }
    }

    let logsText = '_No recent trade executions logged._';
    if (trades.length > 0) {
      logsText = trades
        .map(
          (t) =>
            `• *${t.symbol}* | Contract: \`${t.contract_id}\`\n  └ Handshake: \`${t.handshake_latency_ms}ms\` | Buy: \`${t.buy_latency_ms}ms\`\n  └ Time: _${new Date(t.created_at).toISOString().slice(11, 19)} UTC_`
        )
        .join('\n');
    }

    const text =
      `📋 *EXECUTOR TELEMETRY & HANDSHAKE LOGS*\n\n` +
      `${logsText}\n\n` +
      `_Last Checked: ${new Date().toISOString()}_`;

    const inlineKeyboard = [
      [
        { text: '📊 System Health', callback_data: 'admin_health_status' },
        { text: '🤖 Model Status', callback_data: 'admin_models' },
      ],
    ];

    if (messageId) {
      await this.sendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } else {
      await this.sendApi('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    }
  }

  async renderDailySummaryDashboard(chatId: number, messageId?: number) {
    const dbUrl = getDbConnectionString();
    let summaryText = '_No data to generate summary._';

    if (dbUrl) {
      try {
        const sql = neon(dbUrl);
        summaryText = await generateDailyOperationsSummary(sql);
      } catch (err) {
        console.warn('[Telegram Admin Controller] Error generating summary:', err);
        summaryText = '⚠️ _Failed to query database for Operations Summary._';
      }
    }

    const inlineKeyboard = [
      [
        { text: '📊 System Health', callback_data: 'admin_health_status' },
        { text: '🤖 Model Status', callback_data: 'admin_models' },
      ],
    ];

    if (messageId) {
      await this.sendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: summaryText,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } else {
      await this.sendApi('sendMessage', {
        chat_id: chatId,
        text: summaryText,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    }
  }

  async handleEmergencyHalt(chatId: number, messageId: number, adminUserId: number) {
    await updateGlobalTradingCircuitBreakerConfig({
      isHalted: true,
      haltReason: `Emergency Halt issued by Telegram Admin ID ${adminUserId}`,
      updatedBy: `telegram_admin_${adminUserId}`,
    });

    await this.renderHealthDashboard(
      chatId,
      messageId,
      `🚨 *EMERGENCY HALT ACTIVATED BY ADMIN ${adminUserId}*\nAutomated trade execution is now strictly halted fail-closed.`
    );
  }

  async handleResumeTrading(chatId: number, messageId: number, adminUserId: number) {
    try {
      await resumeGlobalTradingWithHealthCheck({
        updatedBy: `telegram_admin_${adminUserId}`,
      });

      await this.renderHealthDashboard(
        chatId,
        messageId,
        `✅ *AUTOMATED TRADING RESUMED BY ADMIN ${adminUserId}*\nHealth gates passed. Automated trade execution enabled.`
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown health gate failure';
      await this.renderHealthDashboard(
        chatId,
        messageId,
        `⚠️ *RESUME REJECTED BY HEALTH GATES*\nFailed to resume trading:\n\`${errorMessage}\``
      );
    }
  }
}
