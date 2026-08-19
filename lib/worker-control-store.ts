import { getDbOrThrow, initDbSchema } from './db';
import { ensureOpsRuntimeConfigTable, getQueueWorkerRuntimeConfig, updateQueueWorkerRuntimeConfig } from './ops-runtime-config';
import { cancelAllRunningAutoDatasetJobs } from './auto-dataset-job-store';

export type MasterAutomationMode = 'manual' | 'autonomous';

export type MasterAutomationConfig = {
  mode: MasterAutomationMode;
  globalKillSwitch: boolean;
  lastEmergencyHaltAt: string | null;
  haltedBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type DatasetWorkerConfig = {
  enabled: boolean;
  maxConcurrentJobs: number;
  autoResumeOnLoad: boolean;
  updatedAt: string | null;
};

export type RetrainingWorkerConfig = {
  enabled: boolean;
  intervalHours: number;
  minAccuracyThreshold: number;
  updatedAt: string | null;
};

export type CircuitBreakerWorkerConfig = {
  enabled: boolean;
  autoDemote: boolean;
  driftToleranceRatio: number;
  updatedAt: string | null;
};

export type TickIngestionConfig = {
  enabled: boolean;
  maxActiveSymbols: number;
  updatedAt: string | null;
};

export type WorkerSwitchboardState = {
  master: MasterAutomationConfig;
  datasetWorker: DatasetWorkerConfig;
  trainingQueueWorker: {
    isPaused: boolean;
    concurrencyLimit: number;
    pauseReason: string | null;
    updatedAt: string | null;
  };
  retrainingWorker: RetrainingWorkerConfig;
  circuitBreakerWorker: CircuitBreakerWorkerConfig;
  tickIngestion: TickIngestionConfig;
  telemetry: {
    activeDatasetJobs: number;
    pendingDatasetJobs: number;
    runningTrainingRuns: number;
    queuedTrainingRuns: number;
    totalActiveModels: number;
    databaseConnected: boolean;
  };
};

/**
 * Ensures all default keys exist in ops_runtime_config
 */
export async function getWorkerSwitchboardState(): Promise<WorkerSwitchboardState> {
  await ensureOpsRuntimeConfigTable();
  const sql = getDbOrThrow();

  // 1. Fetch current ops_runtime_config rows
  const rows = await sql`
    SELECT config_key, config_value, updated_at, updated_by
    FROM ops_runtime_config
    WHERE config_key IN (
      'master_automation_switch',
      'dataset_builder_worker',
      'queue_worker_scaling',
      'retraining_automation',
      'circuit_breaker_evaluator',
      'tick_ingestion_stream'
    )
  `;

  const configMap = new Map<string, any>();
  for (const row of rows) {
    configMap.set(String(row.config_key), {
      val: row.config_value,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row.updated_by ? String(row.updated_by) : null,
    });
  }

  // Master Automation Config
  const masterRaw = configMap.get('master_automation_switch');
  const master: MasterAutomationConfig = {
    mode: masterRaw?.val?.mode === 'autonomous' ? 'autonomous' : 'manual',
    globalKillSwitch: Boolean(masterRaw?.val?.globalKillSwitch),
    lastEmergencyHaltAt: masterRaw?.val?.lastEmergencyHaltAt ? String(masterRaw.val.lastEmergencyHaltAt) : null,
    haltedBy: masterRaw?.val?.haltedBy ? String(masterRaw.val.haltedBy) : null,
    updatedAt: masterRaw?.updatedAt ?? null,
    updatedBy: masterRaw?.updatedBy ?? null,
  };

  // Dataset Worker Config
  const datasetRaw = configMap.get('dataset_builder_worker');
  const datasetWorker: DatasetWorkerConfig = {
    enabled: master.mode === 'autonomous' && !master.globalKillSwitch ? Boolean(datasetRaw?.val?.enabled) : false,
    maxConcurrentJobs: Math.max(1, Math.min(8, Number(datasetRaw?.val?.maxConcurrentJobs || 2))),
    autoResumeOnLoad: master.mode === 'autonomous' ? Boolean(datasetRaw?.val?.autoResumeOnLoad) : false,
    updatedAt: datasetRaw?.updatedAt ?? null,
  };

  // Training Queue Worker Config
  const queueConfig = await getQueueWorkerRuntimeConfig();

  // Retraining Automation Config
  const retrainingRaw = configMap.get('retraining_automation');
  const retrainingWorker: RetrainingWorkerConfig = {
    enabled: master.mode === 'autonomous' && !master.globalKillSwitch ? Boolean(retrainingRaw?.val?.enabled) : false,
    intervalHours: Math.max(1, Math.min(168, Number(retrainingRaw?.val?.intervalHours || 24))),
    minAccuracyThreshold: Math.max(0.1, Math.min(1.0, Number(retrainingRaw?.val?.minAccuracyThreshold || 0.55))),
    updatedAt: retrainingRaw?.updatedAt ?? null,
  };

  // Circuit Breaker Worker Config
  const cbRaw = configMap.get('circuit_breaker_evaluator');
  const circuitBreakerWorker: CircuitBreakerWorkerConfig = {
    enabled: !master.globalKillSwitch ? (cbRaw?.val?.enabled !== undefined ? Boolean(cbRaw.val.enabled) : true) : false,
    autoDemote: cbRaw?.val?.autoDemote !== undefined ? Boolean(cbRaw.val.autoDemote) : true,
    driftToleranceRatio: Math.max(0.1, Math.min(0.9, Number(cbRaw?.val?.driftToleranceRatio || 0.48))),
    updatedAt: cbRaw?.updatedAt ?? null,
  };

  // Tick Ingestion Config
  const tickRaw = configMap.get('tick_ingestion_stream');
  const tickIngestion: TickIngestionConfig = {
    enabled: !master.globalKillSwitch ? (tickRaw?.val?.enabled !== undefined ? Boolean(tickRaw.val.enabled) : true) : false,
    maxActiveSymbols: Math.max(1, Math.min(100, Number(tickRaw?.val?.maxActiveSymbols || 30))),
    updatedAt: tickRaw?.updatedAt ?? null,
  };

  // Telemetry counts
  let activeDatasetJobs = 0;
  let pendingDatasetJobs = 0;
  let runningTrainingRuns = 0;
  let queuedTrainingRuns = 0;
  let totalActiveModels = 0;
  let databaseConnected = false;

  try {
    const [datasetCounts, trainingCounts, modelCounts] = await Promise.all([
      sql`
        SELECT status, COUNT(*)::int AS cnt
        FROM ops_ml_dataset_build_jobs
        WHERE status IN ('running', 'pending')
        GROUP BY status
      `,
      sql`
        SELECT status, COUNT(*)::int AS cnt
        FROM ml_training_runs
        WHERE status IN ('running', 'queued')
        GROUP BY status
      `,
      sql`
        SELECT COUNT(*)::int AS cnt
        FROM ml_model_registry_v2
        WHERE status = 'production'
      `,
    ]);

    databaseConnected = true;
    for (const r of datasetCounts) {
      if (r.status === 'running') activeDatasetJobs = Number(r.cnt);
      if (r.status === 'pending') pendingDatasetJobs = Number(r.cnt);
    }
    for (const r of trainingCounts) {
      if (r.status === 'running') runningTrainingRuns = Number(r.cnt);
      if (r.status === 'queued') queuedTrainingRuns = Number(r.cnt);
    }
    if (modelCounts[0]?.cnt !== undefined) {
      totalActiveModels = Number(modelCounts[0].cnt);
    }
  } catch (err) {
    console.error('[worker-control-store] telemetry error:', err);
  }

  return {
    master,
    datasetWorker,
    trainingQueueWorker: {
      isPaused: queueConfig.isPaused,
      concurrencyLimit: queueConfig.concurrencyLimit,
      pauseReason: queueConfig.pauseReason,
      updatedAt: queueConfig.updatedAt,
    },
    retrainingWorker,
    circuitBreakerWorker,
    tickIngestion,
    telemetry: {
      activeDatasetJobs,
      pendingDatasetJobs,
      runningTrainingRuns,
      queuedTrainingRuns,
      totalActiveModels,
      databaseConnected,
    },
  };
}

/**
 * Updates a specific key in ops_runtime_config
 */
export async function updateWorkerConfigKey(
  key: string,
  value: Record<string, any>,
  updatedBy = 'admin'
): Promise<void> {
  await ensureOpsRuntimeConfigTable();
  const sql = getDbOrThrow();
  await sql`
    INSERT INTO ops_runtime_config (config_key, config_value, updated_at, updated_by)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW(), ${updatedBy})
    ON CONFLICT (config_key) DO UPDATE SET
      config_value = EXCLUDED.config_value,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by
  `;
}

/**
 * Emergency HALT ALL WORKERS: Instantly cancels all running background jobs,
 * pauses queue scaling, sets master automation switch to MANUAL STANDBY with globalKillSwitch=true.
 */
export async function executeEmergencyHaltAll(updatedBy = 'admin'): Promise<{
  cancelledDatasetJobs: number;
  cancelledTrainingRuns: number;
  haltedAt: string;
}> {
  await ensureOpsRuntimeConfigTable();
  const sql = getDbOrThrow();
  const nowStr = new Date().toISOString();

  // 1. Cancel dataset build jobs
  const cancelledDatasetJobs = await cancelAllRunningAutoDatasetJobs();

  // 2. Cancel running/queued training runs
  let cancelledTrainingRuns = 0;
  try {
    const cancelledRuns = await sql`
      UPDATE ml_training_runs
      SET status = 'cancelled',
          error = 'Emergency HALT triggered by user via Worker Control Center.',
          completed_at = COALESCE(completed_at, NOW()),
          heartbeat_at = NULL,
          updated_at = NOW()
      WHERE status IN ('running', 'queued')
      RETURNING run_id
    `;
    cancelledTrainingRuns = cancelledRuns.length;

    await sql`
      UPDATE ml_training_run_models
      SET status = 'cancelled',
          error = 'Emergency HALT triggered by user via Worker Control Center.',
          completed_at = COALESCE(completed_at, NOW()),
          heartbeat_at = NULL
      WHERE status IN ('running', 'queued')
    `;

    await sql`DELETE FROM ml_training_run_reservations`;
  } catch (err) {
    console.error('[worker-control-store] Error cancelling training runs during halt:', err);
  }

  // 3. Pause Queue Worker
  await updateQueueWorkerRuntimeConfig({
    isPaused: true,
    pauseReason: 'Emergency HALT triggered by user authorization.',
    updatedBy,
  });

  // 4. Update Master Automation Switch
  await updateWorkerConfigKey('master_automation_switch', {
    mode: 'manual',
    globalKillSwitch: true,
    lastEmergencyHaltAt: nowStr,
    haltedBy: updatedBy,
  }, updatedBy);

  // 5. Disable Dataset Worker & Retraining Worker in config
  await updateWorkerConfigKey('dataset_builder_worker', { enabled: false, maxConcurrentJobs: 2, autoResumeOnLoad: false }, updatedBy);
  await updateWorkerConfigKey('retraining_automation', { enabled: false, intervalHours: 24, minAccuracyThreshold: 0.55 }, updatedBy);

  return {
    cancelledDatasetJobs,
    cancelledTrainingRuns,
    haltedAt: nowStr,
  };
}

/**
 * Restores system from Emergency Halt back to Normal Manual or Autonomous operation
 */
export async function releaseEmergencyHalt(newMode: MasterAutomationMode = 'manual', updatedBy = 'admin'): Promise<void> {
  await ensureOpsRuntimeConfigTable();
  await updateWorkerConfigKey('master_automation_switch', {
    mode: newMode,
    globalKillSwitch: false,
    lastEmergencyHaltAt: null,
    haltedBy: null,
  }, updatedBy);

  if (newMode === 'manual') {
    await updateQueueWorkerRuntimeConfig({
      isPaused: false,
      pauseReason: null,
      updatedBy,
    });
  }
}
