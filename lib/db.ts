import { randomUUID } from 'crypto';
import { neon } from '@neondatabase/serverless';
import { ensureTrainingDurationSchema } from './training-duration-schema';

/**
 * Database boundary for the new Operations Center architecture.
 *
 * Important:
 * - Uses only the new schema defined below.
 * - Never creates or alters legacy tables.
 * - Runtime schema initialization is idempotent and versioned.
 * - No mock, seeded, synthetic, or fabricated market/ML records are created.
 */

export function getDbConnectionString(): string | null {
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) {
    console.warn('[DB] DATABASE_URL is missing.');
    return null;
  }
  return dbUrl;
}

export function getDb() {
  const dbUrl = getDbConnectionString();
  return dbUrl ? neon(dbUrl) : null;
}

export function getDbOrThrow() {
  const dbUrl = getDbConnectionString();
  if (!dbUrl) throw new Error('[DB Configuration Error] DATABASE_URL is required.');
  return neon(dbUrl);
}

const SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let initialized = false;

function normalizeOptionalUuid(value: string | undefined, fieldName: string): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return null;
  if (!UUID_PATTERN.test(normalized)) throw new Error(`INVALID_${fieldName.toUpperCase()}_UUID`);
  return normalized;
}

export async function initDbSchema(): Promise<boolean> {
  if (initialized) return true;
  const dbUrl = getDbConnectionString();
  if (!dbUrl) return false;

  try {
    const sql = neon(dbUrl);

    await sql`
      CREATE TABLE IF NOT EXISTS ops_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS market_assets (
        id BIGSERIAL PRIMARY KEY,
        symbol VARCHAR(64) NOT NULL UNIQUE,
        display_name VARCHAR(160),
        asset_class VARCHAR(32) NOT NULL,
        market_type VARCHAR(32) NOT NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'deriv',
        quote_currency VARCHAR(16),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Idempotent schema evolution for deployments where market_assets predates
    // the authoritative asset context columns. No data is fabricated or backfilled.
    await sql`ALTER TABLE market_assets ADD COLUMN IF NOT EXISTS asset_class VARCHAR(32)`;
    await sql`ALTER TABLE market_assets ADD COLUMN IF NOT EXISTS market_type VARCHAR(32)`;

    await sql`
      CREATE TABLE IF NOT EXISTS market_ticks (
        id BIGSERIAL PRIMARY KEY,
        asset_id BIGINT NOT NULL REFERENCES market_assets(id) ON DELETE CASCADE,
        symbol VARCHAR(64) NOT NULL,
        price NUMERIC(30, 12) NOT NULL,
        tick_epoch BIGINT NOT NULL,
        tick_time TIMESTAMPTZ NOT NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'deriv',
        source_tick_id VARCHAR(128),
        ingest_run_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT market_ticks_price_positive CHECK (price > 0)
      )
    `;

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_market_ticks_source_tick
      ON market_ticks (source, source_tick_id)
      WHERE source_tick_id IS NOT NULL
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_market_ticks_asset_time
      ON market_ticks (asset_id, tick_time DESC)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_market_ticks_symbol_epoch
      ON market_ticks (symbol, tick_epoch DESC)
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS data_ingestion_runs (
        id UUID PRIMARY KEY,
        source VARCHAR(32) NOT NULL,
        asset_symbol VARCHAR(64) NOT NULL,
        requested_from TIMESTAMPTZ,
        requested_to TIMESTAMPTZ,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        status VARCHAR(24) NOT NULL,
        records_received BIGINT NOT NULL DEFAULT 0,
        records_inserted BIGINT NOT NULL DEFAULT 0,
        records_rejected BIGINT NOT NULL DEFAULT 0,
        first_tick_time TIMESTAMPTZ,
        last_tick_time TIMESTAMPTZ,
        error_message TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_ingestion_runs_asset_started
      ON data_ingestion_runs (asset_symbol, started_at DESC)
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS data_ingestion_checkpoints (
        source VARCHAR(32) NOT NULL,
        asset_symbol VARCHAR(64) NOT NULL,
        last_tick_epoch BIGINT,
        last_tick_time TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, asset_symbol)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS training_datasets (
        id UUID PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        version VARCHAR(64) NOT NULL,
        asset_symbol VARCHAR(64) NOT NULL,
        horizon_ticks INTEGER NOT NULL,
        feature_schema_version VARCHAR(64) NOT NULL,
        label_schema_version VARCHAR(64) NOT NULL,
        source_from TIMESTAMPTZ NOT NULL,
        source_to TIMESTAMPTZ NOT NULL,
        sample_count BIGINT NOT NULL DEFAULT 0,
        train_count BIGINT NOT NULL DEFAULT 0,
        validation_count BIGINT NOT NULL DEFAULT 0,
        test_count BIGINT NOT NULL DEFAULT 0,
        status VARCHAR(24) NOT NULL,
        artifact_uri TEXT,
        checksum VARCHAR(128),
        leakage_check_passed BOOLEAN,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (name, version)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS ml_model_registry_v2 (
        id BIGSERIAL PRIMARY KEY,
        model_id VARCHAR(160) NOT NULL UNIQUE,
        model_family VARCHAR(64) NOT NULL,
        version VARCHAR(64) NOT NULL,
        asset_symbol VARCHAR(64) NOT NULL,
        asset_class VARCHAR(32) NOT NULL,
        horizon_ticks INTEGER NOT NULL,
        dataset_id UUID,
        format VARCHAR(32) NOT NULL,
        status VARCHAR(24) NOT NULL,
        feature_schema_version VARCHAR(64) NOT NULL,
        framework VARCHAR(64),
        training_run_id UUID,
        metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        hyperparameters JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      ALTER TABLE ml_model_registry_v2 DROP CONSTRAINT IF EXISTS ml_model_registry_v2_dataset_id_fkey;
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_model_registry_asset_horizon
      ON ml_model_registry_v2 (asset_symbol, horizon_ticks, updated_at DESC)
    `;

    // Duration-aware schema & modern unique index migration
    await ensureTrainingDurationSchema(sql);

    await sql`
      CREATE TABLE IF NOT EXISTS ml_model_metrics (
        id BIGSERIAL PRIMARY KEY,
        model_id VARCHAR(160) NOT NULL REFERENCES ml_model_registry_v2(model_id) ON DELETE CASCADE,
        split VARCHAR(24) NOT NULL,
        metric_name VARCHAR(96) NOT NULL,
        metric_value NUMERIC,
        sample_count BIGINT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS ml_model_artifacts (
        id BIGSERIAL PRIMARY KEY,
        model_id VARCHAR(160) NOT NULL,
        artifact_type VARCHAR(32) NOT NULL,
        uri TEXT NOT NULL,
        checksum VARCHAR(128),
        size_bytes BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS ml_backtest_runs (
        id UUID PRIMARY KEY,
        model_id VARCHAR(160) REFERENCES ml_model_registry_v2(model_id) ON DELETE SET NULL,
        asset_symbol VARCHAR(64) NOT NULL,
        horizon_ticks INTEGER NOT NULL,
        dataset_id UUID REFERENCES training_datasets(id) ON DELETE SET NULL,
        total_samples BIGINT NOT NULL,
        winning_samples BIGINT NOT NULL,
        profit_factor NUMERIC(12, 6),
        max_drawdown NUMERIC(12, 6),
        sharpe_ratio NUMERIC(12, 6),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        status VARCHAR(24) NOT NULL,
        metrics JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS ml_performance_events (
        id BIGSERIAL PRIMARY KEY,
        asset_symbol VARCHAR(64) NOT NULL,
        model_id VARCHAR(160) REFERENCES ml_model_registry_v2(model_id) ON DELETE SET NULL,
        horizon_ticks INTEGER NOT NULL,
        predicted_signal VARCHAR(32) NOT NULL,
        confidence NUMERIC(8, 6) NOT NULL,
        entry_price NUMERIC(30, 12) NOT NULL,
        outcome VARCHAR(32),
        exit_price NUMERIC(30, 12),
        prediction_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        outcome_time TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS execution_trades (
        id UUID PRIMARY KEY,
        asset_symbol VARCHAR(64) NOT NULL,
        contract_type VARCHAR(32) NOT NULL,
        stake NUMERIC(20, 8) NOT NULL,
        payout NUMERIC(20, 8),
        buy_price NUMERIC(30, 12),
        sell_price NUMERIC(30, 12),
        status VARCHAR(32) NOT NULL,
        model_id VARCHAR(160) REFERENCES ml_model_registry_v2(model_id) ON DELETE SET NULL,
        prediction_event_id BIGINT REFERENCES ml_performance_events(id) ON DELETE SET NULL,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS ops_model_selection_events (
        id BIGSERIAL PRIMARY KEY,
        asset_symbol VARCHAR(64) NOT NULL,
        asset_class VARCHAR(32) NOT NULL,
        horizon_ticks INTEGER NOT NULL,
        selected_model_id VARCHAR(160) REFERENCES ml_model_registry_v2(model_id) ON DELETE SET NULL,
        selection_reason VARCHAR(64) NOT NULL,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS ops_audit_events (
        id BIGSERIAL PRIMARY KEY,
        category VARCHAR(48) NOT NULL,
        severity VARCHAR(24) NOT NULL,
        actor VARCHAR(160),
        action VARCHAR(160) NOT NULL,
        request_id VARCHAR(128),
        resource_type VARCHAR(96),
        resource_id VARCHAR(160),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS ops_health_events (
        id BIGSERIAL PRIMARY KEY,
        service VARCHAR(96) NOT NULL,
        status VARCHAR(24) NOT NULL,
        latency_ms NUMERIC(12, 3),
        message TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS ml_models (
        id BIGSERIAL PRIMARY KEY,
        model_name VARCHAR(160) NOT NULL,
        version VARCHAR(64) NOT NULL,
        symbol VARCHAR(64) NOT NULL,
        asset_class VARCHAR(64) NOT NULL DEFAULT 'synthetic',
        accuracy NUMERIC(8, 6),
        feature_count INTEGER NOT NULL DEFAULT 0,
        hyperparameters JSONB NOT NULL DEFAULT '{}'::jsonb,
        trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS ml_training_logs (
        id BIGSERIAL PRIMARY KEY,
        symbol VARCHAR(64) NOT NULL,
        samples_count INTEGER NOT NULL DEFAULT 0,
        train_accuracy NUMERIC(8, 6),
        val_accuracy NUMERIC(8, 6),
        log_message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      INSERT INTO ops_schema_migrations (version)
      VALUES (${SCHEMA_VERSION})
      ON CONFLICT (version) DO NOTHING
    `;

    initialized = true;
    return true;
  } catch (error) {
    console.error('[DB Schema Init Error]:', error);
    return false;
  }
}

