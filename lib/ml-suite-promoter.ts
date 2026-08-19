import { getDb, promoteModelInRegistry } from '@/lib/db';
import { getMlModelDefinition, getAllMlModelKeys } from '@/lib/ml-model-registry';
import { evaluateChampionChallengerPromotion } from '@/lib/champion-challenger-governance';
import { hasModelArtifact } from '@/lib/ml-model-artifact-store';

export async function resolveCanonicalModelDefinition(sql: any, registered: Record<string, any>) {
  const metrics = registered.metrics as Record<string, unknown> | null;
  const persistedModelKey = typeof metrics?.modelKey === 'string' ? metrics.modelKey.trim().toLowerCase() : '';
  if (persistedModelKey) {
    const definition = getMlModelDefinition(persistedModelKey);
    if (definition) return { definition, modelKey: persistedModelKey, source: 'persisted-metadata' as const };
  }
  const frameworkKey = String(registered.framework || '').trim().toLowerCase();
  if (frameworkKey) {
    const definition = getMlModelDefinition(frameworkKey);
    if (definition) return { definition, modelKey: frameworkKey, source: 'registered-framework' as const };
  }
  const modelIdStr = String(registered.model_id || '').toLowerCase();
  const allKeys = getAllMlModelKeys();
  for (const k of allKeys) {
    if (modelIdStr.includes(`_${k}_`) || modelIdStr.endsWith(`_${k}`)) {
      const definition = getMlModelDefinition(k);
      if (definition) return { definition, modelKey: k, source: 'model-id-pattern' as const };
    }
  }
  const trainingRunId = String(registered.training_run_id || '').trim();
  const modelId = String(registered.model_id || '').trim();
  if (!trainingRunId || !modelId) return { definition: undefined, modelKey: '', source: 'unresolved' as const };
  try {
    const rows = await sql`
      SELECT model_type FROM ml_training_runs WHERE id = ${trainingRunId} OR id = ${modelId} LIMIT 1
    `;
    const modelType = String(rows[0]?.model_type || '').trim().toLowerCase();
    if (modelType) {
      const definition = getMlModelDefinition(modelType);
      if (definition) return { definition, modelKey: modelType, source: 'training-run-model-type' as const };
    }
  } catch {
    // fallback
  }
  return { definition: undefined, modelKey: '', source: 'unresolved' as const };
}

export interface PromoteSuiteParams {
  modelIds?: string[];
  trainingRunId?: string;
  force?: boolean;
}

export interface PromoteSuiteResult {
  success: boolean;
  promotedCount: number;
  totalInSuite: number;
  results: Array<{ modelId: string; horizon: number; success: boolean; error?: string }>;
  message?: string;
  error?: string;
}

export async function promoteSuiteInRegistry(params: PromoteSuiteParams): Promise<PromoteSuiteResult> {
  const { modelIds, trainingRunId, force = false } = params;
  const sql = getDb();
  if (!sql) {
    return { success: false, promotedCount: 0, totalInSuite: 0, results: [], error: 'Model registry database is unavailable.' };
  }

  let targets: any[] = [];
  if (Array.isArray(modelIds) && modelIds.length > 0) {
    targets = await sql`
      SELECT model_id, asset_symbol, horizon_ticks, model_family, framework, metrics, status,
             dataset_id, training_run_id, strategy_key, strategy_version, feature_schema_version
      FROM ml_model_registry_v2 WHERE model_id = ANY(${modelIds})
    `;
  } else if (trainingRunId && typeof trainingRunId === 'string') {
    const trIdStr = String(trainingRunId).trim();
    const prefix = `${trIdStr}%`;
    targets = await sql`
      SELECT model_id, asset_symbol, horizon_ticks, model_family, framework, metrics, status,
             dataset_id, training_run_id, strategy_key, strategy_version, feature_schema_version
      FROM ml_model_registry_v2
      WHERE model_id LIKE ${prefix}
         OR (training_run_id IS NOT NULL AND training_run_id::text = ${trIdStr})
    `;
  } else {
    return { success: false, promotedCount: 0, totalInSuite: 0, results: [], error: 'Missing modelIds array or trainingRunId string for suite promotion.' };
  }

  if (!targets.length) {
    return { success: false, promotedCount: 0, totalInSuite: 0, results: [], error: 'No registered models found matching suite criteria.' };
  }

  const results: Array<{ modelId: string; horizon: number; success: boolean; error?: string }> = [];
  let promotedCount = 0;

  for (const registered of targets) {
    const mId = String(registered.model_id);
    const horizon = Number(registered.horizon_ticks ?? 5);
    const sym = String(registered.asset_symbol);
    try {
      const { definition } = await resolveCanonicalModelDefinition(sql, registered);
      const persistedLifecycleTier = String((registered.metrics as Record<string, unknown> | null)?.lifecycleTier || '').toLowerCase();
      const lifecycleTier = persistedLifecycleTier || String(definition?.lifecycleTier || '').toLowerCase();

      if (lifecycleTier !== 'production_candidate') {
        results.push({ modelId: mId, horizon, success: false, error: 'Experimental model isolated from production.' });
        continue;
      }

      const currentStatus = String(registered.status || '').toLowerCase();
      if (currentStatus === 'production') {
        results.push({ modelId: mId, horizon, success: true });
        promotedCount++;
        continue;
      }

      if (!['candidate', 'staging'].includes(currentStatus)) {
        results.push({ modelId: mId, horizon, success: false, error: `Status ${registered.status} not promotable.` });
        continue;
      }

      const persistedArtifact = await hasModelArtifact(mId);
      if (!persistedArtifact) {
        results.push({ modelId: mId, horizon, success: false, error: 'Durable artifact missing.' });
        continue;
      }

      const championRows = await sql`
        SELECT model_id, metrics, framework, model_family FROM ml_model_registry_v2
        WHERE asset_symbol = ${sym} AND horizon_ticks = ${horizon}
          AND status = 'production' AND model_id <> ${mId}
          AND (
            (${registered.framework || null}::varchar IS NOT NULL AND framework = ${registered.framework || null})
            OR (${registered.model_family || null}::varchar IS NOT NULL AND model_family = ${registered.model_family || null})
          )
        ORDER BY updated_at DESC LIMIT 1
      `;
      const champion = championRows[0] as any | undefined;
      const governance = evaluateChampionChallengerPromotion(registered, champion ?? null);
      if (!governance.eligible && !force) {
        results.push({ modelId: mId, horizon, success: false, error: governance.reason });
        continue;
      }

      const ok = await promoteModelInRegistry(mId, sym, horizon, registered.framework || registered.model_family);
      if (ok) {
        results.push({ modelId: mId, horizon, success: true });
        promotedCount++;
      } else {
        results.push({ modelId: mId, horizon, success: false, error: 'Promotion update failed.' });
      }
    } catch (err: any) {
      results.push({ modelId: mId, horizon, success: false, error: err?.message || 'Failed' });
    }
  }

  return {
    success: promotedCount > 0,
    promotedCount,
    totalInSuite: targets.length,
    results,
    message: `Successfully promoted ${promotedCount} of ${targets.length} model horizons to Production Champion.`
  };
}
