import { NextRequest, NextResponse } from 'next/server';
import { mlRuntimeClient } from '@/lib/ml-runtime-client';
import { initDbSchema, getTicksHistory } from '@/lib/db';
import { verifySessionToken } from '../auth/route';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace('Bearer ', '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function POST(req: NextRequest) {
  if (!isAuthValid(req)) return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401 });

  try {
    await initDbSchema();
    const body = await req.json().catch(() => ({}));
    const symbol = typeof body?.symbol === 'string' ? body.symbol.trim() : '';
    const horizonSecs = Number(body?.horizonSecs);
    const minConfidence = Number(body?.minConfidence);
    const stake = Number(body?.stake);
    const payoutRate = Number(body?.payoutRate);

    if (!symbol) return NextResponse.json({ error: 'A live market symbol is required.' }, { status: 400 });
    if (!Number.isFinite(horizonSecs) || horizonSecs <= 0) return NextResponse.json({ error: 'A positive horizonSecs value is required.' }, { status: 400 });
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 100) return NextResponse.json({ error: 'minConfidence must be a number between 0 and 100.' }, { status: 400 });
    if (!Number.isFinite(stake) || stake <= 0) return NextResponse.json({ error: 'A positive stake is required.' }, { status: 400 });
    if (!Number.isFinite(payoutRate) || payoutRate <= 0 || payoutRate > 1) return NextResponse.json({ error: 'payoutRate must be a positive decimal no greater than 1.' }, { status: 400 });

    const { ensureMinTicks } = await import('@/lib/ticks-helper');
    let ticks = await getTicksHistory(symbol, 1000);
    if (ticks.length < 100) ticks = await ensureMinTicks(symbol, 1000);
    if (ticks.length < 100) return NextResponse.json({ error: `Insufficient persisted/live ticks for ${symbol}.` }, { status: 422 });

    const assetCategory = Number.isFinite(Number(body?.assetCategory))
      ? Number(body.assetCategory)
      : symbol.startsWith('FRX') ? 1 : symbol.startsWith('CWM') ? 2 : 0;

    const nativeResult = await mlRuntimeClient.sendCommand('backtest', {
      symbol,
      ticks,
      horizons: [horizonSecs],
      assetCategory,
      minConfidence,
      stake,
      payoutRate,
    });

    if (!nativeResult?.success) {
      return NextResponse.json({ error: nativeResult?.error || 'Native trained-model backtest failed.' }, { status: 503 });
    }

    const horizonResult = nativeResult.horizonMatrix?.[String(horizonSecs)];
    if (!horizonResult) return NextResponse.json({ error: 'Native runtime returned no result for the requested horizon.' }, { status: 503 });
    if (horizonResult.available === false) return NextResponse.json({ success: false, ...horizonResult, engine: nativeResult.engine }, { status: 422 });

    return NextResponse.json({
      success: true,
      ...horizonResult,
      symbol,
      sampleCount: nativeResult.sampleCount,
      bestHorizon: nativeResult.bestHorizon,
      minConfidence,
      stake,
      payoutRate,
      engine: nativeResult.engine,
      dataSource: 'native-trained-model',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Backtest evaluation failed' }, { status: 500 });
  }
}
