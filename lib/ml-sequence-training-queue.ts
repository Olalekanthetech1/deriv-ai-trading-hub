import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from './db';
import { getQueueWorkerRuntimeConfig } from './ops-runtime-config';
import { parseSequenceTrainingDatasetRef, type SequenceTrainingDatasetRef } from './ml-sequence-training-contract';

type SequenceQueueStatus = 'queued' | 'running' | 'completed' | 'failed';

export type SequenceTrainingQueueRequest = {
  datasetRef: SequenceTrainingDatasetRef;
  modelTypes?: string[];
  priority?: number;
  batchId?: string;
  batchItemId?: number;
};

export type SequenceTrainingQueueJob = {
  jobId: string;
  datasetId: string;
  sourceDatasetId: string;
  sourceType: 'duration' | 'unified';
  horizonKey: string | null;
  modelTypes: string[];
  status: SequenceQueueStatus;
  priority: number;
  attempts: number;
  workerId: string | null;
  trainingRunId: string | null;
  batchId: string | null;
  batchItemId: number | null;
  heartbeatAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

let schemaReady = false;

function queueWorkerLeaseMs(): number {
  const raw = Number(process.env.ML_WORKER_LEASE_TIMEOUT_MS || 90_000);
  if (!Number.isFinite(raw)) return 90_000;
  return Math.min(10 * 60 * 1000, Math.max(30_000, Math.trunc(raw)));
}

async function getSequenceQueueDb() {
  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) return null;

  const sql = neon(url);
  if (!schemaReady) {
    await sql`
      CREATE TABLE IF NOT EXISTS ml_sequence_training_job_queue (
        job_id UUID PRIMARY KEY,
        dataset_id UUID NOT NULL,
        source_dataset_id UUID NOT NULL,
        source_type VARCHAR(16) NOT NULL,
        horizon_key VARCHAR(128),
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
      )
    `;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_sequence_queue_active_unified_horizon
      ON ml_sequence_training_job_queue (source_dataset_id, horizon_key)
      WHERE status IN ('queued','running') AND source_type = 'unified'
    `;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_sequence_queue_active_duration_dataset
      ON ml_sequence_training_job_queue (dataset_id)
      WHERE status IN ('queued','running') AND source_type = 'duration'
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_ml_sequence_queue_claim
      ON ml_sequence_training_job_queue (status, priority, available_at, created_at)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_ml_sequence_queue_source
      ON ml_sequence_training_job_queue (source_type, source_dataset_id, horizon_key, status)
    `;
    schemaReady = true;
  }

  return sql;
}

