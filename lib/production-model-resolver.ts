import { getDb, initDbSchema } from './db';
import { getMlModelDefinition } from './ml-model-registry';
import { getModelArtifactStatus, hasModelArtifact, materializeModelArtifact } from './ml-model-artifact-store';

export type ProductionModelResolution = {
  modelId: string;
  modelKey: string;
  modelFamily: string;
  symbol: string;
  durationValue: number;
  durationUnit: string;
  durationSeconds: number | null;
  horizonTicks: number | null;
  trainingRunId: string;
  datasetId: string | null;
  featureSchemaVersion: string;
  framework: string;
  format: string;
  strategyKey?: string;
  isMultiHorizon?: boolean;
  validation: Record<string, unknown>;
  artifactPresent: boolean;
  lifecycleStatus: 'production';
  qualityScore: number;
  accuracyScore: number;
  aucScore: number;
  brierScore: number;
  winRateScore: number;
  liveWinRate: number | null;
  sampleCount: number;
  driftBreached: boolean;
  championRank: number;
  subModels?: ProductionModelResolution[];
};

function requireMetric(metrics: Record<string, unknown>, key: string, modelId: string): number {
  const value = Number(metrics[key]);
  if (!Number.isFinite(value)) throw new Error(`MODEL_VALIDATION_METRIC_UNAVAILABLE:${modelId}:${key}`);
  return value;
}

function normalizeMetric(value: number, key: string, modelId: string): number {
  let normalized = Number(value);
  if (Number.isFinite(normalized) && ['accuracy', 'winRate'].includes(key) && normalized > 1 && normalized <= 100) normalized /= 100;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new Error(`MODEL_VALIDATION_METRIC_INVALID:${modelId}:${key}`);
  }
  return normalized;
}

export function calculateCompositeQualityScore(params: {
  accuracy?: number | null;
  auc?: number | null;
  brierScore?: number | null;
  winRate?: number | null;
  liveWinRate?: number | null;
  sampleCount?: number;
  horizonDiff?: number;
}): {
  qualityScore: number;
  accuracy: number;
  auc: number;
  brierScore: number;
  winRate: number;
  driftBreached: boolean;
} {
  const acc = normalizeMetric(Number(params.accuracy), 'accuracy', 'UNKNOWN');
  const auc = normalizeMetric(Number(params.auc), 'auc', 'UNKNOWN');
  const brier = normalizeMetric(Number(params.brierScore), 'brierScore', 'UNKNOWN');
  const win = normalizeMetric(Number(params.winRate), 'winRate', 'UNKNOWN');

  const sampleCount = Number(params.sampleCount);
  if (!Number.isInteger(sampleCount) || sampleCount < 0) throw new Error('MODEL_SAMPLE_COUNT_INVALID');

  const baseScore = (acc * 0.35) + (auc * 0.35) + ((1 - brier) * 0.20) + (win * 0.10);
  let driftPenalty = 1.0;
  let driftBreached = false;
  const liveWinRate = params.liveWinRate ?? null;
  if (liveWinRate !== null) {
    if (!Number.isFinite(liveWinRate) || liveWinRate < 0 || liveWinRate > 1) throw new Error('LIVE_WIN_RATE_INVALID');
    if (sampleCount === 0) throw new Error('LIVE_WIN_RATE_SAMPLE_COUNT_UNAVAILABLE');
    if (liveWinRate < 0.52) {
      driftBreached = true;
      driftPenalty = 0.40;
    } else {
      driftPenalty = 1.0 + Math.min(0.20, Math.max(0, (liveWinRate - win)) * 0.5);
    }
  }

  const diffSec = Number(params.horizonDiff);
  if (!Number.isFinite(diffSec) || diffSec < 0) throw new Error('HORIZON_DISTANCE_INVALID');
  const proximityFactor = Math.exp(-0.01 * diffSec);
  const qualityScore = Number((baseScore * driftPenalty * proximityFactor).toFixed(4));
  if (!Number.isFinite(qualityScore) || qualityScore <= 0) throw new Error('MODEL_QUALITY_SCORE_INVALID');

  return { qualityScore, accuracy: acc, auc, brierScore: brier, winRate: win, driftBreached };
}