async function getAssetId(sql: any, symbol: string): Promise<number> {
  const rows = await sql`
    INSERT INTO market_assets (symbol, asset_class, market_type, source)
    VALUES (${symbol}, 'unknown', 'unknown', 'deriv')
    ON CONFLICT (symbol) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `;
  return Number(rows[0].id);
}

export async function saveTicksBatch(symbol: string, ticks: Array<{ price: number; timestamp?: number; epoch?: number; sourceTickId?: string }>) {
  if (!ticks.length) return false;
  const dbUrl = getDbConnectionString();
  if (!dbUrl || !(await initDbSchema())) return false;

  const validTicks = ticks.filter((tick) => {
    const epoch = tick.epoch ?? (tick.timestamp != null ? Math.floor(tick.timestamp / 1000) : null);
    return Number.isFinite(tick.price) && tick.price > 0 && epoch !== null && Number.isSafeInteger(epoch) && epoch > 0;
  });
  if (!validTicks.length) return false;

  try {
    const sql = neon(dbUrl);
    const assetId = await getAssetId(sql, symbol);
    const symbols = validTicks.map(() => symbol);
    const assetIds = validTicks.map(() => assetId);
    const prices = validTicks.map((tick) => tick.price);
    const epochs = validTicks.map((tick) => tick.epoch ?? Math.floor((tick.timestamp as number) / 1000));
    const times = epochs.map((epoch) => new Date(epoch * 1000).toISOString());
    const sourceIds = validTicks.map((tick) => tick.sourceTickId ?? null);
    const sources = validTicks.map(() => 'deriv');

    await sql`
      INSERT INTO market_ticks (asset_id, symbol, price, tick_epoch, tick_time, source, source_tick_id)
      SELECT * FROM UNNEST(
        ${assetIds}::bigint[],
        ${symbols}::text[],
        ${prices}::numeric[],
        ${epochs}::bigint[],
        ${times}::timestamptz[],
        ${sources}::text[],
        ${sourceIds}::text[]
      )
      ON CONFLICT (source, source_tick_id)
      WHERE source_tick_id IS NOT NULL
      DO NOTHING
    `;
    return true;
  } catch (error) {
    console.error('[saveTicksBatch Error]:', error);
    return false;
  }
}

