type Sql = any;

/**
 * Durable storage for a governed set of horizons that may share one model artifact.
 *
 * A cohort is deliberately separate from training_datasets: existing datasets remain
 * independently auditable, while the cohort records the exact dataset lineage used
 * by a future multi-horizon training run.
 */
export async function ensureMlHorizonCohortSchema(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS ml_horizon_cohorts (
    cohort_id UUID PRIMARY KEY,
    asset_symbol VARCHAR(64) NOT NULL,
    model_family VARCHAR(64) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'draft',
    feature_schema_version VARCHAR(128) NOT NULL,
    pipeline_version VARCHAR(128) NOT NULL,
    feature_window_ticks INTEGER NOT NULL,
    feature_order JSONB NOT NULL DEFAULT '[]'::jsonb,
    horizons JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS ml_horizon_cohort_datasets (
    cohort_id UUID NOT NULL REFERENCES ml_horizon_cohorts(cohort_id) ON DELETE CASCADE,
    dataset_id UUID NOT NULL REFERENCES training_datasets(id) ON DELETE RESTRICT,
    horizon_key VARCHAR(32) NOT NULL,
    effective_horizon_ticks INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (cohort_id, horizon_key),
    UNIQUE (cohort_id, dataset_id)
  )`;

  await sql`CREATE INDEX IF NOT EXISTS idx_ml_horizon_cohorts_asset_status
    ON ml_horizon_cohorts (asset_symbol, status, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_horizon_cohort_datasets_dataset
    ON ml_horizon_cohort_datasets (dataset_id)`;
}
