import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from './db';
import { getQueueWorkerRuntimeConfig } from './ops-runtime-config';

type QueueStatus = 'queued' | 'running' | 'completed' | 'failed';
export type TrainingQueueRequest = { datasetId: string; modelTypes?: string[]; batchId?: string; batchItemId?: number; priority?: number };
export type TrainingQueueJob = {
  jobId: string;
  datasetId: string;
  modelTypes: string[];
  status: QueueStatus;
  priority: number;
  attempts: number;
  workerId?: string | null;
  trainingRunId?: string | null;
  batchId?: string | null;
  batchItemId?: number | null;
  heartbeatAt?: string | null;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
};
export type TrainingQueueResult = { trainingRunId?: string; status?: string; completedModels?: number; failedModels?: number; error?: string };

export type WorkerTelemetryMetrics = {
  heapUsedMb?: number;
  heapTotalMb?: number;
  rssMb?: number;
  externalMb?: number;
  systemFreeMemMb?: number;
  systemTotalMemMb?: number;
  systemMemoryUsagePct?: number;
  loadAverage?: [number, number, number];
  cpuPercent?: number;
  uptimeSecs?: number;
  pid?: number;
  nodeVersion?: string;
  activeJobsCount?: number;
  processedJobsCount?: number;
};

export type WorkerHeartbeatInfo = {
  workerId: string;
  workerType: 'training_worker' | 'dataset_worker' | 'scheduler';
  status: 'online' | 'stale' | 'stopping';
  heartbeatAt: string;
  metrics: WorkerTelemetryMetrics | null;
  ageMs: number;
};

export type WorkerStatus = {
  workerId: string | null;
  status: 'online' | 'stale' | 'offline';
  heartbeatAt: string | null;
  metrics?: WorkerTelemetryMetrics | null;
  allWorkers?: WorkerHeartbeatInfo[];
};

let schemaReady = false;

function durationEnvMs(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = Number(process.env[name] || fallback);
  return Number.isFinite(raw) ? Math.min(maximum, Math.max(minimum, Math.trunc(raw))) : fallback;
}

function workerLeaseTimeoutMs(): number {
  return durationEnvMs('ML_WORKER_LEASE_TIMEOUT_MS', 90_000, 30_000, 10 * 60 * 1000);
}

async function getQueueDb() {
  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) return null;
  const sql = neon(url);
  if (!schemaReady) {
    await sql`CREATE TABLE IF NOT EXISTS ml_training_job_queue (
      job_id UUID PRIMARY KEY,
      dataset_id UUID NOT NULL,
      model_types JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 5,
      attempts INTEGER NOT NULL DEFAULT 0,
      worker_id VARCHAR(160),
      training_run_id UUID,
      batch_id UUID,
      batch_item_id BIGINT,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      heartbeat_at TIMESTAMPTZ,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`ALTER TABLE ml_training_job_queue ADD COLUMN IF NOT EXISTS batch_id UUID`;
    await sql`ALTER TABLE ml_training_job_queue ADD COLUMN IF NOT EXISTS batch_item_id BIGINT`;
    await sql`ALTER TABLE ml_training_job_queue ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 5`;
    await sql`CREATE INDEX IF NOT EXISTS idx_ml_training_queue_claim ON ml_training_job_queue (status, priority, available_at, created_at)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_training_queue_active_dataset ON ml_training_job_queue (dataset_id) WHERE status IN ('queued','running')`;
    await sql`CREATE TABLE IF NOT EXISTS ml_training_worker_heartbeats (
      worker_id VARCHAR(160) PRIMARY KEY,
      worker_type VARCHAR(32) NOT NULL DEFAULT 'training_worker',
      status VARCHAR(24) NOT NULL DEFAULT 'online',
      metrics JSONB,
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`ALTER TABLE ml_training_worker_heartbeats ADD COLUMN IF NOT EXISTS worker_type VARCHAR(32) NOT NULL DEFAULT 'training_worker'`;
    await sql`ALTER TABLE ml_training_worker_heartbeats ADD COLUMN IF NOT EXISTS metrics JSONB`;
    schemaReady = true;
  }
  return sql;
}

export async function recordWorkerHeartbeat(
  workerId: string,
  status: 'online' | 'stopping' = 'online',
  workerType: 'training_worker' | 'dataset_worker' | 'scheduler' = 'training_worker',
  metrics?: WorkerTelemetryMetrics
) {
  const sql = await getQueueDb();
  if (!sql) return;
  const metricsJson = metrics ? JSON.stringify(metrics) : null;
  await sql`
    INSERT INTO ml_training_worker_heartbeats (worker_id,worker_type,status,metrics,heartbeat_at,updated_at)
    VALUES (${workerId}::text,${workerType}::varchar,${status}::varchar,${metricsJson}::jsonb,NOW(),NOW())
    ON CONFLICT (worker_id) DO UPDATE SET
      worker_type=EXCLUDED.worker_type,
      status=EXCLUDED.status,
      metrics=COALESCE(EXCLUDED.metrics, ml_training_worker_heartbeats.metrics),
      heartbeat_at=NOW(),
      updated_at=NOW()
  `;
}

