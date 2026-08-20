import { NextRequest, NextResponse } from 'next/server';
import { getTelegramWebhookSecret, requireTelegramAdminSecret } from '@/lib/telegram-security';

export async function POST(req: NextRequest) {
  try {
    requireTelegramAdminSecret(req);

    const token = process.env.ALERT_TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      return NextResponse.json({ success: false, error: 'ALERT_TELEGRAM_BOT_TOKEN is not configured' }, { status: 503 });
    }

    const appUrl = (process.env.APP_URL || process.env.RENDER_BACKEND_URL || '').replace(/\/$/, '');
    if (!appUrl) {
      return NextResponse.json({ success: false, error: 'APP_URL or RENDER_BACKEND_URL is required to register webhook' }, { status: 503 });
    }

    const webhookSecret = getTelegramWebhookSecret();
    const webhookUrl = `${appUrl}/api/admin/telegram-alert-webhook`;
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
      console.error('[Telegram Alert Webhook Registration Error]:', data.description || 'Telegram rejected webhook registration');
      return NextResponse.json({ success: false, error: 'Telegram rejected alert bot webhook registration' }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      webhook_url: webhookUrl,
      registered: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Alert webhook registration failed';
    console.error('[Telegram Admin Alert Webhook Error]:', message);
    const status = message.includes('UNAUTHORIZED') ? 401 : 503;
    return NextResponse.json({ success: false, error: message.includes('UNAUTHORIZED') ? 'Unauthorized' : message }, { status });
  }
}

export async function GET(req: NextRequest) {
  try {
    requireTelegramAdminSecret(req);

    const token = process.env.ALERT_TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      return NextResponse.json({ configured: false, error: 'ALERT_TELEGRAM_BOT_TOKEN missing' }, { status: 503 });
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = await res.json().catch(() => ({ ok: false }));
    if (!res.ok || data.ok !== true) {
      return NextResponse.json({ configured: false, error: 'Unable to read Telegram webhook status' }, { status: 502 });
    }

    const info = data.result || {};
    return NextResponse.json({
      configured: true,
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