export async function getTicksHistory(symbol: string, limit = 300) {
  const dbUrl = getDbConnectionString();
  if (!dbUrl || !(await initDbSchema())) return [];

  try {
    const sql = neon(dbUrl);
    const rows = await sql`
      SELECT price, tick_epoch, tick_time
      FROM market_ticks
      WHERE symbol = ${symbol}
      ORDER BY tick_time DESC
      LIMIT ${limit}
    `;
    return rows.reverse().map((row: any) => ({
      price: Number(row.price),
      timestamp: Number(row.tick_epoch) * 1000,
    }));
  } catch (error) {
    console.error('[getTicksHistory Error]:', error);
    return [];
  }
}

export async function getRegisteredModels(symbol?: string, status?: string) {
  const dbUrl = getDbConnectionString();
  if (!dbUrl || !(await initDbSchema())) return [];

  try {
    const sql = neon(dbUrl);
    if (symbol && status) return await sql`SELECT * FROM ml_model_registry_v2 WHERE asset_symbol = ${symbol} AND status = ${status} ORDER BY updated_at DESC`;
    if (symbol) return await sql`SELECT * FROM ml_model_registry_v2 WHERE asset_symbol = ${symbol} ORDER BY updated_at DESC`;
    if (status) return await sql`SELECT * FROM ml_model_registry_v2 WHERE status = ${status} ORDER BY updated_at DESC`;
    return await sql`SELECT * FROM ml_model_registry_v2 ORDER BY updated_at DESC`;
  } catch (error) {
    console.error('[getRegisteredModels Error]:', error);
    return [];
  }
}