export async function flushStaleWorkerHeartbeats(): Promise<number> {
  const sql = await getQueueDb();
  if (!sql) return 0;
  const staleMs = workerLeaseTimeoutMs();
  const rows = await sql`
    DELETE FROM ml_training_worker_heartbeats
    WHERE status = 'stale'
       OR heartbeat_at < NOW() - (${staleMs}::bigint * INTERVAL '1 millisecond')
    RETURNING worker_id
  `;
  return rows.length;
}

export async function listActiveWorkers(): Promise<WorkerHeartbeatInfo[]> {
  const sql = await getQueueDb();
  if (!sql) return [];
  const staleMs = workerLeaseTimeoutMs();

  // Automatically prune dead workers older than 2x the lease timeout (e.g. 3 minutes)
  try {
    await sql`
      DELETE FROM ml_training_worker_heartbeats
      WHERE status = 'stale'
         OR heartbeat_at < NOW() - (${Math.max(staleMs * 2, 180_000)}::bigint * INTERVAL '1 millisecond')
    `;
  } catch (err) {
    // Non-blocking auto-purge
  }

  const rows = await sql`
    SELECT worker_id, worker_type, status, metrics, heartbeat_at
    FROM ml_training_worker_heartbeats
    ORDER BY heartbeat_at DESC
    LIMIT 20
  `;
  const now = Date.now();
  return rows.map((r) => {
    const hb = r.heartbeat_at ? new Date(r.heartbeat_at).getTime() : 0;
    const ageMs = Math.max(0, now - hb);
    const isStale = ageMs > staleMs;
    return {
      workerId: String(r.worker_id),
      workerType: (r.worker_type as any) || 'training_worker',
      status: isStale ? 'stale' : String(r.status) === 'stopping' ? 'stopping' : 'online',
      heartbeatAt: r.heartbeat_at ? new Date(r.heartbeat_at).toISOString() : new Date().toISOString(),
      metrics: r.metrics && typeof r.metrics === 'object' ? r.metrics : null,
      ageMs,
    };
  });
}

export async function getWorkerStatus(): Promise<WorkerStatus> {
  const sql = await getQueueDb();
  if (!sql) return { workerId: null, status: 'offline', heartbeatAt: null, metrics: null, allWorkers: [] };
  const allWorkers = await listActiveWorkers();
  if (!allWorkers.length) return { workerId: null, status: 'offline', heartbeatAt: null, metrics: null, allWorkers: [] };

  const primary = allWorkers[0];
  return {
    workerId: primary.workerId,
    status: primary.status === 'stopping' ? 'stale' : primary.status,
    heartbeatAt: primary.heartbeatAt,
    metrics: primary.metrics,
    allWorkers,
  };
}

export async function enqueueTrainingJob(request: TrainingQueueRequest): Promise<TrainingQueueJob> {
  if (!request.datasetId) throw new Error('datasetId is required.');
  const sql = await getQueueDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');
  const jobId = crypto.randomUUID();
  const priority = Number.isSafeInteger(request.priority) && request.priority! >= 1 && request.priority! <= 10
    ? request.priority!
    : 5;

  try {
    const rows = await sql`
      INSERT INTO ml_training_job_queue (job_id,dataset_id,model_types,status,priority,batch_id,batch_item_id)
      VALUES (${jobId}::uuid,${request.datasetId}::uuid,${JSON.stringify(request.modelTypes || [])}::jsonb,'queued'::varchar,${priority}::int,${request.batchId || null}::uuid,${request.batchItemId ?? null}::bigint)
      RETURNING job_id,dataset_id,model_types,status,priority,attempts,worker_id,training_run_id,batch_id,batch_item_id,heartbeat_at,error,created_at,updated_at
    `;
    return mapQueueJob(rows[0]);
  } catch (error: any) {
    if (String(error?.code || '').toLowerCase() === '23505') throw new Error('TRAINING_ALREADY_QUEUED');
    throw error;
  }
}

export async function updateTrainingJobPriority(jobId: string, priority: number): Promise<boolean> {
  const sql = await getQueueDb();
  if (!sql) return false;
  const clamped = Math.max(1, Math.min(10, Math.round(priority)));
  const rows = await sql`
    UPDATE ml_training_job_queue
    SET priority = ${clamped}::int, updated_at = NOW()
    WHERE job_id = ${jobId}::uuid
    RETURNING job_id
  `;
  return rows.length > 0;
}

