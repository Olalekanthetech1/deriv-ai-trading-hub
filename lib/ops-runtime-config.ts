import { getDbOrThrow, initDbSchema } from './db';
import { getLiveRiseFallSymbols } from './rise-fall-symbols';

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
    } else {
      const defaultConfig = {
        enableRegimeModel: false,
        enableAnomalyModel: false,
        enableDeepSequentialModels: true,
        fallbackBehavior: 'graceful_degrade',
      };
      const seededRows = await sql`
        INSERT INTO ops_runtime_config (config_key, config_value, updated_at, updated_by)
        VALUES ('ml_ensemble_analysis_controls', ${JSON.stringify(defaultConfig)}::jsonb, NOW(), 'system_init')
        ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value
        RETURNING config_value, updated_at, updated_by
      `;
      if (seededRows.length > 0 && seededRows[0]?.config_value) {
        const val = seededRows[0].config_value;
        const loaded: MlEnsembleAnalysisRuntimeConfig = {
          enableRegimeModel: Boolean(val.enableRegimeModel),
          enableAnomalyModel: Boolean(val.enableAnomalyModel),
          enableDeepSequentialModels: val.enableDeepSequentialModels !== undefined ? Boolean(val.enableDeepSequentialModels) : true,
          fallbackBehavior: val.fallbackBehavior === 'strict_require' ? 'strict_require' : 'graceful_degrade',
          updatedAt: seededRows[0].updated_at ? new Date(seededRows[0].updated_at).toISOString() : null,
          updatedBy: seededRows[0].updated_by ? String(seededRows[0].updated_by) : 'system_init',
          source: 'database',
        };
        cachedEnsembleConfig = loaded;
        ensembleCacheExpiresAt = now + CACHE_TTL_MS;
        return loaded;
      }
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

export type GlobalTradingCircuitBreakerConfig = {
  isHalted: boolean;
  haltReason: string | null;
  haltedAt: string | null;
  haltedBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  source: 'database' | 'default';
};

let cachedCircuitBreakerConfig: GlobalTradingCircuitBreakerConfig | null = null;
let circuitBreakerCacheExpiresAt = 0;

/**
 * Retrieves the live, dynamically persisted Global Trading Circuit Breaker state.
 */
export async function getGlobalTradingCircuitBreakerConfig(forceRefresh = false): Promise<GlobalTradingCircuitBreakerConfig> {
  const now = Date.now();
  if (!forceRefresh && cachedCircuitBreakerConfig && now < circuitBreakerCacheExpiresAt) {
    return cachedCircuitBreakerConfig;
  }

  try {
    await ensureOpsRuntimeConfigTable();
    const sql = getDbOrThrow();
    const rows = await sql`
      SELECT config_value, updated_at, updated_by
      FROM ops_runtime_config
      WHERE config_key = 'global_trading_circuit_breaker'
      LIMIT 1
    `;

    if (rows.length > 0 && rows[0]?.config_value) {
      const val = rows[0].config_value;
      const loaded: GlobalTradingCircuitBreakerConfig = {
        isHalted: Boolean(val.isHalted),
        haltReason: typeof val.haltReason === 'string' ? val.haltReason : null,
        haltedAt: typeof val.haltedAt === 'string' ? val.haltedAt : null,
        haltedBy: typeof val.haltedBy === 'string' ? val.haltedBy : null,
        updatedAt: rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null,
        updatedBy: rows[0].updated_by ? String(rows[0].updated_by) : null,
        source: 'database',
      };

      cachedCircuitBreakerConfig = loaded;
      circuitBreakerCacheExpiresAt = now + CACHE_TTL_MS;
      return loaded;
    }
  } catch (error) {
    console.error('[ops-runtime-config] error reading global trading circuit breaker config from database:', error);
  }

  const fallback: GlobalTradingCircuitBreakerConfig = {
    isHalted: false,
    haltReason: null,
    haltedAt: null,
    haltedBy: null,
    updatedAt: null,
    updatedBy: null,
    source: 'default',
  };

  cachedCircuitBreakerConfig = fallback;
  circuitBreakerCacheExpiresAt = now + CACHE_TTL_MS;
  return fallback;
}

/**
 * Updates the Global Trading Circuit Breaker state (Emergency Halt / Resume).
 * Idempotent, persisted, and auditable.
 */
export async function updateGlobalTradingCircuitBreakerConfig(params: {
  isHalted: boolean;
  haltReason?: string | null;
  updatedBy?: string;
  requestId?: string;
}): Promise<GlobalTradingCircuitBreakerConfig> {
  await ensureOpsRuntimeConfigTable();
  const current = await getGlobalTradingCircuitBreakerConfig(true);

  const updatedBy = params.updatedBy || 'system_admin';
  const nowIso = new Date().toISOString();

  let haltedAt = current.haltedAt;
  let haltedBy = current.haltedBy;
  let haltReason = current.haltReason;

  if (params.isHalted) {
    if (!current.isHalted) {
      // Transition from Normal -> Halted
      haltedAt = nowIso;
      haltedBy = updatedBy;
      haltReason = params.haltReason || 'Emergency Halt triggered by operator';
    } else if (params.haltReason) {
      // Idempotent halt update
      haltReason = params.haltReason;
    }
  } else {
    // Transition to Normal / Resumed
    haltedAt = null;
    haltedBy = null;
    haltReason = null;
  }

  const configValue = {
    isHalted: params.isHalted,
    haltReason,
    haltedAt,
    haltedBy,
  };

  const sql = getDbOrThrow();
  const rows = await sql`
    INSERT INTO ops_runtime_config (config_key, config_value, updated_at, updated_by)
    VALUES ('global_trading_circuit_breaker', ${JSON.stringify(configValue)}::jsonb, NOW(), ${updatedBy})
    ON CONFLICT (config_key) DO UPDATE SET
      config_value = EXCLUDED.config_value,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by
    RETURNING config_value, updated_at, updated_by
  `;

  try {
    const action = params.isHalted
      ? current.isHalted
        ? 'emergency_halt_idempotent_reaffirm'
        : 'emergency_halt_activated'
      : 'emergency_halt_resumed';

    await sql`
      INSERT INTO ops_audit_events (
        category, severity, actor, action, request_id, resource_type, resource_id, metadata
      ) VALUES (
        'trading_ops',
        ${params.isHalted ? 'critical' : 'info'},
        ${updatedBy},
        ${action},
        ${params.requestId || null},
        'ops_runtime_config',
        'global_trading_circuit_breaker',
        ${JSON.stringify({ previous: current, current: configValue })}::jsonb
      )
    `;
  } catch (auditErr) {
    console.warn('[ops-runtime-config] audit log entry warning for circuit breaker:', auditErr);
  }

  cachedCircuitBreakerConfig = {
    isHalted: params.isHalted,
    haltReason,
    haltedAt,
    haltedBy,
    updatedAt: rows[0]?.updated_at ? new Date(rows[0].updated_at).toISOString() : nowIso,
    updatedBy: rows[0]?.updated_by ? String(rows[0].updated_by) : updatedBy,
    source: 'database',
  };
  circuitBreakerCacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return cachedCircuitBreakerConfig;
}

export type TelegramBrandingConfig = Record<string, string>;

let cachedTelegramBrandingConfig: TelegramBrandingConfig | null = null;
let telegramBrandingCacheExpiresAt = 0;

/**
 * Retrieves the live, dynamic Telegram branding image URLs (keyed by screen_key) from the database.
 */
export async function getTelegramBrandingRuntimeConfig(forceRefresh = false): Promise<TelegramBrandingConfig> {
  const now = Date.now();
  if (!forceRefresh && cachedTelegramBrandingConfig && now < telegramBrandingCacheExpiresAt) {
    return cachedTelegramBrandingConfig;
  }

  try {
    await ensureOpsRuntimeConfigTable();
    const sql = getDbOrThrow();
    const rows = await sql`
      SELECT config_value, updated_at, updated_by
      FROM ops_runtime_config
      WHERE config_key = 'telegram_branding_config'
      LIMIT 1
    `;

    if (rows.length > 0 && rows[0]?.config_value && typeof rows[0].config_value === 'object') {
      const val = rows[0].config_value;
      const loaded: TelegramBrandingConfig = {};
      for (const [key, url] of Object.entries(val)) {
        if (typeof url === 'string' && url.trim().length > 0) {
          loaded[key] = url.trim();
        }
      }
      cachedTelegramBrandingConfig = loaded;
      telegramBrandingCacheExpiresAt = now + CACHE_TTL_MS;
      return loaded;
    }
  } catch (error) {
    console.error('[ops-runtime-config] error reading telegram branding config from database:', error);
  }

  const fallback: TelegramBrandingConfig = {};
  cachedTelegramBrandingConfig = fallback;
  telegramBrandingCacheExpiresAt = now + CACHE_TTL_MS;
  return fallback;
}

/**
 * Updates dynamic Telegram branding image URLs in the database.
 */
export async function updateTelegramBrandingRuntimeConfig(
  updates: Record<string, string>,
  updatedBy: string = 'admin'
): Promise<TelegramBrandingConfig> {
  await ensureOpsRuntimeConfigTable();
  const current = await getTelegramBrandingRuntimeConfig(true);

  const nextConfig = { ...current };
  for (const [key, url] of Object.entries(updates)) {
    if (typeof url === 'string' && url.trim().length > 0) {
      nextConfig[key] = url.trim();
    } else {
      delete nextConfig[key];
    }
  }

  const sql = getDbOrThrow();
  const rows = await sql`
    INSERT INTO ops_runtime_config (config_key, config_value, updated_at, updated_by)
    VALUES ('telegram_branding_config', ${JSON.stringify(nextConfig)}::jsonb, NOW(), ${updatedBy})
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
        'telegram_ops',
        'info',
        ${updatedBy},
        'update_telegram_branding_config',
        'ops_runtime_config',
        'telegram_branding_config',
        ${JSON.stringify({ previous: current, current: nextConfig })}::jsonb
      )
    `;
  } catch (auditErr) {
    console.warn('[ops-runtime-config] audit log entry warning for branding config:', auditErr);
  }

  cachedTelegramBrandingConfig = nextConfig;
  telegramBrandingCacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return nextConfig;
}

/**
 * Resumes global automated trading ONLY AFTER verifying system health gates:
 * 1. Database schema & connectivity check
 * 2. Active Rise/Fall symbol discovery check
 */
export async function resumeGlobalTradingWithHealthCheck(params: {
  updatedBy: string;
  requestId?: string;
}): Promise<GlobalTradingCircuitBreakerConfig> {
  // Gate 1: Database Health Check
  const dbOk = await initDbSchema().catch(() => false);
  if (!dbOk) {
    throw new Error('RESUME_GATE_FAILED: Database connection or schema initialization failed');
  }

  // Gate 2: Symbol Universe & Deriv API Discovery Check
  const activeSymbols = await getLiveRiseFallSymbols(true, false).catch(() => []);
  const availableCount = activeSymbols.filter((s) => s.isAvailable && s.isOpen).length;
  if (availableCount === 0) {
    throw new Error('RESUME_GATE_FAILED: No active rise/fall volatility symbols discovered from Deriv');
  }

  return updateGlobalTradingCircuitBreakerConfig({
    isHalted: false,
    updatedBy: params.updatedBy,
    requestId: params.requestId,
  });
}

