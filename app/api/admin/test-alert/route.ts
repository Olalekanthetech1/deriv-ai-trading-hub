import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../auth/route';
import { sendModelDriftAlertEmail } from '@/lib/alert-email-dispatcher';

function isAdmin(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(verifySessionToken(cookieToken) || verifySessionToken(headerToken));
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: 'Unauthorized admin access' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const channel = body.channel || 'all';

    const testPayload = {
      modelId: 'test_demo_xgboost_v100_1s',
      modelKey: 'xgboost',
      symbol: 'R_100',
      durationValue: 1,
      durationUnit: 's',
      liveAccuracy: 0.44,
      validationAccuracy: 0.65,
      accuracyDrop: 0.21,
      sampleCount: 30,
      breachReason: 'Manual Test Trigger from Operations Center',
      evaluatedAt: new Date().toISOString(),
    };

    const result = await sendModelDriftAlertEmail(testPayload);

    return NextResponse.json({
      success: true,
      result,
      message: 'Test alert dispatched across active notification channels (Telegram, Resend, Webhook)',
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to dispatch test alert' },
      { status: 500 }
    );
  }
}