export async function registerModelInDb(data: {
  modelId: string;
  modelName: string;
  version: string;
  symbol: string;
  horizonSecs?: number;
  format?: string;
  status?: string;
  accuracy?: number;
  backtestWinRate?: number;
  backtestProfitFactor?: number;
  filePath?: string;
  hyperparameters?: unknown;
  metrics?: unknown;
  modelFamily?: string;
  assetClass?: string;
  featureSchemaVersion?: string;
  framework?: string;
  datasetId?: string;
  trainingRunId?: string;
}) {
  const dbUrl = getDbConnectionString();
  if (!dbUrl || !(await initDbSchema())) return false;

  try {
    const sql = neon(dbUrl);
    const metrics = data.metrics && typeof data.metrics === 'object' ? data.metrics : {};
    const datasetId = normalizeOptionalUuid(data.datasetId, 'dataset_id');
    const trainingRunId = normalizeOptionalUuid(data.trainingRunId, 'training_run_id');
    await sql`
      INSERT INTO ml_model_registry_v2 (
        model_id, model_family, version, asset_symbol, asset_class, horizon_ticks,
        duration_value, duration_unit, duration_seconds, horizon_type,
        dataset_id, format, status, feature_schema_version, framework, training_run_id,
        metrics, hyperparameters, updated_at
      ) VALUES (
        ${data.modelId}::text, ${data.modelFamily || data.modelName}::text, ${data.version}::text, ${data.symbol}::text,
        ${data.assetClass || 'unknown'}::varchar, ${data.horizonSecs || 5}::integer,
        ${data.horizonSecs || 5}::integer, 't'::varchar, ${data.horizonSecs || 5}::numeric, 'tick'::varchar,
        ${datasetId}::uuid,
        ${data.format || 'onnx'}::varchar, ${data.status || 'candidate'}::varchar, ${data.featureSchemaVersion || 'v1'}::varchar,
        ${data.framework || null}::varchar, ${trainingRunId}::uuid,
        ${JSON.stringify({ accuracy: data.accuracy, backtestWinRate: data.backtestWinRate, backtestProfitFactor: data.backtestProfitFactor, ...metrics })}::jsonb,
        ${JSON.stringify(data.hyperparameters || {})}::jsonb, NOW()
      )
      ON CONFLICT (model_id) DO UPDATE SET
        model_family = EXCLUDED.model_family,
        version = EXCLUDED.version,
        asset_symbol = EXCLUDED.asset_symbol,
        asset_class = EXCLUDED.asset_class,
        horizon_ticks = EXCLUDED.horizon_ticks,
        duration_value = COALESCE(EXCLUDED.duration_value, EXCLUDED.horizon_ticks),
        duration_unit = COALESCE(EXCLUDED.duration_unit, 't'),
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, EXCLUDED.horizon_ticks),
        horizon_type = COALESCE(EXCLUDED.horizon_type, 'tick'),
        dataset_id = EXCLUDED.dataset_id,
        format = EXCLUDED.format,
        status = EXCLUDED.status,
        feature_schema_version = EXCLUDED.feature_schema_version,
        framework = EXCLUDED.framework,
        training_run_id = EXCLUDED.training_run_id,
        metrics = EXCLUDED.metrics,
        hyperparameters = EXCLUDED.hyperparameters,
        updated_at = NOW()
    `;
    return true;
  } catch (error) {
    console.error('[registerModelInDb Error]:', error);
    return false;
  }
}