export async function listTrainingQueueJobs(): Promise<TrainingQueueJob[]> {
  const sql = await getQueueDb();
  if (!sql) return [];
  const rows = await sql`
    SELECT job_id,dataset_id,model_types,status,priority,attempts,worker_id,training_run_id,batch_id,batch_item_id,heartbeat_at,error,created_at,updated_at
    FROM ml_training_job_queue
    ORDER BY 
      CASE WHEN status = 'running' THEN 1 WHEN status = 'queued' THEN 2 ELSE 3 END,
      priority ASC,
      created_at DESC
    LIMIT 100
  `;
  return rows.map(mapQueueJob);
}

export async function claimNextTrainingJob(workerId: string): Promise<TrainingQueueJob | null> {
  const config = await getQueueWorkerRuntimeConfig();
  if (config.isPaused) {
    return null;
  }

  const sql = await getQueueDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');
  const maxConcurrency = Math.max(1, config.concurrencyLimit);

  const rows = await sql`
    WITH candidate AS (
      SELECT job_id
      FROM ml_training_job_queue
      WHERE status='queued'
        AND available_at <= NOW()
        AND (SELECT COUNT(*)::int FROM ml_training_job_queue WHERE status='running') < ${maxConcurrency}
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ml_training_job_queue q
    SET status='running'::varchar,worker_id=${workerId}::text,attempts=q.attempts+1,heartbeat_at=NOW(),updated_at=NOW()
    FROM candidate WHERE q.job_id=candidate.job_id
    RETURNING q.job_id,q.dataset_id,q.model_types,q.status,q.priority,q.attempts,q.worker_id,q.training_run_id,q.batch_id,q.batch_item_id,q.heartbeat_at,q.error,q.created_at,q.updated_at
  `;
  if (!rows.length) return null;
  const job = mapQueueJob(rows[0]);
  if (job.batchId) {
    await sql`UPDATE ml_training_batches SET status='running'::varchar,worker_id=${workerId}::text,heartbeat_at=NOW(),started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE batch_id=${job.batchId}::uuid AND status IN ('queued','partial','running')`;
    if (job.batchItemId) await sql`UPDATE ml_training_batch_items SET status='running'::varchar,started_at=COALESCE(started_at,NOW()),heartbeat_at=NOW(),updated_at=NOW() WHERE id=${job.batchItemId}::bigint AND status IN ('queued','partial')`;
  }
  return job;
}

export async function heartbeatTrainingJob(jobId: string, workerId: string, trainingRunId?: string) {
  const sql = await getQueueDb();
  if (!sql) return;
  const rows = await sql`UPDATE ml_training_job_queue SET heartbeat_at=NOW(),training_run_id=COALESCE(${trainingRunId || null}::uuid,training_run_id),updated_at=NOW() WHERE job_id=${jobId}::uuid AND worker_id=${workerId}::text AND status='running' RETURNING batch_id`;
  const batchId = rows[0]?.batch_id ? String(rows[0].batch_id) : null;
  if (batchId) await sql`UPDATE ml_training_batches SET heartbeat_at=NOW(),updated_at=NOW() WHERE batch_id=${batchId}::uuid AND status IN ('queued','running','partial')`;
}

