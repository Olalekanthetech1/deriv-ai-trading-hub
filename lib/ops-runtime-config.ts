import { getDbOrThrow, initDbSchema } from './db';

export type QueueWorkerRuntimeConfig = {
  isPaused: boolean;
  concurrencyLimit: number;
  pauseReason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  source: 'database' | 'default';
};

const DEFAULT_CONCURRENCY = 2;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;

let cachedConfig: QueueWorkerRuntimeConfig | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5000; // 5-second dynamic TTL cache for lightning fast worker checks without DB hammering

/**
 * Initializes the ops_runtime_config table idempotently.
 */
export async function ensureOpsRuntimeConfigTable(): Promise<void> {
  await initDbSchema();
  const sql = getDbOrThrow();
  await sql`
    CREATE TABLE IF NOT EXISTS ops_runtime_config (
      config_key VARCHAR(64) PRIMARY KEY,
      config_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by VARCHAR(160)
    )
  `;
}

/**
 * Retrieves the live, dynamically configured worker concurrency and queue pause state from the database.
 */
export async function getQueueWorkerRuntimeConfig(forceRefresh = false): Promise<QueueWorkerRuntimeConfig> {
  const now = Date.now();
  if (!forceRefresh && cachedConfig && now < cacheExpiresAt) {
    return cachedConfig;
  }

  try {
    await ensureOpsRuntimeConfigTable();
    const sql = getDbOrThrow();
    const rows = await sql`
      SELECT config_value, updated_at, updated_by
      FROM ops_runtime_config
      WHERE config_key = 'queue_worker_scaling'
      LIMIT 1
    `;

    if (rows.length > 0 && rows[0]?.config_value) {
      const val = rows[0].config_value;
      const isPaused = Boolean(val.isPaused);
      const concurrencyRaw = Number(val.concurrencyLimit);
      const concurrencyLimit = Number.isSafeInteger(concurrencyRaw) && concurrencyRaw >= MIN_CONCURRENCY
        ? Math.min(MAX_CONCURRENCY, concurrencyRaw)
        : DEFAULT_CONCURRENCY;
      const pauseReason = typeof val.pauseReason === 'string' ? val.pauseReason.trim() : null;

      const loadedConfig: QueueWorkerRuntimeConfig = {
        isPaused,
        concurrencyLimit,
        pauseReason,
        updatedAt: rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null,
        updatedBy: rows[0].updated_by ? String(rows[0].updated_by) : null,
        source: 'database',
      };

      cachedConfig = loadedConfig;
      cacheExpiresAt = now + CACHE_TTL_MS;
      return loadedConfig;
    }
  } catch (error) {
    console.error('[ops-runtime-config] error reading dynamic queue config from database:', error);
  }

  const fallback: QueueWorkerRuntimeConfig = {
    isPaused: false,
    concurrencyLimit: DEFAULT_CONCURRENCY,
    pauseReason: null,
    updatedAt: null,
    updatedBy: null,
    source: 'default',
  };

  cachedConfig = fallback;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return fallback;
}

/**
 * Dynamically updates the worker concurrency throttle or queue pause/resume state in the database.
 */
export async function updateQueueWorkerRuntimeConfig(params: {
  isPaused?: boolean;
  concurrencyLimit?: number;
  pauseReason?: string | null;
  updatedBy?: string;
}): Promise<QueueWorkerRuntimeConfig> {
  await ensureOpsRuntimeConfigTable();
  const current = await getQueueWorkerRuntimeConfig(true);

  const nextIsPaused = typeof params.isPaused === 'boolean' ? params.isPaused : current.isPaused;
  let nextConcurrency = current.concurrencyLimit;
  if (params.concurrencyLimit !== undefined) {
    const raw = Number(params.concurrencyLimit);
    if (!Number.isSafeInteger(raw) || raw < MIN_CONCURRENCY || raw > MAX_CONCURRENCY) {
      throw new Error(`concurrencyLimit must be an integer between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`);
    }
    nextConcurrency = raw;
  }

  const nextPauseReason = params.pauseReason !== undefined ? params.pauseReason : current.pauseReason;
  const updatedBy = params.updatedBy || 'admin';

  const configValue = {
    isPaused: nextIsPaused,
    concurrencyLimit: nextConcurrency,
    pauseReason: nextIsPaused ? nextPauseReason : null,
  };

  const sql = getDbOrThrow();
  const rows = await sql`
    INSERT INTO ops_runtime_config (config_key, config_value, updated_at, updated_by)
    VALUES ('queue_worker_scaling', ${JSON.stringify(configValue)}::jsonb, NOW(), ${updatedBy})
    ON CONFLICT (config_key) DO UPDATE SET
      config_value = EXCLUDED.config_value,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by
    RETURNING config_value, updated_at, updated_by
  `;

  // Clear cache immediately
  cachedConfig = {
    isPaused: nextIsPaused,
    concurrencyLimit: nextConcurrency,
    pauseReason: nextIsPaused ? nextPauseReason : null,
    updatedAt: rows[0]?.updated_at ? new Date(rows[0].updated_at).toISOString() : new Date().toISOString(),
    updatedBy: rows[0]?.updated_by ? String(rows[0].updated_by) : updatedBy,
    source: 'database',
  };
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return cachedConfig;
}

export type MlEnsembleAnalysisRuntimeConfig = {
  enableRegimeModel: boolean;
  enableAnomalyModel: boolean;
  enableDeepSequentialModels: boolean;
  fallbackBehavior: 'graceful_degrade' | 'strict_require';
  updatedAt: string | null;
  updatedBy: string | null;
  source: 'database' | 'default';
};

