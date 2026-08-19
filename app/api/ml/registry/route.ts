import { NextRequest, NextResponse } from 'next/server';
import { getRegisteredModels, promoteModelInRegistry, initDbSchema, getDb } from '@/lib/db';
import { getMlModelDefinition, getAllMlModelKeys } from '@/lib/ml-model-registry';
import { promoteSuiteInRegistry } from '@/lib/ml-suite-promoter';
import { verifySessionToken } from '../../admin/auth/route';
import { evaluateChampionChallengerPromotion } from '@/lib/champion-challenger-governance';
import { hasModelArtifact } from '@/lib/ml-model-artifact-store';
import { retireProductionModel } from '@/lib/ml-model-retirement';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

function readableAssetName(symbol: string, storedDisplayName?: unknown): string {
  const stored = String(storedDisplayName || '').trim();
  if (stored) return stored;
  const oneSecondVolatility = /^1HZ(\d+)V$/i.exec(symbol);
  if (oneSecondVolatility) return `Volatility ${oneSecondVolatility[1]} (1s) Index`;
  const volatility = /^R_(\d+)$/i.exec(symbol);
  if (volatility) return `Volatility ${volatility[1]} Index`;
  return symbol.replace(/_/g, ' ');
}

function normalizeRegistryModel(model: Record<string, any>) {
  const rawSymbol = String(model.asset_symbol || model.symbol || '').trim();
  const rawModelFamily = String(model.model_family || '').trim();
  const persistedModelKey = String((model.metrics as Record<string, unknown> | null)?.modelKey || '').trim().toLowerCase();
  const definition = getMlModelDefinition(persistedModelKey) || getMlModelDefinition(rawModelFamily.toLowerCase());
  const horizonTicks = Number(model.horizon_ticks ?? model.horizon_secs);
  return {
    ...model,
    symbol: rawSymbol || undefined,
    horizon_secs: Number.isFinite(horizonTicks) ? horizonTicks : undefined,
    model_name: definition?.displayName || rawModelFamily || model.model_name || 'Unknown model',
    raw_symbol: rawSymbol || undefined,
    raw_model_family: rawModelFamily || undefined,
    raw_horizon_ticks: Number.isFinite(horizonTicks) ? horizonTicks : undefined,
    asset_display_name: readableAssetName(rawSymbol, model.asset_display_name),
  };
}