function mapSequenceQueueJob(row: any): SequenceTrainingQueueJob {
  return {
    jobId: String(row.job_id),
    datasetId: String(row.dataset_id),
    sourceDatasetId: String(row.source_dataset_id),
    sourceType: row.source_type === 'unified' ? 'unified' : 'duration',
    horizonKey: row.horizon_key ? String(row.horizon_key) : null,
    modelTypes: Array.isArray(row.model_types) ? row.model_types.map(String) : [],
    status: String(row.status) as SequenceQueueStatus,
    priority: Number(row.priority ?? 5),
    attempts: Number(row.attempts ?? 0),
    workerId: row.worker_id ? String(row.worker_id) : null,
    trainingRunId: row.training_run_id ? String(row.training_run_id) : null,
    batchId: row.batch_id ? String(row.batch_id) : null,
    batchItemId: row.batch_item_id == null ? null : Number(row.batch_item_id),
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null,
    error: row.error ? String(row.error) : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function enqueueSequenceTrainingJob(
  request: SequenceTrainingQueueRequest,
): Promise<SequenceTrainingQueueJob> {
  const datasetRef = parseSequenceTrainingDatasetRef(request.datasetRef);
  const sql = await getSequenceQueueDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');

  const sourceType = datasetRef.source.sourceType;
  const sourceDatasetId = datasetRef.source.sourceDatasetId;
  const horizonKey = sourceType === 'unified' ? datasetRef.source.horizonKey : datasetRef.source.horizonKey ?? null;
  const priority = Number.isSafeInteger(request.priority) && request.priority! >= 1 && request.priority! <= 10
    ? request.priority!
    : 5;

  if (sourceType === 'unified' && !horizonKey) {
    throw new Error('UNIFIED_SEQUENCE_REQUIRES_HORIZON');
  }

  const jobId = crypto.randomUUID();
  try {
    const rows = await sql`
      INSERT INTO ml_sequence_training_job_queue (
        job_id,dataset_id,source_dataset_id,source_type,horizon_key,model_types,status,
        priority,batch_id,batch_item_id
      ) VALUES (
        ${jobId}::uuid,
        ${sourceDatasetId}::uuid,
        ${sourceDatasetId}::uuid,
        ${sourceType}::varchar,
        ${horizonKey}::varchar,
        ${JSON.stringify(request.modelTypes || [])}::jsonb,
        'queued'::varchar,
        ${priority}::int,
        ${request.batchId || null}::uuid,
        ${request.batchItemId ?? null}::bigint
      )
      RETURNING job_id,dataset_id,source_dataset_id,source_type,horizon_key,model_types,status,
        priority,attempts,worker_id,training_run_id,batch_id,batch_item_id,heartbeat_at,error,created_at,updated_at
    `;
    return mapSequenceQueueJob(rows[0]);
  } catch (error: any) {
    if (String(error?.code || '').toLowerCase() === '23505') {
      throw new Error('SEQUENCE_TRAINING_ALREADY_QUEUED');
    }
    throw error;
  }
}

export async function listSequenceTrainingQueueJobs(): Promise<SequenceTrainingQueueJob[]> {
  const sql = await getSequenceQueueDb();
  if (!sql) return [];
  const rows = await sql`
    SELECT job_id,dataset_id,source_dataset_id,source_type,horizon_key,model_types,status,
      priority,attempts,worker_id,training_run_id,batch_id,batch_item_id,heartbeat_at,error,created_at,updated_at
    FROM ml_sequence_training_job_queue
    ORDER BY CASE WHEN status='running' THEN 1 WHEN status='queued' THEN 2 ELSE 3 END,
      priority ASC, created_at DESC
    LIMIT 100
  `;
  return rows.map(mapSequenceQueueJob);
}

export async function claimNextSequenceTrainingJob(workerId: string): Promise<SequenceTrainingQueueJob | null> {
  const config = await getQueueWorkerRuntimeConfig();
  if (config.isPaused) return null;

  const sql = await getSequenceQueueDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');
  const maxConcurrency = Math.max(1, config.concurrencyLimit);

  const rows = await sql`
    WITH candidate AS (
      SELECT job_id
      FROM ml_sequence_training_job_queue
      WHERE status='queued'
        AND available_at <= NOW()
        AND (SELECT COUNT(*)::int FROM ml_sequence_training_job_queue WHERE status='running') < ${maxConcurrency}
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ml_sequence_training_job_queue q
    SET status='running'::varchar,worker_id=${workerId}::text,
      attempts=q.attempts+1,heartbeat_at=NOW(),updated_at=NOW()
    FROM candidate
    WHERE q.job_id=candidate.job_id
    RETURNING q.job_id,q.dataset_id,q.source_dataset_id,q.source_type,q.horizon_key,q.model_types,q.status,
      q.priority,q.attempts,q.worker_id,q.training_run_id,q.batch_id,q.batch_item_id,q.heartbeat_at,q.error,q.created_at,q.updated_at
  `;
  if (!rows.length) return null;
  return mapSequenceQueueJob(rows[0]);
}

export async function heartbeatSequenceTrainingJob(
  jobId: string,
  workerId: string,
  trainingRunId?: string,
): Promise<boolean> {
  const sql = await getSequenceQueueDb();
  if (!sql) return false;
  const rows = await sql`
    UPDATE ml_sequence_training_job_queue
    SET heartbeat_at=NOW(),
      training_run_id=COALESCE(${trainingRunId || null}::uuid,training_run_id),
      updated_at=NOW()
    WHERE job_id=${jobId}::uuid AND worker_id=${workerId}::text AND status='running'
    RETURNING job_id
  `;
  return rows.length > 0;
}

export async function finishSequenceTrainingJob(
  jobId: string,
  workerId: string,
  status: 'completed' | 'failed',
  error?: string,
  trainingRunId?: string,
): Promise<boolean> {
  const sql = await getSequenceQueueDb();
  if (!sql) return false;
  const rows = await sql`
    UPDATE ml_sequence_training_job_queue
    SET status=${status}::varchar,
      error=${error || null}::text,
      training_run_id=COALESCE(${trainingRunId || null}::uuid,training_run_id),
      heartbeat_at=NULL,
      updated_at=NOW()
    WHERE job_id=${jobId}::uuid AND worker_id=${workerId}::text AND status='running'
    RETURNING job_id
  `;
  return rows.length > 0;
}

export async function recoverAbandonedSequenceTrainingJobs(): Promise<number> {
  const sql = await getSequenceQueueDb();
  if (!sql) return 0;
  const leaseMs = queueWorkerLeaseMs();
  const rows = await sql`
    SELECT q.job_id
    FROM ml_sequence_training_job_queue q
    LEFT JOIN ml_training_worker_heartbeats w ON w.worker_id=q.worker_id
    WHERE q.status='running'
      AND (
        w.worker_id IS NULL
        OR w.heartbeat_at < NOW() - (${leaseMs}::bigint * INTERVAL '1 millisecond')
      )
  `;
  for (const row of rows) {
    await sql`
      UPDATE ml_sequence_training_job_queue
      SET status='queued'::varchar,
        worker_id=NULL,
        heartbeat_at=NULL,
        error='Sequence worker lease expired; job returned to queue.'::text,
        available_at=NOW(),
        updated_at=NOW()
      WHERE job_id=${String(row.job_id)}::uuid AND status='running'
    `;
  }
  return rows.length;
}
