import { NextRequest, NextResponse } from 'next/server';
import {
  evaluateModelDriftAndCircuitBreakers,
  getCircuitBreakerOverview,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from '@/lib/ml-circuit-breaker';
import { verifySessionToken } from '../auth/route';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });
  }

  try {
    const [overview, driftReport] = await Promise.all([
      getCircuitBreakerOverview(),
      evaluateModelDriftAndCircuitBreakers({ autoDemote: false }, 'admin-circuit-breaker-query'),
    ]);

    return NextResponse.json({
      success: true,
      overview,
      driftReport,
      timestamp: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[Admin Circuit Breaker GET Error]:', err);
    return NextResponse.json({ success: false, error: err?.message || 'Failed to retrieve circuit breaker status' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const autoDemote = body.autoDemote ?? true;
    const minSamples = typeof body.minSamples === 'number' ? body.minSamples : DEFAULT_CIRCUIT_BREAKER_CONFIG.minSamples;
    const driftTolerancePct = typeof body.driftTolerancePct === 'number' ? body.driftTolerancePct : DEFAULT_CIRCUIT_BREAKER_CONFIG.driftTolerancePct;
    const minAccuracyThreshold = typeof body.minAccuracyThreshold === 'number' ? body.minAccuracyThreshold : DEFAULT_CIRCUIT_BREAKER_CONFIG.minAccuracyThreshold;

    const result = await evaluateModelDriftAndCircuitBreakers({
      autoDemote,
      minSamples,
      driftTolerancePct,
      minAccuracyThreshold,
    }, 'admin-circuit-breaker-run');

    return NextResponse.json({
      success: true,
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[Admin Circuit Breaker POST Error]:', err);
    return NextResponse.json({ success: false, error: err?.message || 'Circuit breaker evaluation failed' }, { status: 500 });
  }
}
