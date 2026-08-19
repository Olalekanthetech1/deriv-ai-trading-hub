import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../auth/route';
import { evaluateAndPromoteCandidateModels } from '@/lib/ml-pipeline-auto-evaluator';

function isAdmin(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(verifySessionToken(cookieToken) || verifySessionToken(headerToken));
}

function noStore() {
  return { 'Cache-Control': 'no-store, max-age=0' };
}

/**
 * POST /api/admin/pipeline-auto-eval
 * Evaluates candidate models through walk-forward backtesting,
 * cohort performance benchmarks, and champion-challenger deltas.
 */
export async function POST(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const modelIds = Array.isArray(body?.modelIds) ? body.modelIds.map((id: unknown) => String(id).trim()).filter(Boolean) : [];

    if (!modelIds.length) {
      return NextResponse.json(
        { success: false, error: 'modelIds array is required for pipeline backtest evaluation.' },
        { status: 400, headers: noStore() }
      );
    }

    const config = {
      minConfidence: Number(body?.minConfidence || 65),
      minWinRate: Number(body?.minWinRate || 50.0),
      minProfitFactor: Number(body?.minProfitFactor || 1.0),
      maxDrawdownPct: Number(body?.maxDrawdownPct || 25.0),
      minTrades: Number(body?.minTrades || 5),
      autoPromoteOnPass: body?.autoPromote !== false, // default true
    };

    const evaluationSummary = await evaluateAndPromoteCandidateModels(modelIds, config);

    return NextResponse.json(
      {
        success: evaluationSummary.success,
        evaluationSummary,
      },
      { status: evaluationSummary.success ? 200 : 500, headers: noStore() }
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Pipeline evaluation failed.',
      },
      { status: 500, headers: noStore() }
    );
  }
}
