import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../../auth/route';
import { runShadowBenchmarkMatrix } from '@/lib/champion-challenger-benchmark';

export const dynamic = 'force-dynamic';

function isAdmin(req: NextRequest): boolean {
  const cookie = req.cookies.get('admin_session_token')?.value;
  const header = req.headers.get('x-admin-token');
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(verifySessionToken(cookie) || verifySessionToken(header) || verifySessionToken(bearer));
}

function noStore() {
  return { 'Cache-Control': 'no-store, max-age=0' };
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401, headers: noStore() });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { challengerModelId, symbol, horizonSecs, minConfidence, stake, payoutRate } = body;

    if (!challengerModelId || typeof challengerModelId !== 'string') {
      return NextResponse.json({ success: false, error: 'challengerModelId is required.' }, { status: 400, headers: noStore() });
    }
    if (!symbol || typeof symbol !== 'string') {
      return NextResponse.json({ success: false, error: 'symbol is required.' }, { status: 400, headers: noStore() });
    }
    const horizon = Number(horizonSecs);
    if (!Number.isFinite(horizon) || horizon <= 0) {
      return NextResponse.json({ success: false, error: 'Valid positive horizonSecs is required.' }, { status: 400, headers: noStore() });
    }

    const result = await runShadowBenchmarkMatrix(challengerModelId, symbol, horizon, {
      minConfidence: minConfidence !== undefined ? Number(minConfidence) : undefined,
      stake: stake !== undefined ? Number(stake) : undefined,
      payoutRate: payoutRate !== undefined ? Number(payoutRate) : undefined,
    });

    return NextResponse.json(result, { headers: noStore() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Shadow benchmark matrix execution failed.';
    return NextResponse.json({ success: false, error: message }, { status: 500, headers: noStore() });
  }
}
