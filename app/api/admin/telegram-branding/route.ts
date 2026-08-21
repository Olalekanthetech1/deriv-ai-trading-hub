import { NextRequest, NextResponse } from 'next/server';
import {
  getTelegramBrandingRuntimeConfig,
  updateTelegramBrandingRuntimeConfig,
} from '@/lib/ops-runtime-config';
import { verifySessionToken } from '../auth/route';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken =
    req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });
  }

  try {
    const config = await getTelegramBrandingRuntimeConfig(true);
    return NextResponse.json({
      success: true,
      config,
      timestamp: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[Admin Telegram Branding GET Error]:', err);
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to retrieve Telegram branding config' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    let updates: Record<string, string> = {};

    if (body.branding && typeof body.branding === 'object') {
      updates = body.branding;
    } else if (typeof body.screenKey === 'string') {
      updates = { [body.screenKey]: typeof body.imageUrl === 'string' ? body.imageUrl : '' };
    } else {
      return NextResponse.json(
        { success: false, error: 'Invalid request body. Expected screenKey & imageUrl or branding object.' },
        { status: 400 }
      );
    }

    // Basic URL validation if non-empty
    for (const [key, url] of Object.entries(updates)) {
      if (typeof url === 'string' && url.trim().length > 0) {
        try {
          new URL(url.trim());
        } catch {
          return NextResponse.json(
            { success: false, error: `Invalid URL specified for screen key "${key}".` },
            { status: 400 }
          );
        }
      }
    }

    const updatedConfig = await updateTelegramBrandingRuntimeConfig(updates, 'admin_session');

    return NextResponse.json({
      success: true,
      config: updatedConfig,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[Admin Telegram Branding POST Error]:', err);
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to update Telegram branding config' },
      { status: 500 }
    );
  }
}
