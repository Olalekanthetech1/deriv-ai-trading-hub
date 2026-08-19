import { NextRequest, NextResponse } from 'next/server';
import { recordTradeAttribution, getAttributionDiagnostics } from '@/lib/horizon-attribution';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      tradeId,
      symbol,
      horizonKey,
      horizonValue,
      horizonUnit,
      direction,
      entryPrice,
      exitPrice,
      entryTimestamp,
      exitTimestamp,
      outcome,
      profit,
      stake,
      intratradeTicks,
      executionPlanId,
      strategyName,
    } = body;

    if (!symbol || !direction || entryPrice === undefined || exitPrice === undefined || !outcome) {
      return NextResponse.json(
        { success: false, error: 'Missing required attribution fields (symbol, direction, entryPrice, exitPrice, outcome)' },
        { status: 400 }
      );
    }

    const calculatedKey = horizonKey || `${horizonValue || 5}${horizonUnit || 't'}`;

    const metrics = recordTradeAttribution({
      tradeId: tradeId || `TR-${Date.now()}`,
      symbol,
      horizonKey: calculatedKey,
      horizonValue: Number(horizonValue) || 5,
      horizonUnit: horizonUnit || 't',
      direction: direction === 'CALL' || direction === 'PUT' ? direction : 'CALL',
      entryPrice: Number(entryPrice),
      exitPrice: Number(exitPrice),
      entryTimestamp: Number(entryTimestamp) || Date.now() - 5000,
      exitTimestamp: Number(exitTimestamp) || Date.now(),
      outcome: outcome === 'WIN' ? 'WIN' : 'LOSS',
      profit: Number(profit) || 0,
      stake: Number(stake) || 10,
      intratradeTicks: Array.isArray(intratradeTicks) ? intratradeTicks : undefined,
      executionPlanId,
      strategyName,
    });

    return NextResponse.json({
      success: true,
      metrics,
      attributionTimestamp: Date.now(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown attribution recording error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const symbol = url.searchParams.get('symbol') || 'R_100';
    const diagnostics = getAttributionDiagnostics(symbol);

    return NextResponse.json({
      success: true,
      symbol,
      diagnostics,
      timestamp: Date.now(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown attribution query error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
