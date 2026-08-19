import crypto from 'crypto';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { getDbConnectionString } from './db';
import { buildMlHorizonCohort, createMlHorizonDescriptor, type MlHorizonCohort } from './ml-horizon-contract';
import { ensureMlHorizonCohortSchema } from './ml-horizon-cohort-schema';

type Sql = NeonQueryFunction<false, false>;

type CohortDatasetInput = {
  datasetId: string;
  durationValue: number;
  durationUnit: 't' | 's' | 'm' | 'h' | 'd';
};

function normalizeUuid(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(text)) throw new Error('INVALID_DATASET_ID');
  return text;
}

function normalizeModelFamily(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || !/^[a-z0-9_-]{1,64}$/.test(text)) throw new Error('INVALID_MODEL_FAMILY');
  return text;
}

/**
 * Creates a durable cohort from already-completed, structurally compatible
 * datasets. It does not train or promote anything.
 */
export async function createMlHorizonCohort(input: {
  assetSymbol: string;
  modelFamily: string;
  datasets: CohortDatasetInput[];
  metadata?: Record<string, unknown>;
}): Promise<{ cohortId: string; cohort: MlHorizonCohort }> {
  if (!Array.isArray(input.datasets) || input.datasets.length < 2) {
    throw new Error('HORIZON_COHORT_REQUIRES_AT_LEAST_TWO_DATASETS');
  }

  const url = getDbConnectionString();
  if (!url) throw new Error('DATABASE_UNAVAILABLE');
  const sql: Sql = neon(url);
  await ensureMlHorizonCohortSchema(sql);

  const ids = input.datasets.map((item) => normalizeUuid(item.datasetId));
  if (new Set(ids).size !== ids.length) throw new Error('DUPLICATE_COHORT_DATASET');

  const rows = await sql`
    SELECT id, asset_symbol, duration_value, duration_unit, horizon_ticks,
           status, leakage_check_passed, feature_schema_version, metadata
    FROM training_datasets
    WHERE id = ANY(${ids}::uuid[])
  `;
  if (rows.length !== ids.length) throw new Error('COHORT_DATASET_NOT_FOUND');

  const byId = new Map(rows.map((row: any) => [String(row.id), row]));
  const horizons = input.datasets.map((item) => {
    const row = byId.get(item.datasetId) as any;
    if (!row || String(row.asset_symbol).toUpperCase() !== String(input.assetSymbol).trim().toUpperCase()) {
      throw new Error('COHORT_DATASET_ASSET_MISMATCH');
    }
    if (row.status !== 'completed' || row.leakage_check_passed !== true) {
      throw new Error(`COHORT_DATASET_NOT_READY:${item.datasetId}`);
    }
    const storedValue = Number(row.duration_value);
    const storedUnit = String(row.duration_unit);
    if (storedValue !== Number(item.durationValue) || storedUnit !== item.durationUnit) {
      throw new Error(`COHORT_DATASET_DURATION_MISMATCH:${item.datasetId}`);
    }
    const ticks = Number(row.horizon_ticks);
    if (!Number.isSafeInteger(ticks) || ticks <= 0) throw new Error(`COHORT_DATASET_INVALID_HORIZON:${item.datasetId}`);
    return createMlHorizonDescriptor(Number(item.durationValue), item.durationUnit, ticks);
  });

  const cohort = buildMlHorizonCohort(input.assetSymbol, horizons);
  const cohortId = crypto.randomUUID();
  const modelFamily = normalizeModelFamily(input.modelFamily);
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};

  await sql.transaction((tx) => [
    tx`
      INSERT INTO ml_horizon_cohorts (
        cohort_id, asset_symbol, model_family, status,
        feature_schema_version, pipeline_version, feature_window_ticks,
        feature_order, horizons, metadata
      ) VALUES (
        ${cohortId}::uuid, ${cohort.symbol}::varchar, ${modelFamily}::varchar, 'draft'::varchar,
        ${cohort.featureSchemaVersion}::varchar, ${cohort.pipelineVersion}::varchar,
        ${cohort.featureWindowTicks}::integer, ${JSON.stringify(cohort.featureOrder)}::jsonb,
        ${JSON.stringify(cohort.horizons)}::jsonb, ${JSON.stringify(metadata)}::jsonb
      )
    `,
    ...input.datasets.map((dataset) => {
      const horizon = horizons.find((item) => item.key === `${Number(dataset.durationValue)}${dataset.durationUnit}`);
      if (!horizon) throw new Error('COHORT_HORIZON_MAPPING_FAILED');
      return tx`
        INSERT INTO ml_horizon_cohort_datasets (
          cohort_id, dataset_id, horizon_key, effective_horizon_ticks
        ) VALUES (
          ${cohortId}::uuid, ${normalizeUuid(dataset.datasetId)}::uuid,
          ${horizon.key}::varchar, ${horizon.effectiveHorizonTicks}::integer
        )
      `;
    }),
  ]);

  return { cohortId, cohort };
}