export async function promoteModelInRegistry(modelId: string, symbol: string, horizonSecs?: number, modelFrameworkOrFamily?: string) {
  const dbUrl = getDbConnectionString();
  if (!dbUrl || !(await initDbSchema())) return false;

  try {
    const sql = neon(dbUrl);
    
    // Check target model details if needed
    const modelRows = await sql`
      SELECT model_family, framework, metrics, duration_value, duration_unit, horizon_ticks, asset_symbol
      FROM ml_model_registry_v2 WHERE model_id = ${modelId} LIMIT 1
    `;
    if (modelRows.length === 0) return false;

    const targetRow = modelRows[0];
    const assetSym = symbol || targetRow.asset_symbol;
    const durVal = targetRow.duration_value ?? (typeof horizonSecs === 'number' ? horizonSecs : targetRow.horizon_ticks);
    const durUnit = targetRow.duration_unit || 't';

    // Demote any existing production models for the same asset & duration/horizon to respect unique index
    if (durVal !== null && durVal !== undefined) {
      await sql`
        UPDATE ml_model_registry_v2
        SET status = 'staging', updated_at = NOW()
        WHERE asset_symbol = ${assetSym}
          AND (
            (duration_value = ${durVal} AND duration_unit = ${durUnit})
            OR (horizon_ticks = ${durVal})
          )
          AND status = 'production'
          AND model_id <> ${modelId}
      `;
    } else {
      await sql`
        UPDATE ml_model_registry_v2
        SET status = 'staging', updated_at = NOW()
        WHERE asset_symbol = ${assetSym}
          AND status = 'production'
          AND model_id <> ${modelId}
      `;
    }

    // Now promote the target model to production
    const updateRows = await sql`
      UPDATE ml_model_registry_v2
      SET status = 'production',
          updated_at = NOW()
      WHERE model_id = ${modelId}
      RETURNING model_id, status
    `;

    return updateRows.length > 0 && updateRows[0].status === 'production';
  } catch (error) {
    console.error('[promoteModelInRegistry Error]:', error);
    return false;
  }
}

export async function saveBacktestResults(data: {
  modelId?: string;
  symbol: string;
  durationSec: number;
  totalTrades: number;
  winningTrades: number;
  profitFactor: number;
}) {
  const dbUrl = getDbConnectionString();
  if (!dbUrl || !(await initDbSchema())) return false;

  try {
    const sql = neon(dbUrl);
    await sql`
      INSERT INTO ml_backtest_runs (
        id, model_id, asset_symbol, horizon_ticks, total_samples, winning_samples,
        profit_factor, completed_at, status
      ) VALUES (
        ${randomUUID()}, ${data.modelId || null}, ${data.symbol}, ${data.durationSec},
        ${data.totalTrades}, ${data.winningTrades}, ${data.profitFactor}, NOW(), 'completed'
      )
    `;
    return true;
  } catch (error) {
    console.error('[saveBacktestResults Error]:', error);
    return false;
  }
}

export async function savePerformanceAudit(data: {
  symbol: string;
  modelId?: string;
  predictedSignal: string;
  confidence: number;
  entryPrice: number;
  exitPrice?: number;
  outcome?: string;
}) {
  const dbUrl = getDbConnectionString();
  if (!dbUrl || !(await initDbSchema())) return false;

  try {
    const sql = neon(dbUrl);
    await sql`
      INSERT INTO ml_performance_events (
        asset_symbol, model_id, horizon_ticks, predicted_signal, confidence,
        entry_price, exit_price, outcome, outcome_time
      ) VALUES (
        ${data.symbol}, ${data.modelId || null}, 1, ${data.predictedSignal}, ${data.confidence},
        ${data.entryPrice}, ${data.exitPrice ?? null}, ${data.outcome ?? null},
        CASE WHEN ${data.outcome ?? null} IS NULL THEN NULL ELSE NOW() END
      )
    `;
    return true;
  } catch (error) {
    console.error('[savePerformanceAudit Error]:', error);
    return false;
  }
}
