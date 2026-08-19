import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../auth/route';
import { extract37TickFeatures } from '@/lib/ml-feature-extractor';
import { mlRuntimeClient } from '@/lib/ml-runtime-client';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function POST(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const startTotal = process.hrtime.bigint();

  try {
    const body = await req.json().catch(() => ({}));
    const symbol = typeof body.symbol === 'string' && body.symbol.trim() ? body.symbol.trim() : null;
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'A valid symbol is required.' }, { status: 400 });
    }

    const { getTicksHistory, initDbSchema } = await import('@/lib/db');
    const dbReady = await initDbSchema();
    if (!dbReady) {
      return NextResponse.json({ success: false, error: 'Database unavailable; real tick data is required for latency diagnostics.' }, { status: 503 });
    }

    const startFeat = process.hrtime.bigint();
    const ticks = await getTicksHistory(symbol, 50);
    if (!ticks || ticks.length < 5) {
      return NextResponse.json({
        success: false,
        error: `Insufficient real ticks for ${symbol}. Received ${ticks?.length || 0}; synthetic ticks are not permitted.`,
      }, { status: 422 });
    }

    const featureObj = extract37TickFeatures(ticks, { symbol });
    const features = Object.values(featureObj);
    const endFeat = process.hrtime.bigint();
    const featureExtractTimeMs = Number(endFeat - startFeat) / 1_000_000;

    const startInference = process.hrtime.bigint();
    const inference = await mlRuntimeClient.sendCommand('predict', {
      symbol,
      ticks,
    });
    const endInference = process.hrtime.bigint();
    const modelInferenceTimeMs = Number(endInference - startInference) / 1_000_000;

    if (!inference?.success) {
      return NextResponse.json({ success: false, error: inference?.error || 'Canonical ML runtime inference unavailable.' }, { status: 503 });
    }

    const endTotal = process.hrtime.bigint();
    const serverExecutionTimeMs = Number(endTotal - startTotal) / 1_000_000;

    let diagnosisStatus: 'optimal' | 'warning' | 'critical' = 'optimal';
    let diagnosisMessage = 'Canonical ML runtime inference and feature extraction completed.';
    if (serverExecutionTimeMs > 50) {
      diagnosisStatus = 'critical';
      diagnosisMessage = `Canonical inference pipeline exceeded 50ms (${serverExecutionTimeMs.toFixed(2)}ms).`;
    } else if (serverExecutionTimeMs > 15) {
      diagnosisStatus = 'warning';
      diagnosisMessage = `Canonical inference pipeline exceeded the 15ms diagnostic target (${serverExecutionTimeMs.toFixed(2)}ms).`;
    }

    return NextResponse.json({
      success: true,
      symbol,
      serverExecutionTimeMs: Number(serverExecutionTimeMs.toFixed(3)),
      featureExtractTimeMs: Number(featureExtractTimeMs.toFixed(3)),
      modelInferenceTimeMs: Number(modelInferenceTimeMs.toFixed(3)),
      featureCount: features.length,
      candidateModel: inference.modelType || inference.modelName || 'canonical-python-runtime',
      diagnosisStatus,
      diagnosisMessage,
      timestamp: new Date().toISOString(),
      timeEpoch: Date.now(),
    });
  } catch (err: any) {
    const endTotal = process.hrtime.bigint();
    const serverExecutionTimeMs = Number(endTotal - startTotal) / 1_000_000;

    return NextResponse.json({
      success: false,
      error: err.message || 'Latency diagnostic calculation failed',
      serverExecutionTimeMs: Number(serverExecutionTimeMs.toFixed(3)),
    }, { status: 500 });
  }
}
