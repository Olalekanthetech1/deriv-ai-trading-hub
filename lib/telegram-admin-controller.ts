import {
  getGlobalTradingCircuitBreakerConfig,
  updateGlobalTradingCircuitBreakerConfig,
  resumeGlobalTradingWithHealthCheck,
  getTelegramAssetGovernanceConfig,
  updateTelegramAssetGovernanceConfig,
  isSymbolApprovedForTelegram,
} from './ops-runtime-config';
import { getLiveRiseFallSymbols, type RiseFallSymbolMetadata } from './rise-fall-symbols';
import { getValidMarketRankingSnapshot, refreshLiveMarketRankings, clearMarketRankingCache } from './market-ranking-cache';
import { getDbConnectionString, initDbSchema } from './db';
import { neon } from '@neondatabase/serverless';
import { generateDailyOperationsSummary } from './telegram-telemetry-alert-engine';

const ALERT_TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

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

export class TelegramAdminController {
  private getBotToken(): string {
    const token = process.env.ALERT_TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      throw new Error('ALERT_TELEGRAM_BOT_TOKEN_MISSING');
    }
    return token;
  }

  async sendApi(method: string, payload: Record<string, unknown>) {
    if (payload && payload.parse_mode === 'Markdown' && typeof payload.text === 'string') {
      payload = {
        ...payload,
        text: markdownToHtml(payload.text),
        parse_mode: 'HTML',
      };
    }

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
        { text: '🔍 Scan Top Profitable Assets', callback_data: 'admin_scan_profitable' },
      ],
      [
        { text: '🌐 Asset Governance & Whitelist', callback_data: 'admin_asset_tab:all' },
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
          SELECT 
            model_id, 
            status, 
            COALESCE((metrics->>'calibrated_brier_score')::numeric, 0) as brier_score, 
            COALESCE((metrics->>'walkforward_win_rate')::numeric, 0) as win_rate
          FROM ml_model_registry_v2
          ORDER BY updated_at DESC
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
          SELECT 
            execution_plan_id, 
            asset_symbol as symbol, 
            COALESCE((metadata->>'handshake_latency_ms')::numeric, 0) as handshake_latency_ms, 
            COALESCE((metadata->>'buy_latency_ms')::numeric, 0) as buy_latency_ms, 
            COALESCE(metadata->>'contract_id', 'N/A') as contract_id, 
            executed_at as created_at
          FROM execution_trades
          ORDER BY executed_at DESC
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

  async forwardSupportTicketToAdmin(
    traderChatId: number,
    traderUsername: string | undefined,
    traderFirstName: string | undefined,
    text: string,
    accountType: string
  ): Promise<number | null> {
    const alertChatId = process.env.ALERT_TELEGRAM_CHAT_ID?.trim();
    if (!alertChatId) {
      console.warn('[Admin Alert Bot] ALERT_TELEGRAM_CHAT_ID is not configured, cannot route support ticket');
      return null;
    }

    const nameStr = traderFirstName ? `${traderFirstName}` : 'Anonymous';
    const usernameStr = traderUsername ? ` (@${traderUsername})` : '';

    const payloadText =
      `🎫 *NEW SUPPORT TICKET*\n\n` +
      `👤 *Trader:* ${nameStr}${usernameStr}\n` +
      `🆔 *Trader ID:* \`${traderChatId}\`\n` +
      `🎮 *Account:* \`${accountType.toUpperCase()}\`\n\n` +
      `💬 *Message:*\n"${text}"\n\n` +
      `✍️ _To reply, simply use Telegram's reply-to function directly on this message._`;

    const res = await this.sendApi('sendMessage', {
      chat_id: alertChatId,
      text: payloadText,
      parse_mode: 'Markdown',
    });

    if (res && res.ok && res.result && res.result.message_id) {
      return Number(res.result.message_id);
    }
    return null;
  }

  async renderAssetScanner(
    chatId: number,
    messageId?: number,
    activeTab: 'all' | 'volatility_1s' | 'volatility_standard' | 'jump' = 'all',
    bannerNotice?: string
  ) {
    const gov = await getTelegramAssetGovernanceConfig(true);
    let allSymbols: RiseFallSymbolMetadata[] = [];
    try {
      allSymbols = await getLiveRiseFallSymbols(true, false);
    } catch (err) {
      console.warn('[Telegram Admin Controller] Error discovering symbols for scanner:', err);
    }

    const targetSymbols = allSymbols.filter((s) => {
      const keys = s.categoryKeys || [];
      const sym = s.symbol.toUpperCase();
      return (
        keys.includes('volatility') ||
        keys.includes('volatility_1s') ||
        keys.includes('volatility_standard') ||
        keys.includes('jump') ||
        sym.startsWith('R_') ||
        sym.startsWith('1HZ') ||
        sym.startsWith('JD')
      );
    });

    const vol1sList = targetSymbols.filter(s => s.categoryKeys.includes('volatility_1s') || s.symbol.toUpperCase().startsWith('1HZ'));
    const volStdList = targetSymbols.filter(s => s.categoryKeys.includes('volatility_standard') || s.symbol.toUpperCase().startsWith('R_'));
    const jumpList = targetSymbols.filter(s => s.categoryKeys.includes('jump') || s.symbol.toUpperCase().startsWith('JD'));

    const vol1sApprovedCount = vol1sList.filter(s => isSymbolApprovedForTelegram(s.symbol, s.categoryKeys, gov)).length;
    const volStdApprovedCount = volStdList.filter(s => isSymbolApprovedForTelegram(s.symbol, s.categoryKeys, gov)).length;
    const jumpApprovedCount = jumpList.filter(s => isSymbolApprovedForTelegram(s.symbol, s.categoryKeys, gov)).length;

    let displayList = targetSymbols;
    if (activeTab === 'volatility_1s') displayList = vol1sList;
    if (activeTab === 'volatility_standard') displayList = volStdList;
    if (activeTab === 'jump') displayList = jumpList;

    const noticeHeader = bannerNotice ? `\n\n${bannerNotice}\n` : '';

    let itemsText = '';
    displayList.forEach((item) => {
      const approved = isSymbolApprovedForTelegram(item.symbol, item.categoryKeys, gov);
      const icon = item.symbol.toUpperCase().startsWith('JD') ? '🚀' : item.symbol.toUpperCase().startsWith('1HZ') ? '⚡' : '📊';
      const statusStr = approved ? '🟢 APPROVED' : '🔴 DISABLED';
      const openStr = item.isOpen ? 'OPEN' : 'CLOSED';
      itemsText += `• ${icon} *${item.symbol}* (${item.displayName}): ${statusStr} | _${openStr}_\n`;
    });

    if (!itemsText) itemsText = '_No symbols found in this category._';

    const tabTitle = activeTab === 'all' ? 'ALL ASSETS' : activeTab === 'volatility_1s' ? 'VOLATILITY 1S' : activeTab === 'volatility_standard' ? 'STANDARD VOLATILITY' : 'JUMP INDICES';

    const text =
      `🌐 *ASSET UNIVERSE & LIVE SCANNER*${noticeHeader}\n\n` +
      `*Category Controls & Status:*\n` +
      `• ⚡ *Vol 1s:* ${gov.enabledCategories.volatility_1s ? '🟢 ENABLED' : '🔴 DISABLED'} (${vol1sApprovedCount}/${vol1sList.length} active)\n` +
      `• 📊 *Vol Standard:* ${gov.enabledCategories.volatility_standard ? '🟢 ENABLED' : '🔴 DISABLED'} (${volStdApprovedCount}/${volStdList.length} active)\n` +
      `• 🚀 *Jump Indices:* ${gov.enabledCategories.jump ? '🟢 ENABLED' : '🔴 DISABLED'} (${jumpApprovedCount}/${jumpList.length} active)\n\n` +
      `*View Category: ${tabTitle} (${displayList.length} Symbols)*\n` +
      `${itemsText}\n\n` +
      `_Tap category toggles or symbol buttons below to update active whitelist in real-time._`;

    const inlineKeyboard: { text: string; callback_data: string }[][] = [
      [
        { text: `${activeTab === 'volatility_1s' ? '▶️ ⚡ Vol 1s' : '⚡ Vol 1s'}`, callback_data: 'admin_asset_tab:volatility_1s' },
        { text: `${activeTab === 'volatility_standard' ? '▶️ 📊 Standard' : '📊 Standard'}`, callback_data: 'admin_asset_tab:volatility_standard' },
        { text: `${activeTab === 'jump' ? '▶️ 🚀 Jump' : '🚀 Jump'}`, callback_data: 'admin_asset_tab:jump' },
        { text: `${activeTab === 'all' ? '▶️ 🌐 All' : '🌐 All'}`, callback_data: 'admin_asset_tab:all' },
      ],
      [
        { text: `${gov.enabledCategories.volatility_1s ? '🔴 Disable Vol 1s' : '🟢 Enable Vol 1s'}`, callback_data: `admin_asset_toggle_cat:volatility_1s:${activeTab}` },
        { text: `${gov.enabledCategories.volatility_standard ? '🔴 Disable Standard' : '🟢 Enable Standard'}`, callback_data: `admin_asset_toggle_cat:volatility_standard:${activeTab}` },
      ],
      [
        { text: `${gov.enabledCategories.jump ? '🔴 Disable Jump Indices' : '🟢 Enable Jump Indices'}`, callback_data: `admin_asset_toggle_cat:jump:${activeTab}` },
      ],
    ];

    const assetToggleRow: { text: string; callback_data: string }[] = [];
    displayList.slice(0, 9).forEach((item) => {
      const approved = isSymbolApprovedForTelegram(item.symbol, item.categoryKeys, gov);
      assetToggleRow.push({
        text: `${approved ? '🔴' : '🟢'} ${item.symbol}`,
        callback_data: `admin_asset_toggle_sym:${item.symbol}:${activeTab}`,
      });
    });

    for (let i = 0; i < assetToggleRow.length; i += 3) {
      inlineKeyboard.push(assetToggleRow.slice(i, i + 3));
    }

    inlineKeyboard.push([
      { text: '📊 Health Dashboard', callback_data: 'admin_health_status' },
      { text: '🤖 Model Status', callback_data: 'admin_models' },
    ]);

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

  async handleToggleCategory(
    chatId: number,
    messageId: number,
    category: 'volatility_1s' | 'volatility_standard' | 'jump',
    activeTab: 'all' | 'volatility_1s' | 'volatility_standard' | 'jump',
    adminUserId: number
  ) {
    const currentGov = await getTelegramAssetGovernanceConfig(true);
    const nextVal = !currentGov.enabledCategories[category];

    await updateTelegramAssetGovernanceConfig({
      enabledCategories: { [category]: nextVal },
      updatedBy: `telegram_admin_${adminUserId}`,
    });

    const categoryName = category === 'volatility_1s' ? 'Volatility 1s' : category === 'volatility_standard' ? 'Standard Volatility' : 'Jump Indices';
    const statusMsg = nextVal ? `🟢 Enabled category *${categoryName}*` : `🔴 Disabled category *${categoryName}*`;

    await this.renderAssetScanner(
      chatId,
      messageId,
      activeTab,
      `✅ *ASSET GOVERNANCE UPDATED*\n${statusMsg} for Telegram traders.`
    );
  }

  async handleToggleSymbol(
    chatId: number,
    messageId: number,
    symbol: string,
    activeTab: 'all' | 'volatility_1s' | 'volatility_standard' | 'jump',
    adminUserId: number
  ) {
    const upperSym = symbol.toUpperCase();
    const currentGov = await getTelegramAssetGovernanceConfig(true);
    let nextDisabled = [...currentGov.disabledSymbols];

    if (nextDisabled.includes(upperSym)) {
      nextDisabled = nextDisabled.filter((s) => s !== upperSym);
    } else {
      nextDisabled.push(upperSym);
    }

    await updateTelegramAssetGovernanceConfig({
      disabledSymbols: nextDisabled,
      updatedBy: `telegram_admin_${adminUserId}`,
    });
    await clearMarketRankingCache();

    const isNowDisabled = nextDisabled.includes(upperSym);
    const statusMsg = isNowDisabled ? `🔴 Disabled symbol *${upperSym}*` : `🟢 Approved symbol *${upperSym}*`;

    await this.renderAssetScanner(
      chatId,
      messageId,
      activeTab,
      `✅ *SYMBOL WHITELIST UPDATED*\n${statusMsg} for Telegram traders.`
    );
  }

  async renderProfitableAssetScanner(chatId: number, messageId?: number, bannerNotice?: string) {
    const gov = await getTelegramAssetGovernanceConfig(true);
    const noticeHeader = bannerNotice ? `\n\n${bannerNotice}\n` : '';

    let snapshot = null;
    try {
      snapshot = await refreshLiveMarketRankings();
    } catch (err) {
      console.warn('[Telegram Admin Controller] Error scanning top profitable assets:', err);
    }

    if (!snapshot || snapshot.rankings.length === 0) {
      const failText = `⚠️ *PROFITABLE ASSET SCANNER DEGRADED*${noticeHeader}\n\nUnable to retrieve live AI predictions for top assets right now. Please verify Deriv API connectivity.`;
      const keyboard = [
        [{ text: '🔄 Re-Scan Market', callback_data: 'admin_scan_profitable' }],
        [{ text: '📊 Health Dashboard', callback_data: 'admin_health_status' }],
      ];
      if (messageId) {
        await this.sendApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: failText,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard },
        });
      } else {
        await this.sendApi('sendMessage', {
          chat_id: chatId,
          text: failText,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard },
        });
      }
      return;
    }

    let reportLines = '';
    const toggleButtons: { text: string; callback_data: string }[] = [];

    snapshot.rankings.forEach((res, index) => {
      const isApproved = isSymbolApprovedForTelegram(res.symbol, [], gov);
      const icon = res.symbol.toUpperCase().startsWith('JD') ? '🚀' : res.symbol.toUpperCase().startsWith('1HZ') ? '⚡' : '📊';
      const medal = index === 0 ? '🏆' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🔹';
      const statusText = isApproved ? '🟢 APPROVED' : '🔴 DISABLED';

      reportLines += `${medal} ${icon} *${res.symbol}* (${res.name}): Win Rate = *${res.winRate}%* (${res.signal}) | ${statusText}\n`;

      toggleButtons.push({
        text: `${isApproved ? '🔴 Disable' : '🟢 Approve'} ${res.symbol}`,
        callback_data: `admin_prof_toggle:${res.symbol}`,
      });
    });

    const text =
      `🔍 *TOP PROFITABLE ASSET AI SCANNER*${noticeHeader}\n\n` +
      `_Scanned ${snapshot.candidateCount} assets across Volatility 1s, Standard Volatility, and Jump Indices._\n\n` +
      `*Ranked Highest Win-Rate Assets Right Now:*\n` +
      `${reportLines}\n` +
      `_Tap any button below to instantly approve or disable that asset for Telegram traders._`;

    const inlineKeyboard: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < toggleButtons.length; i += 2) {
      inlineKeyboard.push(toggleButtons.slice(i, i + 2));
    }

    inlineKeyboard.push([
      { text: '🔄 Re-Scan Market', callback_data: 'admin_scan_profitable' },
      { text: '🌐 Asset Whitelist & Governance', callback_data: 'admin_asset_tab:all' },
    ]);
    inlineKeyboard.push([
      { text: '📊 Health Dashboard', callback_data: 'admin_health_status' },
    ]);

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

  async handleToggleProfitableSymbol(chatId: number, messageId: number, symbol: string, adminUserId: number) {
    const upperSym = symbol.toUpperCase();
    const currentGov = await getTelegramAssetGovernanceConfig(true);
    let nextDisabled = [...currentGov.disabledSymbols];

    if (nextDisabled.includes(upperSym)) {
      nextDisabled = nextDisabled.filter((s) => s !== upperSym);
    } else {
      nextDisabled.push(upperSym);
    }

    await updateTelegramAssetGovernanceConfig({
      disabledSymbols: nextDisabled,
      updatedBy: `telegram_admin_${adminUserId}`,
    });
    await clearMarketRankingCache();

    const isNowDisabled = nextDisabled.includes(upperSym);
    const statusMsg = isNowDisabled ? `🔴 Disabled symbol *${upperSym}*` : `🟢 Approved symbol *${upperSym}*`;

    await this.renderProfitableAssetScanner(
      chatId,
      messageId,
      `✅ *ASSET STATUS UPDATED*\n${statusMsg} for Telegram traders.`
    );
  }
}
