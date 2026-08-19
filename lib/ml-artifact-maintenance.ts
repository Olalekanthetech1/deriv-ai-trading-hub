import crypto from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from './db';
import { persistModelArtifact, hasModelArtifact } from './ml-model-artifact-store';

type MaintenanceStatus = 'queued' | 'running' | 'completed' | 'failed';
export type ArtifactMaintenanceJob = {
  jobId: string;
  status: MaintenanceStatus;
  workerId?: string | null;
  attempts: number;
  heartbeatAt?: string | null;
  error?: string | null;
  summary?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
};

async function getDb() {
  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) return null;
  const sql = neon(url);
  await sql`
    CREATE TABLE IF NOT EXISTS ml_artifact_maintenance_jobs (
      job_id UUID PRIMARY KEY,
      operation VARCHAR(32) NOT NULL DEFAULT 'backfill',
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      worker_id VARCHAR(160),
      heartbeat_at TIMESTAMPTZ,
      error TEXT,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_artifact_maintenance_status ON ml_artifact_maintenance_jobs(status, created_at)`;
  return sql;
}

function mapJob(row: any): ArtifactMaintenanceJob {
  return {
    jobId: String(row.job_id),
    status: String(row.status) as MaintenanceStatus,
    workerId: row.worker_id ? String(row.worker_id) : null,
    attempts: Number(row.attempts || 0),
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null,
    error: row.error ? String(row.error) : null,
    summary: row.summary && typeof row.summary === 'object' ? row.summary : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  };
}

export async function enqueueArtifactBackfill(): Promise<ArtifactMaintenanceJob> {
  const sql = await getDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');
  const active = await sql`SELECT job_id,status FROM ml_artifact_maintenance_jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`;
  if (active.length) throw new Error(`ARTIFACT_BACKFILL_ALREADY_ACTIVE:${String(active[0].job_id)}`);
  const jobId = crypto.randomUUID();
  const rows = await sql`
    INSERT INTO ml_artifact_maintenance_jobs (job_id, operation, status)
    VALUES (${jobId}::uuid, 'backfill', 'queued')
    RETURNING job_id,status,attempts,worker_id,heartbeat_at,error,summary,created_at,updated_at
  `;
  return mapJob(rows[0]);
}

export async function getLatestArtifactMaintenanceJob(): Promise<ArtifactMaintenanceJob | null> {
  const sql = await getDb();
  if (!sql) return null;
  const rows = await sql`SELECT job_id,status,attempts,worker_id,heartbeat_at,error,summary,created_at,updated_at FROM ml_artifact_maintenance_jobs ORDER BY created_at DESC LIMIT 1`;
  return rows.length ? mapJob(rows[0]) : null;
}

export async function claimArtifactBackfill(workerId: string): Promise<ArtifactMaintenanceJob | null> {
  const sql = await getDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');
  const rows = await sql`
    WITH candidate AS (
      SELECT job_id FROM ml_artifact_maintenance_jobs
      WHERE status='queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ml_artifact_maintenance_jobs j
    SET status='running', worker_id=${workerId}::varchar, attempts=j.attempts+1, heartbeat_at=NOW(), updated_at=NOW()
    FROM candidate WHERE j.job_id=candidate.job_id
    RETURNING j.job_id,j.status,j.attempts,j.worker_id,j.heartbeat_at,j.error,j.summary,j.created_at,j.updated_at
  `;
  return rows.length ? mapJob(rows[0]) : null;
}

export async function heartbeatArtifactBackfill(jobId: string, workerId: string) {
  const sql = await getDb();
  if (!sql) return;
  await sql`UPDATE ml_artifact_maintenance_jobs SET heartbeat_at=NOW(),updated_at=NOW() WHERE job_id=${jobId}::uuid AND worker_id=${workerId}::varchar AND status='running'`;
}

