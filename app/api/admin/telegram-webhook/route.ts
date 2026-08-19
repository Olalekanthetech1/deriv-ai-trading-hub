import { NextRequest, NextResponse } from 'next/server';
import { getTelegramWebhookSecret, requireTelegramAdminSecret } from '@/lib/telegram-security';

export async function POST(req: NextRequest) {
  try {
    requireTelegramAdminSecret(req);

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      return NextResponse.json({ success: false, error: 'TELEGRAM_BOT_TOKEN is not configured' }, { status: 503 });
    }

    const appUrl = (process.env.APP_URL || process.env.RENDER_BACKEND_URL || '').replace(/\/$/, '');
    if (!appUrl) {
      return NextResponse.json({ success: false, error: 'APP_URL or RENDER_BACKEND_URL is required to register webhook' }, { status: 503 });
    }

    const webhookSecret = getTelegramWebhookSecret();
    const webhookUrl = `${appUrl}/api/telegram/webhook`;
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ['message', 'callback_query'],
      }),
    });

    const data = await res.json().catch(() => ({ ok: false, description: 'Invalid Telegram response' }));
    if (!res.ok || data.ok !== true) {
      console.error('[Telegram Webhook Registration Error]:', data.description || 'Telegram rejected webhook registration');
      return NextResponse.json({ success: false, error: 'Telegram rejected webhook registration' }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      webhook_url: webhookUrl,
      registered: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Webhook registration failed';
    console.error('[Telegram Admin Webhook Error]:', message);
    const status = message.includes('UNAUTHORIZED') ? 401 : 503;
    return NextResponse.json({ success: false, error: message.includes('UNAUTHORIZED') ? 'Unauthorized' : message }, { status });
  }
}

export async function GET(req: NextRequest) {
  try {
    requireTelegramAdminSecret(req);

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      return NextResponse.json({ configured: false, error: 'TELEGRAM_BOT_TOKEN missing' }, { status: 503 });
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = await res.json().catch(() => ({ ok: false }));
    if (!res.ok || data.ok !== true) {
      return NextResponse.json({ configured: false, error: 'Unable to read Telegram webhook status' }, { status: 502 });
    }

    const info = data.result || {};
    return NextResponse.json({
      configured: true,
      bot_username: process.env.TELEGRAM_BOT_USERNAME || 'Not configured',
      webhook_url: info.url || null,
      pending_update_count: info.pending_update_count ?? 0,
      last_error_date: info.last_error_date ?? null,
      last_error_message: info.last_error_message || null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Webhook status lookup failed';
    const status = message.includes('UNAUTHORIZED') ? 401 : 503;
    return NextResponse.json({ configured: false, error: message.includes('UNAUTHORIZED') ? 'Unauthorized' : message }, { status });
  }
}
