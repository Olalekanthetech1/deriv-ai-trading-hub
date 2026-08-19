import { NextRequest, NextResponse } from 'next/server';
import { resolveProductionModels } from '@/lib/production-model-resolver';
import { getPredictiveModelDefinitions } from '@/lib/ml-model-registry';
import { getDb, initDbSchema } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = String(searchParams.get('symbol') || '').trim().toUpperCase();
    const rawDurationValue = searchParams.get('durationValue');
    const rawDurationUnit = String(searchParams.get('durationUnit') || '').trim().toLowerCase();

    if (!symbol) {
      return NextResponse.json({
        success: false,
        ready: false,
        errorCode: 'SYMBOL_REQUIRED',
        error: 'symbol is required for ML readiness checks',
      }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    if (rawDurationValue === null || !rawDurationUnit) {
      return NextResponse.json({
        success: false,
        ready: false,
        symbol,
        errorCode: 'DURATION_METADATA_REQUIRED',
        error: 'durationValue and durationUnit are required for horizon-specific ML readiness checks',
      }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const durationValue = Number(rawDurationValue);
    const durationUnit = rawDurationUnit;
    if (!Number.isInteger(durationValue) || durationValue <= 0 || !['t', 's', 'm', 'h', 'd'].includes(durationUnit)) {
      return NextResponse.json({
        success: false,
        ready: false,
        symbol,
        errorCode: 'DURATION_METADATA_INVALID',
        error: 'durationValue must be a positive integer and durationUnit must be one of t, s, m, h, d',
      }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const predictiveDefs = getPredictiveModelDefinitions();
    const productionModels = await resolveProductionModels(symbol, durationValue, durationUnit);

    const productionKeys = Object.keys(productionModels);
    const predictiveKeys = productionKeys.filter((key) =>
      predictiveDefs.some((d) => d.key === key)
    );

    const isReady = predictiveKeys.length > 0;
    const isMultiHorizon = Object.values(productionModels).some((m) => m.isMultiHorizon);

    let candidateCount = 0;
    let stagingCount = 0;
    if (await initDbSchema()) {
      const sql = getDb();
      if (sql) {
        const candidateRows = await sql`
          SELECT status, COUNT(*)::integer as count
          FROM ml_model_registry_v2
          WHERE asset_symbol = ${symbol}::varchar
            AND status IN ('candidate', 'staging')
          GROUP BY status
        `;
        for (const row of candidateRows as any[]) {
          if (row.status === 'candidate') candidateCount = Number(row.count || 0);
          if (row.status === 'staging') stagingCount = Number(row.count || 0);
        }
      }
    }

    const trainUrl = `/admin/model-training?symbol=${encodeURIComponent(symbol)}&durationValue=${durationValue}&durationUnit=${encodeURIComponent(durationUnit)}`;
    const promoteUrl = `/admin/models?symbol=${encodeURIComponent(symbol)}`;

    let actionableTip = '';
    if (!isReady) {
      if (stagingCount > 0 || candidateCount > 0) {
        actionableTip = `Found ${stagingCount + candidateCount} candidate model(s) for ${symbol}. Promote one to Production in the Model Operations Center.`;
      } else {
        actionableTip = `No validated production model is available for ${symbol} at ${durationValue}${durationUnit}. Train and validate a Unified Multi-Horizon model for this horizon.`;
      }
    }

    return NextResponse.json({
      success: true,
      ready: isReady,
      symbol,
      duration: { value: durationValue, unit: durationUnit, label: `${durationValue}${durationUnit}` },
      productionModelCount: predictiveKeys.length,
      productionModels: Object.values(productionModels).map((m) => ({
        modelId: m.modelId,
        modelKey: m.modelKey,
        modelFamily: m.modelFamily,
        framework: m.framework,
        isMultiHorizon: m.isMultiHorizon,
        validation: m.validation,
      })),
      isMultiHorizonCovered: isMultiHorizon,
      candidateCount,
      stagingCount,
      trainUrl,
      promoteUrl,
      actionableTip,
      errorCode: isReady ? null : 'NO_PRODUCTION_PREDICTIVE_MODEL_REGISTERED',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[ML Readiness Route Error]:', err);
    return NextResponse.json({
      success: false,
      ready: false,
      error: err?.message || 'Failed to check model readiness',
    }, { status: 500 });
  }
}