export async function finishArtifactBackfill(jobId: string, workerId: string, status: 'completed' | 'failed', summary: Record<string, unknown>, error?: string) {
  const sql = await getDb();
  if (!sql) return;
  await sql`UPDATE ml_artifact_maintenance_jobs SET status=${status}::varchar,error=${error || null}::text,summary=${JSON.stringify(summary)}::jsonb,heartbeat_at=NULL,updated_at=NOW() WHERE job_id=${jobId}::uuid AND worker_id=${workerId}::varchar`;
}

export async function inspectArtifactBackfill(): Promise<{ totalProduction: number; healthy: number; missing: number; models: Array<Record<string, unknown>> }> {
  const sql = await getDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');
  const rows = await sql`
    SELECT model_id, asset_symbol, duration_value, duration_unit, training_run_id, dataset_id, feature_schema_version, metrics, updated_at
    FROM ml_model_registry_v2
    WHERE status='production'
    ORDER BY asset_symbol, duration_value, duration_unit, updated_at DESC
  `;
  const models = await Promise.all((rows as any[]).map(async (row) => {
    const modelId = String(row.model_id);
    const present = await hasModelArtifact(modelId);
    const metrics = row.metrics && typeof row.metrics === 'object' ? row.metrics : {};
    return {
      modelId,
      symbol: String(row.asset_symbol),
      durationValue: Number(row.duration_value),
      durationUnit: String(row.duration_unit),
      trainingRunId: row.training_run_id ? String(row.training_run_id) : null,
      datasetId: row.dataset_id ? String(row.dataset_id) : null,
      featureSchemaVersion: String(row.feature_schema_version || ''),
      modelKey: String(metrics.modelKey || row.model_id).toLowerCase(),
      artifactPresent: present,
      healthy: present && Boolean(row.training_run_id) && Boolean(row.dataset_id) && Boolean(row.feature_schema_version),
      updatedAt: row.updated_at,
    };
  }));
  return {
    totalProduction: models.length,
    healthy: models.filter((model) => model.healthy).length,
    missing: models.filter((model) => !model.artifactPresent).length,
    models,
  };
}

export async function executeArtifactBackfill(): Promise<Record<string, unknown>> {
  const sql = await getDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');
  const modelCacheDir = path.resolve(/*turbopackIgnore: true*/ process.env.MODEL_CACHE_DIR || path.join(process.cwd(), 'models_cache'));
  const files = await readdir(modelCacheDir).catch(() => [] as string[]);
  const rows = await sql`
    SELECT model_id, asset_symbol, duration_value, duration_unit, model_family, training_run_id
    FROM ml_model_registry_v2
    WHERE status='production'
    ORDER BY updated_at DESC
  `;

  let persisted = 0;
  let alreadyHealthy = 0;
  let missing = 0;
  const failures: Array<Record<string, string>> = [];

  for (const row of rows as any[]) {
    const modelId = String(row.model_id);
    if (await hasModelArtifact(modelId)) {
      alreadyHealthy += 1;
      continue;
    }
    const symbol = String(row.asset_symbol).replace(/[^A-Za-z0-9_.-]/g, '');
    const duration = `${String(row.duration_unit)}${Number(row.duration_value)}`;
    const family = String(row.model_family).replace(/[^A-Za-z0-9_.-]/g, '');
    const prefix = `${symbol}_${duration}_${family}`;
    const candidates = files.filter((file) => file.startsWith(prefix) && file.endsWith('.pkl'));
    if (!candidates.length) {
      missing += 1;
      failures.push({ modelId, code: 'MISSING_LOCAL_ARTIFACT', prefix });
      continue;
    }
    const lineage = String(row.training_run_id || '').slice(0, 12);
    const exact = candidates.find((file) => lineage && file.includes(lineage)) || candidates[0];
    try {
      const result = await persistModelArtifact(modelId, path.join(modelCacheDir, exact));
      persisted += 1;
      failures.push({ modelId, code: `PERSISTED:${result.sha256}` });
    } catch (error) {
      failures.push({ modelId, code: error instanceof Error ? error.message : String(error) });
    }
  }

  return { totalProduction: rows.length, persisted, alreadyHealthy, missing, failures };
}
