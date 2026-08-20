import { NextRequest, NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { TelegramAdminController } from '@/lib/telegram-admin-controller';
import { claimTelegramUpdate, ensureTelegramSchema } from '@/lib/telegram-db';
import { getDbConnectionString } from '@/lib/db';
import {
  requireTelegramWebhookSecret,
  verifyTelegramAdminAuthorization,
} from '@/lib/telegram-security';

export async function POST(req: NextRequest) {
  try {
    requireTelegramWebhookSecret(req);

    const update = await req.json().catch(() => null);
    if (!update || typeof update !== 'object') {
      return NextResponse.json({ ok: false, error: 'Invalid update payload' }, { status: 400 });
    }

    const updateId = Number((update as { update_id?: unknown }).update_id);
    if (!Number.isSafeInteger(updateId) || updateId < 0) {
      return NextResponse.json({ ok: false, error: 'Update_id is required' }, { status: 400 });
    }

    const dbUrl = getDbConnectionString();
    if (!dbUrl) {
      return NextResponse.json({ ok: false, error: 'Database unavailable' }, { status: 503 });
    }

    const sql = neon(dbUrl);
    await ensureTelegramSchema(sql);
    const claimed = await claimTelegramUpdate(sql, updateId);
    if (!claimed) {
      return NextResponse.json({ ok: true, duplicate: true });
    }

    let chatId: number | null = null;
    let userId: number | null = null;
    let messageId: number | null = null;
    let callbackQueryId: string | null = null;
    let text = '';
    let callbackData = '';

    if (update.message) {
      chatId = Number(update.message.chat?.id);
      userId = Number(update.message.from?.id);
      text = String(update.message.text || '').trim();
    } else if (update.callback_query) {
      chatId = Number(update.callback_query.message?.chat?.id);
      userId = Number(update.callback_query.from?.id);
      messageId = Number(update.callback_query.message?.message_id);
      callbackQueryId = String(update.callback_query.id || '');
      callbackData = String(update.callback_query.data || '');
    }

    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(userId)) {
      return NextResponse.json({ ok: true, ignored: true });
    }

    const auth = verifyTelegramAdminAuthorization({ chatId: chatId!, userId: userId! });

    if (!auth.authorized) {
      try {
        await sql`
          INSERT INTO ops_audit_events (
            category, severity, actor, action, resource_type, resource_id, metadata
          ) VALUES (
            'security',
            'warning',
            ${String(userId)},
            'unauthorized_telegram_admin_attempt',
            'telegram_control_plane',
            ${String(chatId)},
            ${JSON.stringify({ reason: auth.reason, callbackData, text })}::jsonb
          )
        `;
      } catch (auditErr) {
        console.warn('[Telegram Alert Webhook] Failed to log unauthorized access audit event:', auditErr);
      }

      const controller = new TelegramAdminController();
      if (callbackQueryId) {
        await controller.sendApi('answerCallbackQuery', {
          callback_query_id: callbackQueryId,
          text: '⛔ Unauthorized: Access denied.',
          show_alert: true,
        });
      } else if (chatId) {
        let msg = `⛔ *UNAUTHORIZED OPERATIONAL ACCESS*\n\nYour Telegram User ID \`${userId}\` is not authorized to access system administration controls.`;
        if (auth.reason === 'ALERT_TELEGRAM_ADMIN_USER_IDS_UNCONFIGURED') {
          msg += `\n\n*Reason:* \`ALERT_TELEGRAM_ADMIN_USER_IDS\` is not configured in your environment variables.`;
        } else {
          msg += `\n\n*Action:* Add your Telegram User ID \`${userId}\` to the \`ALERT_TELEGRAM_ADMIN_USER_IDS\` comma-separated environment variable list on Render to authorize it.`;
        }
        await controller.sendApi('sendMessage', {
          chat_id: chatId,
          text: msg,
          parse_mode: 'Markdown',
        });
      }

      return NextResponse.json({ ok: true, authorized: false });
    }

    const controller = new TelegramAdminController();

    if (callbackQueryId) {
      try {
        await controller.sendApi('answerCallbackQuery', { callback_query_id: callbackQueryId });
      } catch (err) {
        console.warn('[Telegram Admin Callback Ack Warning]:', err instanceof Error ? err.message : 'unknown');
      }
    }

    if (callbackData) {
      if (callbackData === 'admin_health_status') {
        await controller.renderHealthDashboard(chatId!, messageId || undefined);
      } else if (callbackData === 'admin_models') {
        await controller.renderModelsDashboard(chatId!, messageId || undefined);
      } else if (callbackData === 'admin_summary') {
        await controller.renderDailySummaryDashboard(chatId!, messageId || undefined);
      } else if (callbackData === 'admin_logs') {
        await controller.renderLogsDashboard(chatId!, messageId || undefined);
      } else if (callbackData === 'admin_emergency_halt') {
        await controller.handleEmergencyHalt(chatId!, messageId!, userId!);
      } else if (callbackData === 'admin_resume_trading') {
        await controller.handleResumeTrading(chatId!, messageId!, userId!);
      }
      return NextResponse.json({ ok: true });
    }

    if (update.message && update.message.reply_to_message) {
      const replyToMsgId = Number(update.message.reply_to_message.message_id);
      const tickets = await sql`
        SELECT * FROM telegram_support_tickets
        WHERE admin_message_id = ${replyToMsgId}
        LIMIT 1
      `;
      if (tickets.length > 0) {
        const ticket = tickets[0];
        const traderChatId = Number(ticket.chat_id);

        try {
          const { TelegramBotController } = await import('@/lib/telegram-trade-controller');
          const traderBot = new TelegramBotController();
          await traderBot.sendMessage(traderChatId,
            `💬 *Response from Administrator:*\n\n` +
            `"${text}"`
          );

          await controller.sendApi('sendMessage', {
            chat_id: chatId!,
            reply_to_message_id: update.message.message_id,
            text: `✅ *Response delivered successfully to Trader \`${traderChatId}\`.*`,
            parse_mode: 'Markdown',
          });
        } catch (deliveryErr) {
          console.error('[Admin Support Reply Delivery Failure]:', deliveryErr);
          await controller.sendApi('sendMessage', {
            chat_id: chatId!,
            reply_to_message_id: update.message.message_id,
            text: `❌ *Failed to deliver response to Trader:* ${deliveryErr instanceof Error ? deliveryErr.message : 'Unknown error'}`,
            parse_mode: 'Markdown',
          });
        }
        return NextResponse.json({ ok: true });
      }
    }

    if (text === '/start' || text === '/admin' || text === '/status' || text === '/health') {
      await controller.renderHealthDashboard(chatId!);
      return NextResponse.json({ ok: true });
    }

    if (text === '/models') {
      await controller.renderModelsDashboard(chatId!);
      return NextResponse.json({ ok: true });
    }

    if (text === '/summary' || text === '/daily_summary') {
      await controller.renderDailySummaryDashboard(chatId!);
      return NextResponse.json({ ok: true });
    }

    if (text === '/logs') {
      await controller.renderLogsDashboard(chatId!);
      return NextResponse.json({ ok: true });
    }

    await controller.renderHealthDashboard(chatId!);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Telegram alert webhook failed';
    console.error('[Telegram Alert Webhook Error]:', message);

    if (message === 'TELEGRAM_WEBHOOK_UNAUTHORIZED') {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json({ ok: false, error: 'Processing failed' });
  }
}