export async function finishTrainingJob(jobId: string, workerId: string, status: 'completed' | 'failed', error?: string, trainingRunId?: string, result?: TrainingQueueResult) {
  const sql = await getQueueDb();
  if (!sql) return;
  const errorText = error || result?.error || null;
  const resolvedTrainingRunId = trainingRunId || result?.trainingRunId || null;
  const rows = await sql`UPDATE ml_training_job_queue SET status=${status}::varchar,error=${errorText}::text,training_run_id=COALESCE(${resolvedTrainingRunId}::uuid,training_run_id),heartbeat_at=NULL,updated_at=NOW() WHERE job_id=${jobId}::uuid AND worker_id=${workerId}::text RETURNING batch_id,batch_item_id`;
  const batchId = rows[0]?.batch_id ? String(rows[0].batch_id) : null;
  const batchItemId = rows[0]?.batch_item_id ? Number(rows[0].batch_item_id) : null;
  if (!batchId || !batchItemId) return;
  const completedModels = Number(result?.completedModels || 0);
  const failedModels = Number(result?.failedModels || (status === 'failed' ? 1 : 0));
  const itemStatus = status === 'failed' ? 'failed' : failedModels > 0 && completedModels > 0 ? 'partial' : 'completed';
  await sql`UPDATE ml_training_batch_items SET status=${itemStatus}::varchar,run_id=${resolvedTrainingRunId}::uuid,completed_models=${completedModels}::int,failed_models=${failedModels}::int,completed_at=NOW(),heartbeat_at=NULL,error=${errorText}::text,updated_at=NOW() WHERE id=${batchItemId}::bigint`;
  const counts = await sql`
    SELECT COUNT(*)::int AS total_items,
      COUNT(*) FILTER (WHERE status IN ('completed','skipped'))::int AS done_items,
      COUNT(*) FILTER (WHERE status IN ('failed','partial'))::int AS failed_items,
      COALESCE(SUM(completed_models),0)::int AS completed_jobs,
      COALESCE(SUM(failed_models),0)::int AS failed_jobs,
      COUNT(*) FILTER (WHERE status='skipped')::int AS skipped_items
    FROM ml_training_batch_items WHERE batch_id=${batchId}::uuid
  `;
  const row = counts[0];
  const done = Number(row?.done_items || 0);
  const total = Number(row?.total_items || 0);
  const terminal = done >= total;
  const batchStatus = terminal ? (Number(row?.failed_items || 0) === 0 ? 'completed' : Number(row?.completed_jobs || 0) > 0 || Number(row?.skipped_items || 0) > 0 ? 'partial' : 'failed') : 'running';
  const completedAt = terminal ? new Date().toISOString() : null;
  const heartbeatAt = terminal ? null : new Date().toISOString();
  await sql`UPDATE ml_training_batches SET status=${batchStatus}::varchar,completed_jobs=${Number(row?.completed_jobs || 0)}::int,failed_jobs=${Number(row?.failed_jobs || 0)}::int,skipped_jobs=${Number(row?.skipped_items || 0)}::int,completed_at=${completedAt}::timestamptz,heartbeat_at=${heartbeatAt}::timestamptz,updated_at=NOW() WHERE batch_id=${batchId}::uuid`;
}

export async function recoverAbandonedTrainingJobs(): Promise<number> {
  const sql = await getQueueDb();
  if (!sql) return 0;
  const leaseMs = workerLeaseTimeoutMs();
  const rows = await sql`
    SELECT q.job_id,q.training_run_id,q.batch_id,q.batch_item_id,q.worker_id
    FROM ml_training_job_queue q
    LEFT JOIN ml_training_worker_heartbeats w ON w.worker_id=q.worker_id
    WHERE q.status='running'
      AND (
        w.worker_id IS NULL
        OR (w.heartbeat_at < NOW() - (${leaseMs}::bigint * INTERVAL '1 millisecond'))
      )
  `;
  if (!rows.length) return 0;

  for (const row of rows) {
    const jobId = String(row.job_id);
    const trainingRunId = row.training_run_id ? String(row.training_run_id) : null;
    if (trainingRunId) {
      await sql`UPDATE ml_training_run_models SET status='timed_out',error='ML worker lease expired; training run was interrupted by worker loss.',completed_at=COALESCE(completed_at,NOW()),heartbeat_at=NULL WHERE run_id=${trainingRunId}::uuid AND status IN ('running','queued')`;
      await sql`UPDATE ml_training_runs SET status='timed_out',error='ML worker lease expired; training run was interrupted by worker loss.',completed_at=COALESCE(completed_at,NOW()),heartbeat_at=NULL,updated_at=NOW() WHERE run_id=${trainingRunId}::uuid AND status='running'`;
    }
    if (row.batch_item_id) {
      await sql`UPDATE ml_training_batch_items SET status='queued',heartbeat_at=NULL,error='ML worker lease expired; item returned to queue.',updated_at=NOW() WHERE id=${Number(row.batch_item_id)}::bigint AND status='running'`;
    }
    if (row.batch_id) {
      await sql`UPDATE ml_training_batches SET status='queued',worker_id=NULL,heartbeat_at=NULL,error='ML worker lease expired; batch returned to queue.',updated_at=NOW() WHERE batch_id=${String(row.batch_id)}::uuid AND status IN ('running','partial')`;
    }
    await sql`UPDATE ml_training_job_queue SET status='queued',worker_id=NULL,heartbeat_at=NULL,error='ML worker lease expired; job returned to queue.',available_at=NOW(),updated_at=NOW() WHERE job_id=${jobId}::uuid AND status='running'`;
  }
  return rows.length;
}

function mapQueueJob(row:any): TrainingQueueJob {
  return {
    jobId: String(row.job_id),
    datasetId: String(row.dataset_id),
    modelTypes: Array.isArray(row?.model_types) ? row.model_types.map(String) : [],
    status: String(row.status) as QueueStatus,
    priority: Number(row.priority ?? 5),
    attempts: Number(row.attempts || 0),
    workerId: row.worker_id ? String(row.worker_id) : null,
    trainingRunId: row.training_run_id ? String(row.training_run_id) : null,
    batchId: row.batch_id ? String(row.batch_id) : null,
    batchItemId: row.batch_item_id ? Number(row.batch_item_id) : null,
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null,
    error: row.error ? String(row.error) : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  };
}