async function resolveCanonicalModelDefinition(sql: any, registered: Record<string, any>) {
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
  const rows = await sql`
    SELECT model_type
    FROM ml_training_run_models
    WHERE run_id = ${trainingRunId}::uuid
      AND model_id = ${modelId}
    LIMIT 1
  `;
  const modelKey = String(rows[0]?.model_type || '').trim().toLowerCase();
  const definition = modelKey ? getMlModelDefinition(modelKey) : undefined;
  return { definition, modelKey, source: 'training-run-lineage' as const };
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });
  try {
    const dbReady = await initDbSchema();
    if (!dbReady) return NextResponse.json({ success: false, models: [], count: 0, dataSource: 'database-unavailable', error: 'Model registry database is unavailable; no synthetic registry entries are returned.' }, { status: 503 });
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol') || undefined;
    const status = searchParams.get('status') || undefined;
    const models = await getRegisteredModels(symbol, status);
    return NextResponse.json({ success: true, count: models?.length || 0, models: (models || []).map((model: Record<string, any>) => normalizeRegistryModel(model)), dataSource: 'live-database' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || 'Failed to fetch model registry' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthValid(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });
  try {
    const dbReady = await initDbSchema();
    if (!dbReady) return NextResponse.json({ success: false, error: 'Model registry database is unavailable.' }, { status: 503 });
    const body = await req.json().catch(() => ({}));
    const { action, modelId, symbol, horizonSecs } = body;
    if (action === 'initialize' || action === 'seed') return NextResponse.json({ success: false, error: 'Synthetic/default model registration is disabled. Register only models backed by real trained artifacts and measured validation metrics.' }, { status: 410 });

    if (action === 'retire') {
      if (!modelId || typeof modelId !== 'string') return NextResponse.json({ success: false, error: 'Missing or invalid modelId.' }, { status: 400 });
      try {
        const result = await retireProductionModel(modelId, 'admin');
        return NextResponse.json({ success: true, ...result });
      } catch (error: any) {
        const code = String(error?.message || 'MODEL_RETIREMENT_FAILED');
        if (code === 'MODEL_NOT_FOUND') return NextResponse.json({ success: false, error: 'Model retirement rejected: model is not registered.' }, { status: 404 });
        if (code.startsWith('MODEL_NOT_PRODUCTION:')) return NextResponse.json({ success: false, error: `Model retirement rejected: status ${code.split(':')[1] || 'unknown'} is not production.` }, { status: 409 });
        if (code === 'MODEL_RETIREMENT_CONFLICT') return NextResponse.json({ success: false, error: 'Model retirement conflicted with another lifecycle change. Refresh the registry and retry.' }, { status: 409 });
        if (code === 'DATABASE_UNAVAILABLE') return NextResponse.json({ success: false, error: 'Model registry database is unavailable.' }, { status: 503 });
        throw error;
      }
    }

    if (action === 'promote') {
      if (!modelId || typeof modelId !== 'string' || !symbol || typeof symbol !== 'string') return NextResponse.json({ error: 'Missing or invalid modelId or symbol.' }, { status: 400 });
      const horizon = Number(horizonSecs);
      if (!Number.isFinite(horizon) || horizon <= 0) return NextResponse.json({ error: 'A positive numeric horizonSecs value is required.' }, { status: 400 });
      const sql = getDb();
      if (!sql) return NextResponse.json({ success: false, error: 'Model registry database is unavailable.' }, { status: 503 });
      const rows = await sql`
        SELECT model_id, asset_symbol, horizon_ticks, model_family, framework, metrics, status,
               dataset_id, training_run_id, strategy_key, strategy_version, feature_schema_version
        FROM ml_model_registry_v2 WHERE model_id = ${modelId} LIMIT 1
      `;
      const registered = rows[0] as any;
      if (!registered) return NextResponse.json({ success: false, error: 'Model promotion failed: model is not registered.' }, { status: 409 });
      if (String(registered.asset_symbol) !== symbol) return NextResponse.json({ success: false, error: 'Model promotion rejected: symbol does not match the persisted model lineage.' }, { status: 409 });
      if (Number(registered.horizon_ticks) !== horizon) return NextResponse.json({ success: false, error: 'Model promotion rejected: horizon does not match the persisted model lineage.' }, { status: 409 });

      const { definition, modelKey, source } = await resolveCanonicalModelDefinition(sql, registered);
      const persistedLifecycleTier = String((registered.metrics as Record<string, unknown> | null)?.lifecycleTier || '').toLowerCase();
      const lifecycleTier = persistedLifecycleTier || String(definition?.lifecycleTier || '').toLowerCase();
      if (lifecycleTier !== 'production_candidate') return NextResponse.json({ success: false, error: 'Model promotion rejected: experimental models must remain isolated from production.', lifecycleTier: lifecycleTier || 'unknown', modelKey: modelKey || null, lifecycleResolutionSource: source }, { status: 409 });
      const status = String(registered.status || '').toLowerCase(); if (!['candidate', 'staging'].includes(status)) return NextResponse.json({ success: false, error: `Model promotion rejected: status ${registered.status || 'unknown'} is not promotable.` }, { status: 409 });
      if (!registered.dataset_id || !registered.training_run_id || !registered.strategy_key || !registered.strategy_version || !registered.feature_schema_version) return NextResponse.json({ success: false, error: 'Model promotion rejected: complete training and strategy lineage is required.' }, { status: 409 });

      const persistedArtifact = await hasModelArtifact(String(modelId));
      if (!persistedArtifact) return NextResponse.json({ success: false, error: 'Model promotion rejected: durable trained artifact is missing. The model must be re-registered from a persisted native artifact before production promotion.', modelId, modelKey: modelKey || null }, { status: 409 });

      const championRows = await sql`
        SELECT model_id, metrics FROM ml_model_registry_v2
        WHERE asset_symbol = ${symbol} AND horizon_ticks = ${horizon}
          AND status = 'production' AND model_id <> ${modelId}
        ORDER BY updated_at DESC LIMIT 1
      `;
      const champion = championRows[0] as any | undefined;
      const governance = evaluateChampionChallengerPromotion(registered, champion ?? null);
      if (!governance.eligible) return NextResponse.json({ success: false, error: `Model promotion rejected: ${governance.reason}`, governance, championModelId: champion?.model_id || null }, { status: 409 });
      const success = await promoteModelInRegistry(modelId, symbol, horizon);
      if (!success) return NextResponse.json({ success: false, error: 'Model promotion failed or model is not registered.' }, { status: 409 });
      return NextResponse.json({ success: true, modelId, symbol, horizonSecs: horizon, status: 'production', promotedAt: new Date().toISOString(), governance, championModelId: champion?.model_id || null, modelKey: modelKey || null, lifecycleResolutionSource: source });
    }

    if (action === 'promote_suite' || action === 'promote_bulk') {
      const { modelIds, trainingRunId } = body;
      const res = await promoteSuiteInRegistry({ modelIds, trainingRunId });
      const statusCode = res.error && res.totalInSuite === 0 ? (res.error.includes('database is unavailable') ? 503 : 400) : 200;
      return NextResponse.json(res, { status: statusCode });
    }

    if (action === 'delete') {
      return NextResponse.json({ success: false, error: 'Direct registry deletion is disabled. Retire production models through the controlled lifecycle so lineage and audit history are preserved.' }, { status: 410 });
    }
    return NextResponse.json({ error: 'Invalid action.' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || 'Registry action failed' }, { status: 500 });
  }
}