export function inferModelKeyFromRow(row: {
  model_id?: unknown;
  model_family?: unknown;
  framework?: unknown;
  metrics?: any;
}): string | null {
  const metrics = row.metrics && typeof row.metrics === 'object' ? row.metrics : {};
  const persistedKey = String(metrics.modelKey || '').trim().toLowerCase();
  if (persistedKey && getMlModelDefinition(persistedKey)) return persistedKey;
  const familyKey = String(row.model_family || '').trim().toLowerCase();
  if (familyKey && getMlModelDefinition(familyKey)) return familyKey;
  const searchTarget = `${row.model_id || ''} ${row.framework || ''} ${metrics.engine || ''} ${metrics.modelName || ''}`.toLowerCase();
  if (searchTarget.includes('xgboost')) return 'xgboost';
  if (searchTarget.includes('lightgbm')) return 'lightgbm';
  if (searchTarget.includes('catboost')) return 'catboost';
  if (searchTarget.includes('tcn')) return 'tcn';
  if (searchTarget.includes('lstm')) return 'lstm';
  if (searchTarget.includes('transformer')) return 'transformer';
  if (searchTarget.includes('hmm')) return 'hmm';
  if (searchTarget.includes('isolation_forest') || searchTarget.includes('isolationforest')) return 'isolation_forest';
  if (familyKey === 'tabular') return 'xgboost';
  if (familyKey === 'sequential') return 'lstm';
  return null;
}

function normalizeDurationUnit(unit: string): string {
  switch (String(unit).toLowerCase()) {
    case 't': return 't';
    case 's':
    case 'sec': return 's';
    case 'm':
    case 'min': return 'm';
    case 'h':
    case 'hour':
    case 'hr': return 'h';
    case 'd':
    case 'day': return 'd';
    default: throw new Error(`MODEL_DURATION_UNIT_INVALID:${unit}`);
  }
}

function durationDomain(unit: string): 'tick' | 'time' {
  return normalizeDurationUnit(unit) === 't' ? 'tick' : 'time';
}

function durationToSec(value: number, unit: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('MODEL_DURATION_INVALID');
  switch (normalizeDurationUnit(unit)) {
    case 't':
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: throw new Error(`MODEL_DURATION_UNIT_INVALID:${unit}`);
  }
}

function findAuthoritativeHorizonMetrics(metrics: Record<string, unknown>, row: any, requestedSeconds: number, requestedUnit: string, modelId: string): Record<string, unknown> {
  const horizonMetrics = metrics.horizonMetrics;
  if (!horizonMetrics || typeof horizonMetrics !== 'object' || Array.isArray(horizonMetrics)) {
    throw new Error(`AUTHORITATIVE_HORIZON_METRICS_UNAVAILABLE:${modelId}`);
  }

  const map = horizonMetrics as Record<string, unknown>;
  const rowKey = `${Math.trunc(Number(row.duration_value))}${normalizeDurationUnit(String(row.duration_unit))}`.toLowerCase();
  const direct = map[rowKey];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Record<string, unknown>;

  for (const value of Object.values(map)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const metric = value as Record<string, unknown>;
    const metricValue = Number(metric.durationValue);
    const metricUnit = String(metric.durationUnit || '').trim();
    if (
      Number.isFinite(metricValue) &&
      metricUnit &&
      durationDomain(metricUnit) === durationDomain(requestedUnit) &&
      durationToSec(metricValue, metricUnit) === requestedSeconds
    ) {
      return metric;
    }
  }

  throw new Error(`AUTHORITATIVE_HORIZON_METRIC_MISSING:${modelId}:${rowKey}`);
}

