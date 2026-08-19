import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
if (!DATABASE_URL) throw new Error('DATABASE_URL is required.');

const sql = neon(DATABASE_URL);

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeUnit(unit) {
  const value = String(unit || '').trim().toLowerCase();
  if (value === 'sec') return 's';
  if (value === 'min') return 'm';
  if (value === 'hr' || value === 'hour') return 'h';
  if (value === 'day') return 'd';
  if (['t', 's', 'm', 'h', 'd'].includes(value)) return value;
  return null;
}

function exactHorizonKey(value, unit) {
  const normalizedUnit = normalizeUnit(unit);
  const number = Number(value);
  if (!normalizedUnit || !Number.isInteger(number) || number <= 0) return null;
  return `${number}${normalizedUnit}`;
}

function hasCompleteMetric(metric) {
  if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return false;
  const required = ['accuracy', 'f1', 'logLoss', 'winRate', 'auc', 'brierScore', 'samples'];
  return required.every((key) => Number.isFinite(Number(metric[key])) && Number(metric[key]) >= 0);
}

function classify(row) {
  const metrics = parseObject(row.metrics);
  const unified = row.strategy_key === 'unified_multi_horizon' || metrics.trainedOnceForMultiHorizon === true;
  const hasTrainingRun = Boolean(row.training_run_id);
  const horizonKey = exactHorizonKey(row.duration_value, row.duration_unit);
  const horizonMetrics = metrics?.horizonMetrics;
  const exactMetric = horizonKey && horizonMetrics && typeof horizonMetrics === 'object' && !Array.isArray(horizonMetrics)
    ? horizonMetrics[horizonKey]
    : null;
  const hasCompleteMetrics = Boolean(horizonKey && hasCompleteMetric(exactMetric));

  if (!horizonKey) return 'invalid-horizon-metadata';
  if (hasCompleteMetrics) return 'already-valid';
  if (unified && hasTrainingRun) return 'unified-retrain';
  if (!unified && !hasTrainingRun) return 'legacy-retrain';
  if (unified && !hasTrainingRun) return 'unified-lineage-missing';
  return 'validation-retrain';
}

async function main() {
  const rows = await sql`
    SELECT
      model_id,
      asset_symbol,
      status,
      duration_value,
      duration_unit,
      strategy_key,
      strategy_version,
      training_run_id,
      metrics,
      created_at,
      updated_at
    FROM ml_model_registry_v2
    WHERE status = 'production'
    ORDER BY asset_symbol, duration_value, duration_unit, model_id
  `;

  const classified = rows.map((row) => ({
    modelId: String(row.model_id),
    assetSymbol: String(row.asset_symbol),
    durationValue: Number(row.duration_value),
    durationUnit: String(row.duration_unit || ''),
    horizonKey: exactHorizonKey(row.duration_value, row.duration_unit),
    strategyKey: row.strategy_key ? String(row.strategy_key) : null,
    strategyVersion: row.strategy_version ? String(row.strategy_version) : null,
    trainingRunId: row.training_run_id ? String(row.training_run_id) : null,
    classification: classify(row),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }));

  const groups = new Map();
  for (const item of classified) {
    const key = `${item.assetSymbol}|${item.horizonKey || `${item.durationValue}${item.durationUnit}`}`;
    const current = groups.get(key) || {
      assetSymbol: item.assetSymbol,
      durationValue: item.durationValue,
      durationUnit: item.durationUnit,
      horizonKey: item.horizonKey,
      modelCount: 0,
      modelIds: [],
      classifications: {},
      strategyKeys: new Set(),
      strategyVersions: new Set(),
    };
    current.modelCount += 1;
    current.modelIds.push(item.modelId);
    current.classifications[item.classification] = (current.classifications[item.classification] || 0) + 1;
    if (item.strategyKey) current.strategyKeys.add(item.strategyKey);
    if (item.strategyVersion) current.strategyVersions.add(item.strategyVersion);
    groups.set(key, current);
  }

  const summary = {};
  for (const item of classified) summary[item.classification] = (summary[item.classification] || 0) + 1;

  const canonicalQueue = [...groups.values()].map((group) => ({
    assetSymbol: group.assetSymbol,
    durationValue: group.durationValue,
    durationUnit: group.durationUnit,
    horizonKey: group.horizonKey,
    productionRecordCount: group.modelCount,
    modelIds: group.modelIds,
    classifications: group.classifications,
    strategyKeys: [...group.strategyKeys].sort(),
    strategyVersions: [...group.strategyVersions].sort(),
    requiresTraining: !group.classifications['already-valid'],
  })).sort((a, b) =>
    a.assetSymbol.localeCompare(b.assetSymbol) ||
    a.durationValue - b.durationValue ||
    a.durationUnit.localeCompare(b.durationUnit),
  );

  console.log(JSON.stringify({
    mode: 'audit-only',
    productionRegistryRows: classified.length,
    summary,
    canonicalAssetHorizonGroups: canonicalQueue.length,
    groupsRequiringTraining: canonicalQueue.filter((group) => group.requiresTraining).length,
    groups: canonicalQueue,
    note: 'This audit does not enqueue, retrain, promote, demote, or modify production state.',
  }, null, 2));
}

main().catch((error) => {
  console.error('[Retraining Manifest Audit] FAILED:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
