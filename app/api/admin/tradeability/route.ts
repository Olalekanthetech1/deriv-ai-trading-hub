import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getPredictiveModelDefinitions, getProductionCandidateDefinitions } from '@/lib/ml-model-registry';
import { hasModelArtifact } from '@/lib/ml-model-artifact-store';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export type DurationHorizonSpec = {
  key: string;
  durationValue: number;
  durationUnit: string;
  durationSecs: number;
  label: string;
};

export const STANDARD_TRADE_HORIZONS: DurationHorizonSpec[] = [
  { key: '1t', durationValue: 1, durationUnit: 't', durationSecs: 1, label: '1 Tick' },
  { key: '5t', durationValue: 5, durationUnit: 't', durationSecs: 5, label: '5 Ticks' },
  { key: '10t', durationValue: 10, durationUnit: 't', durationSecs: 10, label: '10 Ticks' },
  { key: '15s', durationValue: 15, durationUnit: 's', durationSecs: 15, label: '15 Secs' },
  { key: '30s', durationValue: 30, durationUnit: 's', durationSecs: 30, label: '30 Secs' },
  { key: '60s', durationValue: 60, durationUnit: 's', durationSecs: 60, label: '60 Secs (1m)' },
  { key: '300s', durationValue: 300, durationUnit: 's', durationSecs: 300, label: '300 Secs (5m)' },
];

export type HorizonEnsembleStatus = {
  horizonKey: string;
  durationValue: number;
  durationUnit: string;
  durationSecs: number;
  label: string;
  isFullyTradeable: boolean;
  readinessScore: number; // 0 to 100%
  predictive: {
    ready: boolean;
    activeKeys: string[];
    models: Array<{
      key: string;
      modelId: string;
      accuracy: number | null;
      f1: number | null;
      artifactHealthy: boolean;
    }>;
  };
  regime: {
    ready: boolean; // Must have 'hmm'
    modelId: string | null;
    artifactHealthy: boolean;
  };
  anomaly: {
    ready: boolean; // Must have 'isolation_forest'
    modelId: string | null;
    artifactHealthy: boolean;
  };
  missingComponents: string[];
};

export type AssetTradeabilityReport = {
  symbol: string;
  displayName: string;
  totalHorizons: number;
  fullyTradeableHorizonsCount: number;
  partiallyTradeableHorizonsCount: number;
  unconfiguredHorizonsCount: number;
  overallTradeabilityPct: number;
  horizons: Record<string, HorizonEnsembleStatus>;
};

