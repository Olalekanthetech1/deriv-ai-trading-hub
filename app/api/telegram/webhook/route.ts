import { NextRequest, NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { TelegramBotController, getSymbolDisplayName } from '@/lib/telegram-trade-controller';
import { claimTelegramUpdate, ensureTelegramSchema } from '@/lib/telegram-db';
import { getDbConnectionString } from '@/lib/db';
import { requireTelegramWebhookSecret } from '@/lib/telegram-security';

export async function POST(req: NextRequest) {
  try {
    requireTelegramWebhookSecret(req);

    const update = await req.json().catch(() => null);
    if (!update || typeof update !== 'object') {
      return NextResponse.json({ ok: false, error: 'Invalid Telegram update' }, { status: 400 });
    }

    const updateId = Number((update as { update_id?: unknown }).update_id);
    if (!Number.isSafeInteger(updateId) || updateId < 0) {
      return NextResponse.json({ ok: false, error: 'Telegram update_id is required' }, { status: 400 });
    }

    const dbUrl = getDbConnectionString();
    if (!dbUrl) {
      return NextResponse.json({ ok: false, error: 'Database not configured' }, { status: 503 });
    }

    const sql = neon(dbUrl);
    await ensureTelegramSchema(sql);
    const claimed = await claimTelegramUpdate(sql, updateId);
    if (!claimed) {
      return NextResponse.json({ ok: true, duplicate: true });
    }

    const bot = new TelegramBotController();

    if (update.message) {
      const msg = update.message;
      const chatId = Number(msg.chat?.id);
      if (!Number.isSafeInteger(chatId)) {
        return NextResponse.json({ ok: false, error: 'Invalid Telegram chat id' }, { status: 400 });
      }

      const text = String(msg.text || '').trim();
      const fromUser = msg.from || {};

      const user = await bot.getUser(chatId);

      if (user && user.support_state?.startsWith('awaiting_stake_')) {
        const rawState = user.support_state.replace('awaiting_stake_', '');
        const colonIdx = rawState.indexOf(':');
        const symbol = colonIdx > -1 ? rawState.slice(0, colonIdx) : rawState;
        const bannerMessageId = colonIdx > -1 ? Number(rawState.slice(colonIdx + 1)) : null;

        const amount = Number(text.replace(/[^0-9.]/g, ''));
        
        // Delete user's text message ("200") to keep chat clean
        await bot.safeSendApi('deleteMessage', { chat_id: chatId, message_id: msg.message_id });

        if (Number.isFinite(amount) && amount > 0) {
          await bot.updateUser(chatId, { support_state: 'idle', active_stake: amount });
          if (bannerMessageId && Number.isSafeInteger(bannerMessageId)) {
            await bot.executeTrade(chatId, bannerMessageId, symbol, amount, msg.message_id.toString());
          } else {
            const response = await bot.sendMessage(chatId, `⚙️ Initializing trade execution for ${getSymbolDisplayName(symbol)}...`);
            const botMessageId = response?.result?.message_id;
            if (botMessageId) {
              await bot.executeTrade(chatId, botMessageId, symbol, amount, msg.message_id.toString());
            }
          }
        } else {
          if (bannerMessageId && Number.isSafeInteger(bannerMessageId)) {
            await bot.handleManualStakePrompt(chatId, bannerMessageId, symbol);
          } else {
            await bot.sendMessage(chatId, `❌ Invalid amount.\n\nPlease enter a valid numerical amount for *${getSymbolDisplayName(symbol)}* (e.g. \`15.50\`), or type /start to cancel.`);
          }
        }
        return NextResponse.json({ ok: true });
      }

      if (user && user.support_state === 'awaiting_message') {
        const { TelegramAdminController } = await import('@/lib/telegram-admin-controller');
        const adminController = new TelegramAdminController();
        const adminMessageId = await adminController.forwardSupportTicketToAdmin(
          chatId,
          fromUser.username,
          fromUser.first_name,
          text,
          user.account_type
        );

        if (adminMessageId) {
          await bot.createSupportTicket(chatId, msg.message_id, adminMessageId);
        }

        await bot.updateUser(chatId, { support_state: 'idle' });
        await bot.sendMessage(chatId,
          `✅ *SUPPORT TICKET SUBMITTED*\n\n` +
          `Your message was successfully routed to our administrator support channel.\n\n` +
          `An administrator will review your request and reply directly in this chat shortly. Thank you!`
        );
        return NextResponse.json({ ok: true });
      }

      if (text.startsWith('/start pair_')) {
        const pairingCode = text.replace('/start pair_', '').trim();
        await bot.handlePairingCode(chatId, pairingCode, fromUser);
        return NextResponse.json({ ok: true });
      }

      if (text === '/start') {
        if (user) {
          await bot.renderMainTerminal(chatId);
        } else {
          await bot.renderUnlinkedScreen(chatId, fromUser.first_name);
        }
        return NextResponse.json({ ok: true });
      }

      if (text === '/menu' || text === '/dashboard' || text === '/trade') {
        await bot.renderMainTerminal(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '/faq' || text === '/help') {
        await bot.renderFaqScreen(chatId);
        return NextResponse.json({ ok: true });
      }

      await bot.renderMainTerminal(chatId);
      return NextResponse.json({ ok: true });
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = Number(cb.message?.chat?.id);
      const messageId = Number(cb.message?.message_id);
      const data = String(cb.data || '');

      if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId) || !cb.id) {
        return NextResponse.json({ ok: false, error: 'Invalid Telegram callback query' }, { status: 400 });
      }

      try {
        await bot.sendApi('answerCallbackQuery', { callback_query_id: cb.id });
      } catch (err) {
        console.warn('[Telegram Callback Ack Warning]:', err instanceof Error ? err.message : 'unknown');
      }

      if (data === 'noop') {
        return NextResponse.json({ ok: true });
      } else if (data === 'nav_main_menu') {
        await bot.renderMainTerminal(chatId, messageId);
      } else if (data === 'menu_start_trade') {
        await bot.renderTradeModeSelection(chatId, messageId);
      } else if (data === 'mode_single_trade') {
        await bot.updateUser(chatId, { is_autotrading: false });
        await bot.renderAssetSelection(chatId, messageId);
      } else if (data === 'mode_auto_strategy') {
        await bot.updateUser(chatId, { is_autotrading: true });
        await bot.renderAssetSelection(chatId, messageId);
      } else if (data.startsWith('asset_')) {
        await bot.renderSignalCard(chatId, messageId, data.replace('asset_', ''));
      } else if (data.startsWith('manual_stake_')) {
        await bot.handleManualStakePrompt(chatId, messageId, data.replace('manual_stake_', ''));
      } else if (data.startsWith('stake_') || data.startsWith('exec_')) {
        const prefixLength = data.startsWith('stake_') ? 'stake_'.length : 'exec_'.length;
        const raw = data.slice(prefixLength);
        const separator = raw.lastIndexOf('_');
        if (separator <= 0) {
          return NextResponse.json({ ok: false, error: 'Invalid trade callback' }, { status: 400 });
        }
        const symbol = raw.slice(0, separator);
        const stake = Number(raw.slice(separator + 1));
        await bot.executeTrade(chatId, messageId, symbol, stake, cb.id);
      } else if (data === 'menu_deposit') {
        await bot.renderDepositScreen(chatId, messageId);
      } else if (data === 'menu_withdrawal') {
        await bot.renderWithdrawalScreen(chatId, messageId);
      } else if (data === 'menu_account') {
        await bot.renderAccountScreen(chatId, messageId);
      } else if (data === 'menu_settings' || data === 'set_stake_menu') {
        await bot.renderSettingsScreen(chatId, messageId);
      } else if (data === 'set_autotrade_settings_menu') {
        await bot.renderAutotradeSettingsMenu(chatId, messageId);
      } else if (data === 'set_language_menu') {
        await bot.renderLanguageMenu(chatId, messageId);
      } else if (data === 'toggle_autotrade') {
        const user = await bot.getUser(chatId);
        if (user) {
          await bot.updateUser(chatId, { is_autotrading: !user.is_autotrading });
          await bot.renderSettingsScreen(chatId, messageId);
        }
      } else if (data === 'preset_strat_balanced') {
        await bot.updateUser(chatId, {
          autotrade_strategy: 'balanced',
          scaling_factor: 2.20,
          max_steps: 5,
          max_trades: 2,
        });
        await bot.renderAutotradeSettingsMenu(chatId, messageId);
      } else if (data === 'preset_strat_conservative') {
        await bot.updateUser(chatId, {
          autotrade_strategy: 'conservative',
          scaling_factor: 2.10,
          max_steps: 5,
          max_trades: 1,
        });
        await bot.renderAutotradeSettingsMenu(chatId, messageId);
      } else if (data === 'preset_strat_profit') {
        await bot.updateUser(chatId, {
          autotrade_strategy: 'profit',
          scaling_factor: 2.30,
          max_steps: 10,
          max_trades: 3,
        });
        await bot.renderAutotradeSettingsMenu(chatId, messageId);
      } else if (data === 'set_custom_settings_menu') {
        await bot.renderCustomSettingsMenu(chatId, messageId);
      } else if (data === 'adjust_scale_menu') {
        await bot.renderScalingFactorAdjuster(chatId, messageId);
      } else if (data === 'adjust_steps_menu') {
        await bot.renderMaxStepsAdjuster(chatId, messageId);
      } else if (data === 'adjust_trades_menu') {
        await bot.renderMaxTradesAdjuster(chatId, messageId);
      } else if (data === 'custom_scale_up' || data === 'custom_scale_down') {
        const user = await bot.getUser(chatId);
        if (user) {
          let currentScale = Number(user.scaling_factor);
          if (data === 'custom_scale_up') currentScale = Math.min(5.00, currentScale + 0.10);
          else currentScale = Math.max(1.00, currentScale - 0.10);
          await bot.updateUser(chatId, {
            autotrade_strategy: 'custom',
            scaling_factor: Number(currentScale.toFixed(2)),
          });
          await bot.renderScalingFactorAdjuster(chatId, messageId);
        }
      } else if (data === 'custom_steps_up' || data === 'custom_steps_down') {
        const user = await bot.getUser(chatId);
        if (user) {
          let currentSteps = Number(user.max_steps);
          if (data === 'custom_steps_up') currentSteps = Math.min(15, currentSteps + 1);
          else currentSteps = Math.max(1, currentSteps - 1);
          await bot.updateUser(chatId, {
            autotrade_strategy: 'custom',
            max_steps: currentSteps,
          });
          await bot.renderMaxStepsAdjuster(chatId, messageId);
        }
      } else if (data === 'custom_trades_up' || data === 'custom_trades_down') {
        const user = await bot.getUser(chatId);
        if (user) {
          let currentTrades = Number(user.max_trades);
          if (data === 'custom_trades_up') currentTrades = Math.min(5, currentTrades + 1);
          else currentTrades = Math.max(1, currentTrades - 1);
          await bot.updateUser(chatId, {
            autotrade_strategy: 'custom',
            max_trades: currentTrades,
          });
          await bot.renderMaxTradesAdjuster(chatId, messageId);
        }
      } else if (data.startsWith('set_lang_')) {
        const lang = data.replace('set_lang_', '');
        await bot.updateUser(chatId, { language: lang });
        await bot.renderLanguageMenu(chatId, messageId);
      } else if (data === 'set_duration_menu') {
        await bot.renderDurationMenu(chatId, messageId);
      } else if (data.startsWith('set_dur_')) {
        const parts = data.split('_');
        const val = Number(parts[2]);
        const unit = parts[3];
        await bot.updateUser(chatId, { active_duration_value: val, active_duration_unit: unit });
        await bot.renderSettingsScreen(chatId, messageId);
      } else if (data === 'action_switch_demo_real') {
        const user = await bot.getUser(chatId);
        if (user) {
          const newType = user.account_type === 'demo' ? 'real' : 'demo';
          await bot.updateUser(chatId, { account_type: newType });
          await bot.renderMainTerminal(chatId, messageId);
        }
      } else if (data === 'action_logout') {
        await bot.unlinkUser(chatId);
        await bot.renderUnlinkedScreen(chatId);
      } else if (data === 'nav_faq') {
        await bot.renderFaqScreen(chatId, messageId);
      } else if (data === 'nav_support_contact') {
        await bot.renderSupportContactPrompt(chatId, messageId);
      } else if (data === 'cancel_support') {
        await bot.handleCancelSupport(chatId, messageId);
      }

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Telegram webhook processing failed';
    console.error('[Telegram Webhook Error]:', message);

    if (message === 'TELEGRAM_WEBHOOK_UNAUTHORIZED') {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Updates are claimed before processing. Do not return 5xx after a claimed
    // trading update, otherwise Telegram would redeliver the same update.
    return NextResponse.json({ ok: false, error: 'Telegram update processing failed' });
  }
}
