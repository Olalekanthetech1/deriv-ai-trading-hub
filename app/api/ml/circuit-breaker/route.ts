import { NextRequest, NextResponse } from 'next/server';
import { evaluateModelDriftAndCircuitBreakers, getCircuitBreakerOverview } from '@/lib/ml-circuit-breaker';

export async function GET(req: NextRequest) {
  try {
    const overview = await getCircuitBreakerOverview();
    const driftReport = await evaluateModelDriftAndCircuitBreakers({ autoDemote: false });

    return NextResponse.json({
      success: true,
      overview,
      driftReport,
      timestamp: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[Circuit Breaker GET Error]:', err);
    return NextResponse.json({ success: false, error: err?.message || 'Failed to retrieve circuit breaker status' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const autoDemote = body.autoDemote ?? true;
    const minSamples = typeof body.minSamples === 'number' ? body.minSamples : undefined;
    const driftTolerancePct = typeof body.driftTolerancePct === 'number' ? body.driftTolerancePct : undefined;
    const minAccuracyThreshold = typeof body.minAccuracyThreshold === 'number' ? body.minAccuracyThreshold : undefined;

    const result = await evaluateModelDriftAndCircuitBreakers({
      autoDemote,
      minSamples,
      driftTolerancePct,
      minAccuracyThreshold,
    }, 'admin-circuit-breaker-trigger');

    return NextResponse.json({
      success: true,
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[Circuit Breaker POST Error]:', err);
    return NextResponse.json({ success: false, error: err?.message || 'Circuit breaker evaluation failed' }, { status: 500 });
  }
}