export async function GET(req: NextRequest) {
  try {
    const sql = getDb();
    if (!sql) {
      return NextResponse.json({ success: false, error: 'Database unavailable.' }, { status: 503 });
    }

    const { searchParams } = new URL(req.url);
    const filterSymbol = searchParams.get('symbol')?.trim();

    // 1. Fetch all production models
    const productionRows = await sql`
      SELECT model_id, asset_symbol, horizon_ticks, duration_value, duration_unit,
             model_family, framework, metrics, status, updated_at, strategy_key
      FROM ml_model_registry_v2
      WHERE status = 'production'
      ORDER BY asset_symbol ASC, duration_value ASC
    `;

    // 2. Fetch all known assets from database or active registry
    const distinctAssets = await sql`
      SELECT DISTINCT asset_symbol FROM ml_model_registry_v2
      WHERE asset_symbol IS NOT NULL AND asset_symbol <> ''
      ORDER BY asset_symbol ASC
    `;

    const allSymbols = Array.from(new Set([
      ...distinctAssets.map((r: any) => String(r.asset_symbol)),
      '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',
      'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
      'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
      'BOOM500', 'BOOM1000', 'CRASH500', 'CRASH1000', 'STP1'
    ])).filter(s => !filterSymbol || s.toLowerCase() === filterSymbol.toLowerCase());

    const predictiveDefs = getPredictiveModelDefinitions();
    const predictiveKeys = predictiveDefs.map(d => d.key.toLowerCase());

    // Group production models by symbol -> durationKey
    const prodMap = new Map<string, any[]>();
    for (const row of productionRows) {
      const sym = String(row.asset_symbol);
      const dVal = Number(row.duration_value ?? row.horizon_ticks ?? 5);
      const dUnit = String(row.duration_unit || (dVal <= 10 ? 't' : 's'));
      const hKey = `${dVal}${dUnit}`;
      const groupKey = `${sym}::${hKey}`;

      const list = prodMap.get(groupKey) || [];
      list.push(row);
      prodMap.set(groupKey, list);

      // Also map under numeric seconds fallback
      const secKey = `${sym}::${dVal}s`;
      if (!prodMap.has(secKey)) prodMap.set(secKey, list);
      const tickKey = `${sym}::${dVal}t`;
      if (!prodMap.has(tickKey)) prodMap.set(tickKey, list);
    }

    const assetReports: AssetTradeabilityReport[] = [];
    let totalPairsCount = 0;
    let totalFullyTradeablePairs = 0;
    let totalMissingRegimePairs = 0;
    let totalMissingAnomalyPairs = 0;
    let totalMissingPredictivePairs = 0;

    for (const symbol of allSymbols) {
      const horizonsMap: Record<string, HorizonEnsembleStatus> = {};
      let fullyTradeableCount = 0;
      let partiallyTradeableCount = 0;
      let unconfiguredCount = 0;

      for (const horizon of STANDARD_TRADE_HORIZONS) {
        totalPairsCount++;
        const key = `${symbol}::${horizon.key}`;
        const prodModels = prodMap.get(key) || [];

        const activePredictiveModels: Array<{
          key: string;
          modelId: string;
          accuracy: number | null;
          f1: number | null;
          artifactHealthy: boolean;
        }> = [];

        let hmmModel: { modelId: string; artifactHealthy: boolean } | null = null;
        let isoModel: { modelId: string; artifactHealthy: boolean } | null = null;

        for (const m of prodModels) {
          const mKey = String(m.model_family || m.framework || '').toLowerCase();
          const mId = String(m.model_id);
          const metrics = (m.metrics as Record<string, unknown> | null) || {};
          const acc = Number.isFinite(Number(metrics.accuracy)) ? Number(metrics.accuracy) : null;
          const f1 = Number.isFinite(Number(metrics.f1)) ? Number(metrics.f1) : null;

          // Check if key is HMM
          if (mKey === 'hmm' || mId.toLowerCase().includes('_hmm')) {
            const healthy = await hasModelArtifact(mId);
            hmmModel = { modelId: mId, artifactHealthy: healthy };
          } else if (mKey === 'isolation_forest' || mId.toLowerCase().includes('_isolation_forest') || mId.toLowerCase().includes('_iso')) {
            const healthy = await hasModelArtifact(mId);
            isoModel = { modelId: mId, artifactHealthy: healthy };
          } else {
            // Directional / Predictive model
            const healthy = await hasModelArtifact(mId);
            activePredictiveModels.push({
              key: mKey,
              modelId: mId,
              accuracy: acc,
              f1,
              artifactHealthy: healthy,
            });
          }
        }

        const hasPredictive = activePredictiveModels.some(m => m.artifactHealthy);
        const hasRegime = Boolean(hmmModel && hmmModel.artifactHealthy);
        const hasAnomaly = Boolean(isoModel && isoModel.artifactHealthy);

        const missing: string[] = [];
        if (!hasPredictive) missing.push('Predictive Directional Model (XGBoost/TCN/LSTM)');
        if (!hasRegime) missing.push('HMM Market Regime Classifier');
        if (!hasAnomaly) missing.push('Isolation Forest Anomaly Filter');

        if (!hasRegime) totalMissingRegimePairs++;
        if (!hasAnomaly) totalMissingAnomalyPairs++;
        if (!hasPredictive) totalMissingPredictivePairs++;

        const isFullyTradeable = hasPredictive && hasRegime && hasAnomaly;
        const readinessScore = Math.round(
          ((hasPredictive ? 40 : 0) + (hasRegime ? 30 : 0) + (hasAnomaly ? 30 : 0))
        );

        if (isFullyTradeable) {
          fullyTradeableCount++;
          totalFullyTradeablePairs++;
        } else if (prodModels.length > 0) {
          partiallyTradeableCount++;
        } else {
          unconfiguredCount++;
        }

        horizonsMap[horizon.key] = {
          horizonKey: horizon.key,
          durationValue: horizon.durationValue,
          durationUnit: horizon.durationUnit,
          durationSecs: horizon.durationSecs,
          label: horizon.label,
          isFullyTradeable,
          readinessScore,
          predictive: {
            ready: hasPredictive,
            activeKeys: activePredictiveModels.map(m => m.key),
            models: activePredictiveModels,
          },
          regime: {
            ready: hasRegime,
            modelId: hmmModel?.modelId || null,
            artifactHealthy: Boolean(hmmModel?.artifactHealthy),
          },
          anomaly: {
            ready: hasAnomaly,
            modelId: isoModel?.modelId || null,
            artifactHealthy: Boolean(isoModel?.artifactHealthy),
          },
          missingComponents: missing,
        };
      }

      const overallTradeabilityPct = Math.round(
        (fullyTradeableCount / STANDARD_TRADE_HORIZONS.length) * 100
      );

      assetReports.push({
        symbol,
        displayName: getSymbolDisplayName(symbol),
        totalHorizons: STANDARD_TRADE_HORIZONS.length,
        fullyTradeableHorizonsCount: fullyTradeableCount,
        partiallyTradeableHorizonsCount: partiallyTradeableCount,
        unconfiguredHorizonsCount: unconfiguredCount,
        overallTradeabilityPct,
        horizons: horizonsMap,
      });
    }

    // Sort by tradeability percentage descending
    assetReports.sort((a, b) => b.overallTradeabilityPct - a.overallTradeabilityPct || a.symbol.localeCompare(b.symbol));

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      summary: {
        totalAssetsEvaluated: assetReports.length,
        assetsWithTradeableHorizons: assetReports.filter(a => a.fullyTradeableHorizonsCount > 0).length,
        totalPairsCount,
        fullyTradeablePairsCount: totalFullyTradeablePairs,
        missingRegimeCount: totalMissingRegimePairs,
        missingAnomalyCount: totalMissingAnomalyPairs,
        missingPredictiveCount: totalMissingPredictivePairs,
        standardHorizons: STANDARD_TRADE_HORIZONS,
      },
      assets: assetReports,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || 'Tradeability evaluation failed.' }, { status: 500 });
  }
}
