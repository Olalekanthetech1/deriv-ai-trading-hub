import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

import { PredictSchema } from '@/lib/validation-schemas';
import { evaluateProductionEnsemble } from '@/lib/production-ensemble';
import { ensureMinTicks } from '@/lib/ticks-helper';
import { getMlRuntimeSchemaContract } from '@/lib/ml-runtime-schema';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.json().catch(() => ({}));
    const parseResult = PredictSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return NextResponse.json({ success: false, error: 'Invalid input parameters', details: parseResult.error.format() }, { status: 400 });
    }

    const { symbol, ticks, durationSecs, durationValue, durationUnit, assetCategory } = parseResult.data;
    const schema = await getMlRuntimeSchemaContract();
    const requiredContextTicks = Math.max(schema.canonicalFeatureWindowTicks, schema.sequenceLength);
    let tickList = Array.isArray(ticks) && ticks.length > 0 ? ticks : [];
    if (tickList.length < requiredContextTicks) tickList = await ensureMinTicks(symbol, requiredContextTicks);
    if (tickList.length < requiredContextTicks) return NextResponse.json({ success: false, error: `Insufficient ticks for ${symbol}.` }, { status: 422 });

    let assetClass: string | undefined;
    let marketType: string | undefined;
    const sql = getDb();
    if (sql) {
      try {
        const rows = await sql`
          SELECT asset_class, market_type
          FROM market_assets
          WHERE symbol = ${symbol}
          LIMIT 1
        `;
        assetClass = rows?.[0]?.asset_class ? String(rows[0].asset_class) : undefined;
        marketType = rows?.[0]?.market_type ? String(rows[0].market_type) : undefined;
      } catch (dbErr) {
        console.warn('[ML Predict Asset Context Warning]:', dbErr);
      }
    }

    const startTime = Date.now();
    const ensemble = await evaluateProductionEnsemble(tickList, {
      symbol,
      durationSecs,
      durationValue,
      durationUnit,
      assetCategory,
      assetClass,
      marketType,
      requiredContextTicks,
    });
    const feat = ensemble.features;
    const microVelocity = Number.isFinite(Number(feat.micro_velocity)) ? Number(feat.micro_velocity) : null;
    const shortVol = Number.isFinite(Number(feat.short_volatility)) ? Number(feat.short_volatility) : null;
    const noiseScore = microVelocity !== null && shortVol !== null && Number.isFinite(shortVol / (Math.abs(microVelocity) + 0.0001))
      ? Math.min(100, Math.max(0, Math.round((shortVol / (Math.abs(microVelocity) + 0.0001)) * 12)))
      : null;

    const prediction = {
      signal: ensemble.direction === 'RISE' ? ('CALL' as const) : ('PUT' as const),
      confidence: ensemble.confidence,
      rawScore: Number(((ensemble.probUp - ensemble.probDown) / 100).toFixed(4)),
      features: feat,
      symbol,
      timestamp: Date.now(),
      modelVersion: 'production-ensemble',
    };

    const enrichedPrediction = {
      ...prediction,
      signal: ensemble.direction === 'RISE' ? 'CALL' : 'PUT',
      confidence: ensemble.confidence,
      probabilityUp: ensemble.probUp,
      probabilityDown: ensemble.probDown,
      ensemble,
      assetContext: ensemble.assetContext,
      strategyGate: ensemble.strategyGate,
      latencyMs: Date.now() - startTime,
      ticksProcessed: tickList.length,
      marketNoiseScore: noiseScore,
      marketRegime: ensemble.marketRegime,
      microVelocity,
      tickFrequency: Number.isFinite(Number(feat.ticks_per_second)) ? Number(feat.ticks_per_second) : null,
      volatilityRank: Number.isFinite(Number(feat.macro_volatility)) ? Number(feat.macro_volatility) : null,
    };

    return NextResponse.json({ success: true, prediction: enrichedPrediction, confidence: ensemble.confidence, marketRegime: ensemble.marketRegime, anomalyScore: ensemble.anomalyScore, modelBreakdown: ensemble.modelBreakdown, multiModelEnsemble: ensemble, assetContext: ensemble.assetContext, strategyGate: ensemble.strategyGate }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    const msg = err?.message || 'Prediction failed';
    if (msg === 'NO_PRODUCTION_PREDICTIVE_MODEL_REGISTERED' || msg === 'NO_NATIVE_MODEL_SIGNALS_AVAILABLE') {
      console.warn('[ML Predict Route Notice]:', msg);
    } else {
      console.error('[ML Predict Route Error]:', err);
    }
    return NextResponse.json({ success: false, error: msg }, { status: 503 });
  }
}
