import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { evaluateChampionChallengerPromotion } from '@/lib/champion-challenger-governance';
import { resolveCanonicalModelDefinition, promoteSuiteInRegistry } from '@/lib/ml-suite-promoter';
import { hasModelArtifact } from '@/lib/ml-model-artifact-store';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export type EligibleCandidateModel = {
  modelId: string;
  symbol: string;
  assetDisplayName: string;
  horizonSecs: number;
  durationValue: number;
  durationUnit: string;
  modelFamily: string;
  framework: string;
  candidateStatus: string;
  strategyKey: string;
  trainingRunId: string | null;
  datasetId: string | null;
  metrics: {
    accuracy: number | null;
    f1: number | null;
    logLoss: number | null;
    trainedAt: string | null;
  };
  champion: {
    modelId: string | null;
    modelFamily: string | null;
    framework: string | null;
    accuracy: number | null;
    f1: number | null;
    status: string;
  } | null;
  governance: {
    eligible: boolean;
    reason: string;
    accuracyDelta: number | null;
    f1Delta: number | null;
    isInitialChampion: boolean;
  };
  artifactHealthy: boolean;
};

export async function GET() {
  try {
    const sql = getDb();
    if (!sql) {
      return NextResponse.json({ success: false, error: 'Database unavailable.' }, { status: 503 });
    }

    // 1. Fetch all candidate / staging models
    const candidateRows = await sql`
      SELECT model_id, asset_symbol, horizon_ticks, duration_value, duration_unit,
             model_family, framework, metrics, status, dataset_id, training_run_id,
             strategy_key, strategy_version, feature_schema_version, updated_at
      FROM ml_model_registry_v2
      WHERE status IN ('candidate', 'staging')
      ORDER BY asset_symbol ASC, horizon_ticks ASC, updated_at DESC
    `;

    // 2. Fetch all current production champions
    const championRows = await sql`
      SELECT model_id, asset_symbol, horizon_ticks, duration_value, duration_unit,
             model_family, framework, metrics, status, updated_at
      FROM ml_model_registry_v2
      WHERE status = 'production'
      ORDER BY updated_at DESC
    `;

    // Map champions by symbol:horizon
    const championMap = new Map<string, any>();
    for (const champ of championRows) {
      const sym = String(champ.asset_symbol);
      const horiz = Number(champ.duration_value ?? champ.horizon_ticks ?? 5);
      const key = `${sym}:${horiz}`;
      if (!championMap.has(key)) {
        championMap.set(key, champ);
      }
    }

    const eligibleList: EligibleCandidateModel[] = [];
    const ineligibleList: Array<EligibleCandidateModel & { rejectionReason: string }> = [];

    for (const cand of candidateRows) {
      const mId = String(cand.model_id);
      const sym = String(cand.asset_symbol);
      const horiz = Number(cand.duration_value ?? cand.horizon_ticks ?? 5);
      const unit = String(cand.duration_unit || 't');
      const champ = championMap.get(`${sym}:${horiz}`) || null;

      const mMetrics = (cand.metrics as Record<string, unknown> | null) || {};
      const cMetrics = (champ?.metrics as Record<string, unknown> | null) || {};

      const candAccuracy = Number.isFinite(Number(mMetrics.accuracy)) ? Number(mMetrics.accuracy) : null;
      const candF1 = Number.isFinite(Number(mMetrics.f1)) ? Number(mMetrics.f1) : null;
      const candLogLoss = Number.isFinite(Number(mMetrics.logLoss)) ? Number(mMetrics.logLoss) : null;

      const champAccuracy = Number.isFinite(Number(cMetrics.accuracy)) ? Number(cMetrics.accuracy) : null;
      const champF1 = Number.isFinite(Number(cMetrics.f1)) ? Number(cMetrics.f1) : null;

      const { definition } = await resolveCanonicalModelDefinition(sql, cand);
      const persistedLifecycleTier = String((mMetrics as any)?.lifecycleTier || '').toLowerCase();
      const lifecycleTier = persistedLifecycleTier || String(definition?.lifecycleTier || '').toLowerCase();

      const artifactHealthy = await hasModelArtifact(mId);

      const governance = evaluateChampionChallengerPromotion(
        { metrics: { accuracy: candAccuracy, f1: candF1 } },
        champ ? { metrics: { accuracy: champAccuracy, f1: champF1 } } : null
      );

      const isEligible =
        lifecycleTier === 'production_candidate' &&
        artifactHealthy &&
        Boolean(cand.strategy_key) &&
        governance.eligible;

      let disqualificationReason = '';
      if (lifecycleTier !== 'production_candidate') {
        disqualificationReason = 'Experimental model tier (isolated from production)';
      } else if (!artifactHealthy) {
        disqualificationReason = 'Durable native artifact missing or unverified';
      } else if (!governance.eligible) {
        disqualificationReason = governance.reason;
      }

      const item: EligibleCandidateModel = {
        modelId: mId,
        symbol: sym,
        assetDisplayName: getSymbolDisplayName(sym),
        horizonSecs: horiz,
        durationValue: horiz,
        durationUnit: unit,
        modelFamily: String(cand.model_family || 'ML'),
        framework: String(cand.framework || cand.model_family || 'Native'),
        candidateStatus: String(cand.status),
        strategyKey: String(cand.strategy_key || 'standard'),
        trainingRunId: cand.training_run_id ? String(cand.training_run_id) : null,
        datasetId: cand.dataset_id ? String(cand.dataset_id) : null,
        metrics: {
          accuracy: candAccuracy,
          f1: candF1,
          logLoss: candLogLoss,
          trainedAt: cand.updated_at ? new Date(cand.updated_at).toISOString() : null,
        },
        champion: champ ? {
          modelId: String(champ.model_id),
          modelFamily: String(champ.model_family || ''),
          framework: String(champ.framework || ''),
          accuracy: champAccuracy,
          f1: champF1,
          status: String(champ.status),
        } : null,
        governance: {
          eligible: isEligible,
          reason: governance.reason,
          accuracyDelta: governance.accuracyDelta,
          f1Delta: governance.f1Delta,
          isInitialChampion: !champ,
        },
        artifactHealthy,
      };

      if (isEligible) {
        eligibleList.push(item);
      } else {
        ineligibleList.push({
          ...item,
          rejectionReason: disqualificationReason || governance.reason,
        });
      }
    }

    // Calculate aggregated metrics for eligible models
    const avgAccDelta = eligibleList.length > 0
      ? eligibleList.reduce((acc, c) => acc + (c.governance.accuracyDelta ?? 0), 0) / eligibleList.length
      : 0;
    const avgF1Delta = eligibleList.length > 0
      ? eligibleList.reduce((acc, c) => acc + (c.governance.f1Delta ?? 0), 0) / eligibleList.length
      : 0;

    const affectedSymbols = Array.from(new Set(eligibleList.map(m => m.symbol)));

    return NextResponse.json({
      success: true,
      totalCandidates: candidateRows.length,
      eligibleCount: eligibleList.length,
      ineligibleCount: ineligibleList.length,
      affectedSymbols,
      metricsSummary: {
        averageAccuracyGain: avgAccDelta,
        averageF1Gain: avgF1Delta,
      },
      eligible: eligibleList,
      ineligible: ineligibleList,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || 'Failed to evaluate eligible models.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { modelIds, force = false } = body;

    let targetIds: string[] = [];
    if (Array.isArray(modelIds) && modelIds.length > 0) {
      targetIds = modelIds.map(String);
    } else {
      // If no specific modelIds provided, fetch all currently eligible models server-side
      const sql = getDb();
      if (!sql) return NextResponse.json({ success: false, error: 'Database unavailable.' }, { status: 503 });

      const candidateRows = await sql`
        SELECT model_id, asset_symbol, horizon_ticks, duration_value, duration_unit,
               model_family, framework, metrics, status, dataset_id, training_run_id,
               strategy_key, strategy_version, feature_schema_version
        FROM ml_model_registry_v2
        WHERE status IN ('candidate', 'staging')
      `;
      const championRows = await sql`
        SELECT model_id, asset_symbol, horizon_ticks, duration_value, duration_unit,
               metrics, status
        FROM ml_model_registry_v2
        WHERE status = 'production'
      `;
      const champMap = new Map<string, any>();
      for (const champ of championRows) {
        champMap.set(`${champ.asset_symbol}:${champ.duration_value ?? champ.horizon_ticks ?? 5}`, champ);
      }

      for (const cand of candidateRows) {
        const mId = String(cand.model_id);
        const sym = String(cand.asset_symbol);
        const horiz = Number(cand.duration_value ?? cand.horizon_ticks ?? 5);
        const champ = champMap.get(`${sym}:${horiz}`) || null;

        const mMetrics = (cand.metrics as Record<string, unknown> | null) || {};
        const cMetrics = (champ?.metrics as Record<string, unknown> | null) || {};

        const candAcc = Number.isFinite(Number(mMetrics.accuracy)) ? Number(mMetrics.accuracy) : null;
        const candF1 = Number.isFinite(Number(mMetrics.f1)) ? Number(mMetrics.f1) : null;
        const champAcc = Number.isFinite(Number(cMetrics.accuracy)) ? Number(cMetrics.accuracy) : null;
        const champF1 = Number.isFinite(Number(cMetrics.f1)) ? Number(cMetrics.f1) : null;

        const { definition } = await resolveCanonicalModelDefinition(sql, cand);
        const persistedTier = String((mMetrics as any)?.lifecycleTier || '').toLowerCase();
        const tier = persistedTier || String(definition?.lifecycleTier || '').toLowerCase();

        const healthy = await hasModelArtifact(mId);
        const gov = evaluateChampionChallengerPromotion(
          { metrics: { accuracy: candAcc, f1: candF1 } },
          champ ? { metrics: { accuracy: champAcc, f1: champF1 } } : null
        );

        if (tier === 'production_candidate' && healthy && gov.eligible) {
          targetIds.push(mId);
        }
      }
    }

    if (!targetIds.length) {
      return NextResponse.json({
        success: false,
        promotedCount: 0,
        totalInSuite: 0,
        results: [],
        error: 'No eligible candidate models found to promote.',
      }, { status: 400 });
    }

    const promotionResult = await promoteSuiteInRegistry({
      modelIds: targetIds,
      force,
    });

    return NextResponse.json(promotionResult, {
      status: promotionResult.success ? 200 : 400,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || 'Batch promotion failed.' }, { status: 500 });
  }
}
