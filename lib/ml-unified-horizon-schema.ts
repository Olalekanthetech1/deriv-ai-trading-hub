type Sql = any;

/**
 * Durable PostgreSQL schema for Unified Multi-Horizon Datasets and Training Models.
 */
export async function ensureUnifiedHorizonSchema(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS ml_unified_horizon_datasets (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    symbol VARCHAR(64) NOT NULL,
    horizons JSONB NOT NULL DEFAULT '[]'::jsonb,
    feature_schema_version VARCHAR(128) NOT NULL,
    pipeline_version VARCHAR(128) NOT NULL,
    window_ticks INTEGER NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    train_count INTEGER NOT NULL DEFAULT 0,
    validation_count INTEGER NOT NULL DEFAULT 0,
    test_count INTEGER NOT NULL DEFAULT 0,
    source_from TIMESTAMPTZ NOT NULL,
    source_to TIMESTAMPTZ NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'completed',
    checksum VARCHAR(128) NOT NULL,
    leakage_check_passed BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS ml_unified_horizon_samples (
    id BIGSERIAL PRIMARY KEY,
    dataset_id UUID NOT NULL REFERENCES ml_unified_horizon_datasets(id) ON DELETE CASCADE,
    sample_index INTEGER NOT NULL,
    split VARCHAR(16) NOT NULL,
    anchor_tick_epoch BIGINT NOT NULL,
    anchor_tick_time TIMESTAMPTZ NOT NULL,
    entry_price NUMERIC(30,12) NOT NULL,
    feature_vector JSONB NOT NULL,
    horizon_labels JSONB NOT NULL, -- map of { "1t": "RISE", "5t": "FALL", "60s": "RISE" }
    source_window_from_epoch BIGINT NOT NULL,
    source_window_to_epoch BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ml_unified_samples_unique UNIQUE (dataset_id, sample_index)
  )`;

  await sql`CREATE TABLE IF NOT EXISTS ml_unified_horizon_training_runs (
    run_id UUID PRIMARY KEY,
    dataset_id UUID NOT NULL REFERENCES ml_unified_horizon_datasets(id) ON DELETE RESTRICT,
    symbol VARCHAR(64) NOT NULL,
    model_type VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'running',
    horizons JSONB NOT NULL DEFAULT '[]'::jsonb,
    overall_accuracy NUMERIC(10,4),
    overall_log_loss NUMERIC(10,6),
    overall_f1 NUMERIC(10,6),
    horizon_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    artifact_path VARCHAR(255),
    error TEXT,
    fit_ms NUMERIC(12,3),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  await sql`CREATE INDEX IF NOT EXISTS idx_ml_unified_datasets_symbol
    ON ml_unified_horizon_datasets (symbol, status, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_unified_samples_lookup
    ON ml_unified_horizon_samples (dataset_id, split, sample_index)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_unified_runs_symbol
    ON ml_unified_horizon_training_runs (symbol, status, created_at DESC)`;
}
