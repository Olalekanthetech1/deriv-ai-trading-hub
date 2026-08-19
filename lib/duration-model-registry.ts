import { neon } from '@neondatabase/serverless';
import { initDbSchema, getDbConnectionString } from './db';
import { ensureTrainingDurationSchema } from './training-duration-schema';
import { persistModelArtifact } from './ml-model-artifact-store';

export type DurationModelRegistration = {
  modelId: string;
  modelFamily: string;
  version: string;
  symbol: string;
  assetClass: string;
  durationValue: number;
  durationUnit: 't' | 's' | 'm' | 'h' | 'd';
  durationSeconds: number | null;
  effectiveHorizonTicks: number;
  datasetId: string;
  format: string;
  status: 'candidate' | 'staging' | 'production';
  featureSchemaVersion: string;
  framework: string;
  trainingRunId: string;
  strategyKey: string;
  strategyVersion: string;
  strategyMetadata: unknown;
  metrics: unknown;
  hyperparameters: unknown;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeUuid(value: string, fieldName: string): string {
  const normalized = String(value ?? '').trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`INVALID_${fieldName.toUpperCase()}_UUID`);
  }
  return normalized;
}

function metricsWithArtifactMetadata(value: unknown, artifact: { sha256: string; byteSize: number } | null) {
  const metrics = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  if (artifact) {
    metrics.artifactSha256 = artifact.sha256;
    metrics.artifactByteSize = artifact.byteSize;
    metrics.artifactStore = 'durable-postgres';
  }
  return metrics;
}

export async function registerDurationModel(data: DurationModelRegistration): Promise<void> {
  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  const sql = neon(url);
  await ensureTrainingDurationSchema(sql);

  const datasetId = normalizeUuid(data.datasetId, 'dataset_id');
  const trainingRunId = normalizeUuid(data.trainingRunId, 'training_run_id');
  const suppliedMetrics = data.metrics && typeof data.metrics === 'object' && !Array.isArray(data.metrics)
    ? data.metrics as Record<string, unknown>
    : {};
  const artifactPath = typeof suppliedMetrics.artifactPath === 'string' ? suppliedMetrics.artifactPath.trim() : '';

  const artifact = artifactPath ? await persistModelArtifact(data.modelId, artifactPath) : null;
  const metrics = metricsWithArtifactMetadata(suppliedMetrics, artifact);

  await sql`
    INSERT INTO ml_model_registry_v2 (
      model_id, model_family, version, asset_symbol, asset_class, horizon_ticks,
      duration_value, duration_unit, duration_seconds, horizon_type,
      dataset_id, format, status, feature_schema_version, framework, training_run_id,
      strategy_key, strategy_version, strategy_metadata, metrics, hyperparameters, updated_at
    ) VALUES (
      ${data.modelId}::text, ${data.modelFamily}::text, ${data.version}::text, ${data.symbol}::text, ${data.assetClass}::text, ${data.effectiveHorizonTicks}::integer,
      ${data.durationValue}::integer, ${data.durationUnit}::varchar, ${data.durationSeconds}::numeric, ${data.durationUnit === 't' ? 'tick' : 'time'}::varchar,
      ${datasetId}::uuid, ${data.format}::text, ${data.status}::varchar, ${data.featureSchemaVersion}::text, ${data.framework}::text, ${trainingRunId}::uuid,
      ${data.strategyKey}::text, ${data.strategyVersion}::text, ${JSON.stringify(data.strategyMetadata ?? {})}::jsonb,
      ${JSON.stringify(metrics)}::jsonb, ${JSON.stringify(data.hyperparameters ?? {})}::jsonb, NOW()
    )
    ON CONFLICT (model_id) DO UPDATE SET
      model_family = EXCLUDED.model_family,
      version = EXCLUDED.version,
      asset_symbol = EXCLUDED.asset_symbol,
      asset_class = EXCLUDED.asset_class,
      horizon_ticks = EXCLUDED.horizon_ticks,
      duration_value = EXCLUDED.duration_value,
      duration_unit = EXCLUDED.duration_unit,
      duration_seconds = EXCLUDED.duration_seconds,
      horizon_type = EXCLUDED.horizon_type,
      dataset_id = EXCLUDED.dataset_id,
      format = EXCLUDED.format,
      status = EXCLUDED.status,
      feature_schema_version = EXCLUDED.feature_schema_version,
      framework = EXCLUDED.framework,
      training_run_id = EXCLUDED.training_run_id,
      strategy_key = EXCLUDED.strategy_key,
      strategy_version = EXCLUDED.strategy_version,
      strategy_metadata = EXCLUDED.strategy_metadata,
      metrics = EXCLUDED.metrics,
      hyperparameters = EXCLUDED.hyperparameters,
      updated_at = NOW()
  `;
}