export async function resolveProductionModels(symbol: string, durationValue: number, durationUnit: string): Promise<Record<string, ProductionModelResolution>> {
  if (!(await initDbSchema())) throw new Error('PRODUCTION_MODEL_REGISTRY_UNAVAILABLE');
  const sql = getDb();
  if (!sql) throw new Error('PRODUCTION_MODEL_REGISTRY_UNAVAILABLE');
  const reqSec = durationToSec(durationValue, durationUnit);
  const reqDomain = durationDomain(durationUnit);
  const rows = await sql`
    SELECT model_id, model_family, asset_symbol, duration_value, duration_unit,
           duration_seconds, horizon_ticks, feature_schema_version, framework,
           training_run_id, dataset_id, metrics, format, strategy_key, updated_at
    FROM ml_model_registry_v2
    WHERE asset_symbol = ${symbol}::varchar
      AND status = 'production'
    ORDER BY updated_at DESC
  `;

  const liveStatsMap: Record<string, { total: number; wins: number; winRate: number | null }> = {};
  const liveStats = await sql`
    SELECT model_id,
           COUNT(*)::int AS total,
           COUNT(CASE WHEN status IN ('WON', 'WIN', 'won', 'win') THEN 1 END)::int AS wins
    FROM execution_trades
    WHERE asset_symbol = ${symbol}::varchar
      AND status IN ('WON', 'LOST', 'WIN', 'LOSS', 'won', 'lost')
    GROUP BY model_id
  `;
  for (const s of liveStats as any[]) {
    const modelId = String(s.model_id);
    const total = Number(s.total);
    const wins = Number(s.wins);
    if (!Number.isInteger(total) || total < 0 || !Number.isInteger(wins) || wins < 0 || wins > total) throw new Error(`LIVE_MODEL_STATS_INVALID:${modelId}`);
    liveStatsMap[modelId] = { total, wins, winRate: total > 0 ? wins / total : null };
  }

  type ProcessedCandidate = { modelKey: string; resolution: ProductionModelResolution };
  const groupedCandidates: Record<string, ProcessedCandidate[]> = {};

  for (const row of rows as any[]) {
    const rowUnit = normalizeDurationUnit(String(row.duration_unit));
    if (durationDomain(rowUnit) !== reqDomain) continue;
    const rowSec = row.duration_seconds != null
      ? Number(row.duration_seconds)
      : durationToSec(Number(row.duration_value), rowUnit);
    if (!Number.isFinite(rowSec) || rowSec <= 0) throw new Error(`MODEL_DURATION_METADATA_INVALID:${row.model_id}`);
    if (rowSec !== reqSec) continue;

    const modelKey = inferModelKeyFromRow(row);
    if (!modelKey) continue;
    const definition = getMlModelDefinition(modelKey);
    if (!definition) continue;

    const modelId = String(row.model_id || '').trim();
    const trainingRunId = String(row.training_run_id || '').trim();
    const datasetId = row.dataset_id ? String(row.dataset_id).trim() : '';
    const featureSchemaVersion = String(row.feature_schema_version || '').trim();
    if (!modelId || !trainingRunId || !datasetId || !featureSchemaVersion) {
      throw new Error(`PRODUCTION_MODEL_METADATA_INCOMPLETE:${modelId || 'UNKNOWN'}`);
    }

    const storedMetrics = row.metrics && typeof row.metrics === 'object' && !Array.isArray(row.metrics)
      ? row.metrics as Record<string, unknown>
      : {};
    const isMultiHorizon = row.strategy_key === 'unified_multi_horizon' || Boolean(storedMetrics.trainedOnceForMultiHorizon);
    const validationMetrics = isMultiHorizon
      ? findAuthoritativeHorizonMetrics(storedMetrics, row, reqSec, durationUnit, modelId)
      : storedMetrics;

    const accuracy = requireMetric(validationMetrics, 'accuracy', modelId);
    const auc = requireMetric(validationMetrics, 'auc', modelId);
    const brierScore = requireMetric(validationMetrics, 'brierScore', modelId);
    const winRate = requireMetric(validationMetrics, 'winRate', modelId);

    const liveStat = liveStatsMap[modelId];
    const scoreResult = calculateCompositeQualityScore({
      accuracy,
      auc,
      brierScore,
      winRate,
      liveWinRate: liveStat?.winRate ?? null,
      sampleCount: liveStat?.total ?? 0,
      horizonDiff: 0,
    });

    const artifactPresent = await hasModelArtifact(modelId);
    if (!artifactPresent) throw new Error(`PRODUCTION_MODEL_ARTIFACT_MISSING:${modelId}`);

    const validation = isMultiHorizon
      ? { ...storedMetrics, ...validationMetrics, horizonMetrics: storedMetrics.horizonMetrics, activeHorizonKey: `${Math.trunc(Number(row.duration_value))}${rowUnit}`.toLowerCase() }
      : storedMetrics;

    const resolution: ProductionModelResolution = {
      modelId,
      modelKey,
      modelFamily: String(row.model_family || definitionFamily(modelKey)),
      symbol: String(row.asset_symbol),
      durationValue: Number(row.duration_value),
      durationUnit: String(row.duration_unit),
      durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
      horizonTicks: row.horizon_ticks == null ? null : Number(row.horizon_ticks),
      trainingRunId,
      datasetId,
      featureSchemaVersion,
      framework: String(row.framework || '').trim(),
      format: String(row.format || '').trim(),
      strategyKey: String(row.strategy_key || '').trim(),
      isMultiHorizon,
      validation,
      artifactPresent: true,
      lifecycleStatus: 'production',
      qualityScore: scoreResult.qualityScore,
      accuracyScore: scoreResult.accuracy,
      aucScore: scoreResult.auc,
      brierScore: scoreResult.brierScore,
      winRateScore: scoreResult.winRate,
      liveWinRate: liveStat?.winRate ?? null,
      sampleCount: liveStat?.total ?? 0,
      driftBreached: scoreResult.driftBreached,
      championRank: 1,
    };

    if (!groupedCandidates[modelKey]) groupedCandidates[modelKey] = [];
    groupedCandidates[modelKey].push({ modelKey, resolution });
  }

  const resolved: Record<string, ProductionModelResolution> = {};
  for (const modelKey of Object.keys(groupedCandidates)) {
    const candidates = groupedCandidates[modelKey];
    if (!candidates.length) continue;
    candidates.sort((a, b) => b.resolution.qualityScore - a.resolution.qualityScore);
    candidates.forEach((candidate, idx) => { candidate.resolution.championRank = idx + 1; });
    const champion = candidates[0].resolution;
    champion.subModels = candidates.slice(0, 3).map((candidate) => {
      const { subModels: _discard, ...clean } = candidate.resolution;
      return clean;
    });
    resolved[modelKey] = champion;
  }

  if (!Object.keys(resolved).length) throw new Error(`NO_VALIDATED_PRODUCTION_MODELS:${symbol}:${Math.trunc(durationValue)}${normalizeDurationUnit(durationUnit)}`);
  return resolved;
}

