import { NextRequest, NextResponse } from 'next/server';
import { BacktestSchema } from '@/lib/validation-schemas';
import { initDbSchema, saveBacktestResults } from '@/lib/db';
import { mlRuntimeClient } from '@/lib/ml-runtime-client';
import { ensureMinTicks } from '@/lib/ticks-helper';
import { buildBacktestFeatureVectors } from '@/lib/ml-feature-dataset';

export async function POST(req: NextRequest) {
  try {
    await initDbSchema();
    const rawBody = await req.json().catch(() => ({}));
    const parseResult = BacktestSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid input parameters', details: parseResult.error.format() },
        { status: 400 },
      );
    }

    const { symbol, horizons, sampleLimit } = parseResult.data;
    const ticks = await ensureMinTicks(symbol, sampleLimit || 1000);
    const assetCategory = symbol.startsWith('FRX') ? 1 : symbol.startsWith('CWM') ? 2 : 0;
    const featureVectorsByHorizon: Record<string, number[][]> = {};

    for (const horizon of horizons) {
      featureVectorsByHorizon[String(horizon)] = await buildBacktestFeatureVectors(ticks, horizon, {
        symbol,
        durationSecs: horizon,
        assetCategory,
      });
    }

    const backtestRes = await mlRuntimeClient.sendCommand('backtest', {
      symbol,
      prices: ticks.map((tick) => tick.price),
      horizons,
      featureVectorsByHorizon,
    });

    if (!backtestRes || !backtestRes.success) {
      throw new Error(`Native ML runtime backtest failed: ${backtestRes?.error || 'Unknown Error'}`);
    }

    if (backtestRes.horizonMatrix) {
      for (const hzData of Object.values(backtestRes.horizonMatrix)) {
        const hData: any = hzData;
        await saveBacktestResults({
          symbol,
          durationSec: hData.horizonSecs,
          totalTrades: hData.trades,
          winningTrades: hData.wins,
          profitFactor: hData.profitFactor,
        });
      }
    }

    return NextResponse.json(backtestRes);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Backtest failed' }, { status: 500 });
  }
}
