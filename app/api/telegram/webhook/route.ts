import { NextRequest, NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { TelegramBotController } from '@/lib/telegram-trade-controller';
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

      if (text.startsWith('/start pair_')) {
        const pairingCode = text.replace('/start pair_', '').trim();
        await bot.handlePairingCode(chatId, pairingCode, fromUser);
        return NextResponse.json({ ok: true });
      }

      if (text === '/start') {
        const user = await bot.getUser(chatId);
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

      if (data === 'nav_main_menu') {
        await bot.renderMainTerminal(chatId, messageId);
      } else if (data === 'menu_start_trade') {
        await bot.renderAssetSelection(chatId, messageId);
      } else if (data.startsWith('asset_')) {
        await bot.renderSignalCard(chatId, messageId, data.replace('asset_', ''));
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
      } else if (data === 'menu_settings') {
        await bot.renderSettingsScreen(chatId, messageId);
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