let cachedEnsembleConfig: MlEnsembleAnalysisRuntimeConfig | null = null;
let ensembleCacheExpiresAt = 0;

/**
 * Retrieves the live, dynamically configured Ensemble Analysis Controls (e.g. Regime / Anomaly toggle) from the database.
 */
export async function getMlEnsembleAnalysisRuntimeConfig(forceRefresh = false): Promise<MlEnsembleAnalysisRuntimeConfig> {
  const now = Date.now();
  if (!forceRefresh && cachedEnsembleConfig && now < ensembleCacheExpiresAt) {
    return cachedEnsembleConfig;
  }

  try {
    await ensureOpsRuntimeConfigTable();
    const sql = getDbOrThrow();
    const rows = await sql`
      SELECT config_value, updated_at, updated_by
      FROM ops_runtime_config
      WHERE config_key = 'ml_ensemble_analysis_controls'
      LIMIT 1
    `;

    if (rows.length > 0 && rows[0]?.config_value) {
      const val = rows[0].config_value;
      const loaded: MlEnsembleAnalysisRuntimeConfig = {
        enableRegimeModel: Boolean(val.enableRegimeModel),
        enableAnomalyModel: Boolean(val.enableAnomalyModel),
        enableDeepSequentialModels: val.enableDeepSequentialModels !== undefined ? Boolean(val.enableDeepSequentialModels) : true,
        fallbackBehavior: val.fallbackBehavior === 'strict_require' ? 'strict_require' : 'graceful_degrade',
        updatedAt: rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null,
        updatedBy: rows[0].updated_by ? String(rows[0].updated_by) : null,
        source: 'database',
      };

      cachedEnsembleConfig = loaded;
      ensembleCacheExpiresAt = now + CACHE_TTL_MS;
      return loaded;
    }
  } catch (error) {
    console.error('[ops-runtime-config] error reading ensemble analysis config from database:', error);
  }

  const fallback: MlEnsembleAnalysisRuntimeConfig = {
    enableRegimeModel: false, // Default unblocked so analysis runs smoothly even before HMM is trained
    enableAnomalyModel: false, // Default unblocked so analysis runs smoothly even before Anomaly is trained
    enableDeepSequentialModels: true,
    fallbackBehavior: 'graceful_degrade',
    updatedAt: null,
    updatedBy: null,
    source: 'default',
  };

  cachedEnsembleConfig = fallback;
  ensembleCacheExpiresAt = now + CACHE_TTL_MS;
  return fallback;
}

/**
 * Dynamically updates the Ensemble Analysis Controls (e.g. activate or deactivate Regime/Anomaly model requirement for analysis).
 */
export async function updateMlEnsembleAnalysisRuntimeConfig(params: {
  enableRegimeModel?: boolean;
  enableAnomalyModel?: boolean;
  enableDeepSequentialModels?: boolean;
  fallbackBehavior?: 'graceful_degrade' | 'strict_require';
  updatedBy?: string;
}): Promise<MlEnsembleAnalysisRuntimeConfig> {
  await ensureOpsRuntimeConfigTable();
  const current = await getMlEnsembleAnalysisRuntimeConfig(true);

  const nextEnableRegime = typeof params.enableRegimeModel === 'boolean' ? params.enableRegimeModel : current.enableRegimeModel;
  const nextEnableAnomaly = typeof params.enableAnomalyModel === 'boolean' ? params.enableAnomalyModel : current.enableAnomalyModel;
  const nextEnableDeep = typeof params.enableDeepSequentialModels === 'boolean' ? params.enableDeepSequentialModels : current.enableDeepSequentialModels;
  const nextFallback = params.fallbackBehavior === 'strict_require' ? 'strict_require' : (params.fallbackBehavior === 'graceful_degrade' ? 'graceful_degrade' : current.fallbackBehavior);
  const updatedBy = params.updatedBy || 'admin';

  const configValue = {
    enableRegimeModel: nextEnableRegime,
    enableAnomalyModel: nextEnableAnomaly,
    enableDeepSequentialModels: nextEnableDeep,
    fallbackBehavior: nextFallback,
  };

  const sql = getDbOrThrow();
  const rows = await sql`
    INSERT INTO ops_runtime_config (config_key, config_value, updated_at, updated_by)
    VALUES ('ml_ensemble_analysis_controls', ${JSON.stringify(configValue)}::jsonb, NOW(), ${updatedBy})
    ON CONFLICT (config_key) DO UPDATE SET
      config_value = EXCLUDED.config_value,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by
    RETURNING config_value, updated_at, updated_by
  `;

  try {
    await sql`
      INSERT INTO ops_audit_events (
        category, severity, actor, action, resource_type, resource_id, metadata
      ) VALUES (
        'ml_ops',
        'info',
        ${updatedBy},
        'update_ensemble_analysis_controls',
        'ops_runtime_config',
        'ml_ensemble_analysis_controls',
        ${JSON.stringify({ previous: current, current: configValue })}::jsonb
      )
    `;
  } catch (auditErr) {
    console.warn('[ops-runtime-config] audit log entry warning:', auditErr);
  }

  // Clear cache immediately
  cachedEnsembleConfig = {
    enableRegimeModel: nextEnableRegime,
    enableAnomalyModel: nextEnableAnomaly,
    enableDeepSequentialModels: nextEnableDeep,
    fallbackBehavior: nextFallback,
    updatedAt: rows[0]?.updated_at ? new Date(rows[0].updated_at).toISOString() : new Date().toISOString(),
    updatedBy: rows[0]?.updated_by ? String(rows[0].updated_by) : updatedBy,
    source: 'database',
  };
  ensembleCacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return cachedEnsembleConfig;
}
