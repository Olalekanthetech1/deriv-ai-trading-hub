type Sql = any;

/** Idempotent compatibility migration for duration-aware datasets/models and ML training audit records. */
export async function ensureTrainingDurationSchema(sql: Sql): Promise<void> {
  await sql`ALTER TABLE training_datasets ADD COLUMN IF NOT EXISTS duration_value INTEGER`;
  await sql`ALTER TABLE training_datasets ADD COLUMN IF NOT EXISTS duration_unit VARCHAR(8)`;
  await sql`ALTER TABLE training_datasets ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(20, 6)`;
  await sql`ALTER TABLE training_datasets ADD COLUMN IF NOT EXISTS horizon_type VARCHAR(16)`;
  await sql`ALTER TABLE training_datasets ADD COLUMN IF NOT EXISTS contract_type VARCHAR(64)`;
  await sql`UPDATE training_datasets SET duration_value = COALESCE(duration_value, horizon_ticks), duration_unit = COALESCE(duration_unit, 't'), horizon_type = COALESCE(horizon_type, 'tick') WHERE duration_value IS NULL OR duration_unit IS NULL OR horizon_type IS NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_training_datasets_asset_duration ON training_datasets (asset_symbol, duration_unit, duration_value, created_at DESC)`;

  await sql`ALTER TABLE ml_model_registry_v2 ADD COLUMN IF NOT EXISTS duration_value INTEGER`;
  await sql`ALTER TABLE ml_model_registry_v2 ADD COLUMN IF NOT EXISTS duration_unit VARCHAR(8)`;
  await sql`ALTER TABLE ml_model_registry_v2 ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(20, 6)`;
  await sql`ALTER TABLE ml_model_registry_v2 ADD COLUMN IF NOT EXISTS horizon_type VARCHAR(16)`;
  await sql`ALTER TABLE ml_model_registry_v2 ADD COLUMN IF NOT EXISTS contract_type VARCHAR(64)`;
  await sql`ALTER TABLE ml_model_registry_v2 ADD COLUMN IF NOT EXISTS strategy_key VARCHAR(160)`;
  await sql`ALTER TABLE ml_model_registry_v2 ADD COLUMN IF NOT EXISTS strategy_version VARCHAR(32)`;
  await sql`ALTER TABLE ml_model_registry_v2 ADD COLUMN IF NOT EXISTS strategy_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`;
  await sql`UPDATE ml_model_registry_v2 SET duration_value = COALESCE(duration_value, horizon_ticks), duration_unit = COALESCE(duration_unit, 't'), horizon_type = COALESCE(horizon_type, 'tick') WHERE duration_value IS NULL OR duration_unit IS NULL OR horizon_type IS NULL`;
  await sql`DROP INDEX IF EXISTS uq_production_model_asset_horizon`;
  await sql`DROP INDEX IF EXISTS uq_production_model_asset_duration`;
  await sql`CREATE INDEX IF NOT EXISTS idx_model_registry_production_asset_duration ON ml_model_registry_v2 (asset_symbol, duration_unit, duration_value, status, updated_at DESC) WHERE status = 'production'`;
  await sql`CREATE INDEX IF NOT EXISTS idx_model_registry_asset_duration ON ml_model_registry_v2 (asset_symbol, duration_unit, duration_value, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_model_registry_strategy ON ml_model_registry_v2 (strategy_key, strategy_version, updated_at DESC)`;

  await sql`ALTER TABLE ml_backtest_runs ADD COLUMN IF NOT EXISTS duration_value INTEGER`;
  await sql`ALTER TABLE ml_backtest_runs ADD COLUMN IF NOT EXISTS duration_unit VARCHAR(8)`;
  await sql`ALTER TABLE ml_backtest_runs ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(20, 6)`;
  await sql`ALTER TABLE ml_backtest_runs ADD COLUMN IF NOT EXISTS horizon_type VARCHAR(16)`;
  await sql`ALTER TABLE ml_backtest_runs ADD COLUMN IF NOT EXISTS contract_type VARCHAR(64)`;
  await sql`UPDATE ml_backtest_runs SET duration_value = COALESCE(duration_value, horizon_ticks), duration_unit = COALESCE(duration_unit, 't'), horizon_type = COALESCE(horizon_type, 'tick') WHERE duration_value IS NULL OR duration_unit IS NULL OR horizon_type IS NULL`;

  await sql`ALTER TABLE ml_performance_events ADD COLUMN IF NOT EXISTS duration_value INTEGER`;
  await sql`ALTER TABLE ml_performance_events ADD COLUMN IF NOT EXISTS duration_unit VARCHAR(8)`;
  await sql`ALTER TABLE ml_performance_events ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(20, 6)`;
  await sql`ALTER TABLE ml_performance_events ADD COLUMN IF NOT EXISTS horizon_type VARCHAR(16)`;
  await sql`ALTER TABLE ml_performance_events ADD COLUMN IF NOT EXISTS contract_type VARCHAR(64)`;
  await sql`UPDATE ml_performance_events SET duration_value = COALESCE(duration_value, horizon_ticks), duration_unit = COALESCE(duration_unit, 't'), horizon_type = COALESCE(horizon_type, 'tick') WHERE duration_value IS NULL OR duration_unit IS NULL OR horizon_type IS NULL`;

  await sql`ALTER TABLE ops_model_selection_events ADD COLUMN IF NOT EXISTS duration_value INTEGER`;
  await sql`ALTER TABLE ops_model_selection_events ADD COLUMN IF NOT EXISTS duration_unit VARCHAR(8)`;
  await sql`ALTER TABLE ops_model_selection_events ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(20, 6)`;
  await sql`ALTER TABLE ops_model_selection_events ADD COLUMN IF NOT EXISTS horizon_type VARCHAR(16)`;
  await sql`ALTER TABLE ops_model_selection_events ADD COLUMN IF NOT EXISTS contract_type VARCHAR(64)`;
  await sql`UPDATE ops_model_selection_events SET duration_value = COALESCE(duration_value, horizon_ticks), duration_unit = COALESCE(duration_unit, 't'), horizon_type = COALESCE(horizon_type, 'tick') WHERE duration_value IS NULL OR duration_unit IS NULL OR horizon_type IS NULL`;

  await sql`CREATE TABLE IF NOT EXISTS ml_training_runs (
    run_id UUID PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    asset_symbol VARCHAR(64) NOT NULL,
    duration_value INTEGER NOT NULL,
    duration_unit VARCHAR(8) NOT NULL,
    duration_seconds NUMERIC(20, 6),
    horizon_ticks INTEGER NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    requested_models JSONB NOT NULL DEFAULT '[]'::jsonb,
    completed_models INTEGER NOT NULL DEFAULT 0,
    failed_models INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    strategy_key VARCHAR(160),
    strategy_version VARCHAR(32),
    strategy_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    heartbeat_at TIMESTAMPTZ,
    worker_id VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`ALTER TABLE ml_training_runs ADD COLUMN IF NOT EXISTS strategy_key VARCHAR(160)`;
  await sql`ALTER TABLE ml_training_runs ADD COLUMN IF NOT EXISTS strategy_version VARCHAR(32)`;
  await sql`ALTER TABLE ml_training_runs ADD COLUMN IF NOT EXISTS strategy_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`;
  await sql`ALTER TABLE ml_training_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`;
  await sql`ALTER TABLE ml_training_runs ADD COLUMN IF NOT EXISTS worker_id VARCHAR(128)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_training_runs_asset_created ON ml_training_runs (asset_symbol, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_training_runs_dataset_created ON ml_training_runs (dataset_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_training_runs_strategy ON ml_training_runs (strategy_key, strategy_version, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_training_runs_running_heartbeat ON ml_training_runs (status, heartbeat_at) WHERE status = 'running'`;

  await sql`CREATE TABLE IF NOT EXISTS ml_training_run_models (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES ml_training_runs(run_id) ON DELETE CASCADE,
    model_type VARCHAR(64) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    model_id TEXT,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, model_type)
  )`;
  await sql`ALTER TABLE ml_training_run_models ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_training_run_models_run ON ml_training_run_models (run_id, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_training_run_models_running_heartbeat ON ml_training_run_models (status, heartbeat_at) WHERE status = 'running'`;
}