function definitionFamily(modelKey: string): string {
  const def = getMlModelDefinition(modelKey);
  return def?.family || 'tabular';
}

export async function resolveAndMaterializeProductionModel(model: ProductionModelResolution) {
  if (!model.artifactPresent || !model.trainingRunId || !model.datasetId || !model.featureSchemaVersion) {
    throw new Error(`PRODUCTION_MODEL_NOT_EXECUTION_READY:${model.modelId}`);
  }
  return materializeModelArtifact(model.modelId);
}

export async function getProductionModelHealth(symbol?: string) {
  if (!(await initDbSchema())) throw new Error('PRODUCTION_MODEL_REGISTRY_UNAVAILABLE');
  const sql = getDb();
  if (!sql) throw new Error('PRODUCTION_MODEL_REGISTRY_UNAVAILABLE');
  const rows = symbol
    ? await sql`
        SELECT model_id, model_family, asset_symbol, duration_value, duration_unit,
               duration_seconds, training_run_id, dataset_id, feature_schema_version,
               framework, format, status, metrics, updated_at
        FROM ml_model_registry_v2
        WHERE status = 'production' AND asset_symbol = ${symbol}::varchar
        ORDER BY asset_symbol, duration_value, duration_unit, updated_at DESC
      `
    : await sql`
        SELECT model_id, model_family, asset_symbol, duration_value, duration_unit,
               duration_seconds, training_run_id, dataset_id, feature_schema_version,
               framework, format, status, metrics, updated_at
        FROM ml_model_registry_v2
        WHERE status = 'production'
        ORDER BY asset_symbol, duration_value, duration_unit, updated_at DESC
      `;

  return Promise.all((rows as any[]).map(async (row) => {
    const modelId = String(row.model_id || '').trim();
    const artifactStatus = await getModelArtifactStatus(modelId);
    const metrics = row.metrics && typeof row.metrics === 'object' ? row.metrics : {};
    const modelKey = inferModelKeyFromRow(row) || String(metrics.modelKey || row.model_family || '').trim().toLowerCase();
    const definition = getMlModelDefinition(modelKey);
    const trainingRunId = String(row.training_run_id || '').trim();
    const datasetId = row.dataset_id ? String(row.dataset_id).trim() : '';
    const featureSchemaVersion = String(row.feature_schema_version || '').trim();
    return {
      modelId,
      modelKey,
      modelName: definition?.displayName || String(row.model_family || 'Unknown model'),
      symbol: String(row.asset_symbol),
      duration: { value: Number(row.duration_value), unit: String(row.duration_unit), seconds: row.duration_seconds == null ? null : Number(row.duration_seconds) },
      trainingRunId: trainingRunId || null,
      datasetId: datasetId || null,
      featureSchemaVersion: featureSchemaVersion || null,
      framework: String(row.framework || ''),
      format: String(row.format || ''),
      status: String(row.status),
      artifact: { status: artifactStatus, present: artifactStatus === 'active' || artifactStatus === 'superseded' },
      validation: { accuracy: metrics.accuracy ?? null, f1: metrics.f1 ?? metrics.f1Score ?? null, logLoss: metrics.logLoss ?? null },
      updatedAt: row.updated_at,
      healthy: (artifactStatus === 'active' || artifactStatus === 'superseded') && Boolean(trainingRunId) && Boolean(datasetId) && Boolean(featureSchemaVersion),
    };
  }));
}
