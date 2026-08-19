import { randomUUID } from 'node:crypto';
import { getDbOrThrow } from '@/lib/db';
import type { DerivDurationUnit } from '@/lib/deriv-duration-registry';

export type AutoDatasetJobStatus = 'running' | 'completed' | 'failed';
export type AutoDatasetJob = {
  id: string;
  symbol: string;
  status: AutoDatasetJobStatus;
  requestedCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  cancelledCount: number;
  failures: Array<{ value: number; unit: DerivDurationUnit; error: string }>;
  skips: Array<{ value: number; unit: DerivDurationUnit; reason: string }>;
  startedAt: string;
  finishedAt?: string;
  archivedAt?: string;
};
export type AutoDatasetJobItem = { id: number; itemIndex: number; value: number; unit: DerivDurationUnit; rangeId: string | null; attempts: number };
export type AutoDatasetJobItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

let schemaReady: Promise<void> | null = null;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = getDbOrThrow();
    await sql`CREATE TABLE IF NOT EXISTS ops_ml_dataset_build_jobs (id UUID PRIMARY KEY, symbol VARCHAR(64) NOT NULL, status VARCHAR(24) NOT NULL, requested_count INTEGER NOT NULL DEFAULT 0, completed_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0, cancelled_count INTEGER NOT NULL DEFAULT 0, failures JSONB NOT NULL DEFAULT '[]'::jsonb, skips JSONB NOT NULL DEFAULT '[]'::jsonb, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ, archived_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`ALTER TABLE ops_ml_dataset_build_jobs ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE ops_ml_dataset_build_jobs ADD COLUMN IF NOT EXISTS cancelled_count INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE ops_ml_dataset_build_jobs ADD COLUMN IF NOT EXISTS skips JSONB NOT NULL DEFAULT '[]'::jsonb`;
    await sql`ALTER TABLE ops_ml_dataset_build_jobs ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`;
    await sql`CREATE INDEX IF NOT EXISTS idx_ops_ml_dataset_jobs_symbol_started ON ops_ml_dataset_build_jobs (symbol, started_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_ops_ml_dataset_jobs_active_started ON ops_ml_dataset_build_jobs (started_at DESC) WHERE archived_at IS NULL`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_ml_dataset_jobs_running_symbol ON ops_ml_dataset_build_jobs (symbol) WHERE status = 'running'`;
    await sql`CREATE TABLE IF NOT EXISTS ops_ml_dataset_build_job_items (id BIGSERIAL PRIMARY KEY, job_id UUID NOT NULL REFERENCES ops_ml_dataset_build_jobs(id) ON DELETE CASCADE, item_index INTEGER NOT NULL, duration_value INTEGER NOT NULL, duration_unit VARCHAR(1) NOT NULL, duration_range_id VARCHAR(160), status VARCHAR(24) NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error_message TEXT, claimed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, UNIQUE (job_id, item_index))`;
    await sql`ALTER TABLE ops_ml_dataset_build_job_items ALTER COLUMN duration_range_id DROP NOT NULL`;
    await sql`UPDATE ops_ml_dataset_build_job_items SET duration_range_id = NULL WHERE duration_range_id LIKE '%:REQUESTED:%'`;
    await sql`CREATE INDEX IF NOT EXISTS idx_ops_ml_dataset_build_job_items_claim ON ops_ml_dataset_build_job_items (job_id, status, claimed_at, item_index)`;
  })();
  try { await schemaReady; } catch (error) { schemaReady = null; throw error; }
}
function mapJob(row: any): AutoDatasetJob {
  return {
    id: String(row.id),
    symbol: String(row.symbol),
    status: row.status as AutoDatasetJobStatus,
    requestedCount: Number(row.requested_count),
    completedCount: Number(row.completed_count),
    failedCount: Number(row.failed_count),
    skippedCount: Number(row.skipped_count ?? 0),
    cancelledCount: Number(row.cancelled_count ?? 0),
    failures: Array.isArray(row.failures) ? row.failures : [],
    skips: Array.isArray(row.skips) ? row.skips : [],
    startedAt: new Date(row.started_at).toISOString(),
    ...(row.finished_at ? { finishedAt: new Date(row.finished_at).toISOString() } : {}),
    ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}),
  };
}

let historicalFeasibilityMigration: Promise<number> | null = null;

/**
 * Reclassify feasibility outcomes persisted before the builder introduced the
 * explicit skipped state. This is intentionally narrow: genuine infrastructure,
 * database, runtime, and model failures remain failed.
 *
 * This migration is deliberately non-resurrecting: a historical terminal job
 * may be recalculated to completed/failed when all of its items are terminal,
 * but it can never be changed back to running. Only an already-running job may
 * remain running. This preserves the partial unique invariant on symbol.
 */
export async function migrateHistoricalFeasibilityFailures(): Promise<number> {
  if (historicalFeasibilityMigration) return historicalFeasibilityMigration;
  historicalFeasibilityMigration = (async () => {
    await ensureSchema();
    const sql = getDbOrThrow();
    const rows = await sql`
      WITH changed AS (
        UPDATE ops_ml_dataset_build_job_items
        SET status = 'skipped',
            completed_at = COALESCE(completed_at, NOW())
        WHERE status = 'failed'
          AND (
            error_message ILIKE 'No persisted real ticks can satisfy%'
            OR error_message ILIKE 'No non-flat directional samples could be constructed%'
            OR error_message ILIKE 'Temporal split validation failed%'
            OR error_message ILIKE 'Insufficient real Deriv ticks%'
            OR error_message ILIKE 'The duration-aware feature window requires%'
          )
        RETURNING job_id
      ), affected AS (
        SELECT DISTINCT job_id FROM changed
      ), counts AS (
        SELECT
          job.id,
          COUNT(item.id)::integer AS total_count,
          COUNT(item.id) FILTER (WHERE item.status = 'completed')::integer AS completed_count,
          COUNT(item.id) FILTER (WHERE item.status = 'failed')::integer AS failed_count,
          COUNT(item.id) FILTER (WHERE item.status = 'skipped')::integer AS skipped_count,
          COUNT(item.id) FILTER (WHERE item.status = 'cancelled')::integer AS cancelled_count
        FROM ops_ml_dataset_build_jobs AS job
        JOIN affected ON affected.job_id = job.id
        LEFT JOIN ops_ml_dataset_build_job_items AS item ON item.job_id = job.id
        GROUP BY job.id
      )
      UPDATE ops_ml_dataset_build_jobs AS job
      SET completed_count = counts.completed_count,
          failed_count = counts.failed_count,
          skipped_count = counts.skipped_count,
          cancelled_count = counts.cancelled_count,
          failures = COALESCE((
            SELECT jsonb_agg(jsonb_build_object('value', item.duration_value, 'unit', item.duration_unit, 'error', COALESCE(item.error_message, 'Dataset build failed.')) ORDER BY item.item_index)
            FROM ops_ml_dataset_build_job_items AS item
            WHERE item.job_id = job.id AND item.status = 'failed'
          ), '[]'::jsonb),
          skips = COALESCE((
            SELECT jsonb_agg(jsonb_build_object('value', item.duration_value, 'unit', item.duration_unit, 'reason', COALESCE(item.error_message, 'Horizon is not currently feasible for dataset construction.')) ORDER BY item.item_index)
            FROM ops_ml_dataset_build_job_items AS item
            WHERE item.job_id = job.id AND item.status = 'skipped'
          ), '[]'::jsonb),
          status = CASE
            WHEN counts.total_count > 0 AND counts.completed_count + counts.failed_count + counts.skipped_count + counts.cancelled_count >= counts.total_count
              THEN CASE WHEN counts.failed_count > 0 THEN 'failed' ELSE 'completed' END
            ELSE job.status
          END,
          finished_at = CASE
            WHEN counts.total_count > 0 AND counts.completed_count + counts.failed_count + counts.skipped_count + counts.cancelled_count >= counts.total_count
              THEN COALESCE(job.finished_at, NOW())
            ELSE job.finished_at
          END,
          updated_at = NOW()
      FROM counts
      WHERE job.id = counts.id
      RETURNING job.id
    `;
    return rows.length;
  })();
  try {
    return await historicalFeasibilityMigration;
  } catch (error) {
    historicalFeasibilityMigration = null;
    throw error;
  }
}

export async function getAutoDatasetJob(jobId: string): Promise<AutoDatasetJob | null> {
  await ensureSchema();
  const sql = getDbOrThrow();
  const rows = await sql`SELECT * FROM ops_ml_dataset_build_jobs WHERE id = ${jobId} LIMIT 1`;
  return rows.length ? mapJob(rows[0]) : null;
}
export async function getLatestAutoDatasetJob(): Promise<AutoDatasetJob | null> {
  await ensureSchema();
  const sql = getDbOrThrow();
  const rows = await sql`SELECT * FROM ops_ml_dataset_build_jobs WHERE archived_at IS NULL ORDER BY started_at DESC LIMIT 1`;
  return rows.length ? mapJob(rows[0]) : null;
}

async function runningJobMatches(sql: any, jobId: string, durations: Array<{ value: number; unit: DerivDurationUnit; rangeId: string | null }>): Promise<boolean> {
  const rows = await sql`SELECT item_index, duration_value, duration_unit, duration_range_id FROM ops_ml_dataset_build_job_items WHERE job_id = ${jobId} ORDER BY item_index`;
  if (rows.length !== durations.length) return false;
  return rows.every((row: any, index: number) => {
    const existingRangeId = row.duration_range_id == null ? null : String(row.duration_range_id);
    return Number(row.item_index) === index
      && Number(row.duration_value) === durations[index].value
      && String(row.duration_unit) === durations[index].unit
      && existingRangeId === durations[index].rangeId;
  });
}

export async function createAutoDatasetJob(symbol: string, durations: Array<{ value: number; unit: DerivDurationUnit; rangeId: string | null }>): Promise<AutoDatasetJob> {
  await ensureSchema(); const sql = getDbOrThrow();
  const running = await sql`SELECT * FROM ops_ml_dataset_build_jobs WHERE symbol = ${symbol} AND status = 'running' ORDER BY started_at DESC LIMIT 1`;
  if (running.length) {
    const existing = running[0];
    if (await runningJobMatches(sql, String(existing.id), durations)) return mapJob(existing);
    await sql`UPDATE ops_ml_dataset_build_jobs SET status = 'failed', failures = ${JSON.stringify([{ value: 0, unit: 't', error: 'Superseded by a new AUTO horizon scope.' }])}::jsonb, finished_at = NOW(), updated_at = NOW() WHERE id = ${existing.id} AND status = 'running'`;
  }
  const id = randomUUID();
  try { await sql`INSERT INTO ops_ml_dataset_build_jobs (id, symbol, status, requested_count) VALUES (${id}, ${symbol}, 'running', ${durations.length})`; }
  catch (error) {
    const retry = await sql`SELECT * FROM ops_ml_dataset_build_jobs WHERE symbol = ${symbol} AND status = 'running' ORDER BY started_at DESC LIMIT 1`;
    if (retry.length && await runningJobMatches(sql, String(retry[0].id), durations)) return mapJob(retry[0]);
    throw error;
  }
  try {
    if (durations.length) {
      const jobIds = durations.map(() => id), indices = durations.map((_, index) => index), values = durations.map((item) => item.value), units = durations.map((item) => item.unit), rangeIds = durations.map((item) => item.rangeId);
      await sql`INSERT INTO ops_ml_dataset_build_job_items (job_id, item_index, duration_value, duration_unit, duration_range_id) SELECT * FROM UNNEST(${jobIds}::uuid[], ${indices}::integer[], ${values}::integer[], ${units}::text[], ${rangeIds}::text[])`;
    }
  } catch (error) {
    await sql`UPDATE ops_ml_dataset_build_jobs SET status = 'failed', failures = ${JSON.stringify([{ value: 0, unit: 't', error: error instanceof Error ? error.message : String(error) }])}::jsonb, finished_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
    throw error;
  }
  return (await getAutoDatasetJob(id))!;
}
export async function claimNextAutoDatasetJobItem(jobId: string, staleAfterMinutes = 10): Promise<AutoDatasetJobItem | null> {
  await ensureSchema(); const sql = getDbOrThrow();
  const rows = await sql`
    WITH candidate AS (
      SELECT id FROM ops_ml_dataset_build_job_items
      WHERE job_id = ${jobId} AND (status = 'pending' OR (status = 'running' AND claimed_at < NOW() - (${staleAfterMinutes} * INTERVAL '1 minute')))
      ORDER BY item_index FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE ops_ml_dataset_build_job_items AS item
    SET status = 'running', attempts = item.attempts + 1, claimed_at = NOW(), error_message = NULL
    FROM candidate WHERE item.id = candidate.id
    RETURNING item.id, item.item_index, item.duration_value, item.duration_unit, item.duration_range_id, item.attempts
  `;
  if (!rows.length) return null;
  return {
    id: Number(rows[0].id),
    itemIndex: Number(rows[0].item_index),
    value: Number(rows[0].duration_value),
    unit: rows[0].duration_unit as DerivDurationUnit,
    rangeId: rows[0].duration_range_id == null ? null : String(rows[0].duration_range_id),
    attempts: Number(rows[0].attempts),
  };
}

/** Cancel pending/running AUTO work for a dataset identity before deleting it. */
export async function cancelAutoDatasetItemsForDataset(symbol: string, durationValue: number, durationUnit: DerivDurationUnit): Promise<number> {
  await ensureSchema(); const sql = getDbOrThrow();
  const rows = await sql`
    UPDATE ops_ml_dataset_build_job_items AS item
    SET status = 'cancelled', completed_at = COALESCE(item.completed_at, NOW()), error_message = 'Cancelled because the corresponding training dataset was deleted.'
    FROM ops_ml_dataset_build_jobs AS job
    WHERE item.job_id = job.id
      AND job.symbol = ${symbol}
      AND job.status = 'running'
      AND item.duration_value = ${durationValue}
      AND item.duration_unit = ${durationUnit}
      AND item.status IN ('pending', 'running')
    RETURNING item.id, item.job_id
  `;
  const jobIds = Array.from(new Set(rows.map((row: any) => String(row.job_id))));
  for (const jobId of jobIds) await refreshAutoDatasetJobStatus(jobId);
  return rows.length;
}

export async function getAutoDatasetJobItemStatus(jobId: string, itemId: number): Promise<AutoDatasetJobItemStatus | null> {
  await ensureSchema(); const sql = getDbOrThrow();
  const rows = await sql`SELECT status FROM ops_ml_dataset_build_job_items WHERE id = ${itemId} AND job_id = ${jobId} LIMIT 1`;
  return rows.length ? rows[0].status as AutoDatasetJobItemStatus : null;
}

/** Remove a just-built dataset when its AUTO job item was cancelled during construction. */
export async function discardAutoDatasetBuild(datasetId: string): Promise<void> {
  await ensureSchema(); const sql = getDbOrThrow();
  await sql`DELETE FROM training_datasets WHERE id = ${datasetId}::uuid`;
}

export async function completeAutoDatasetJobItem(jobId: string, itemId: number): Promise<void> {
  await ensureSchema(); const sql = getDbOrThrow();
  await sql`UPDATE ops_ml_dataset_build_job_items SET status = 'completed', completed_at = NOW(), error_message = NULL WHERE id = ${itemId} AND job_id = ${jobId} AND status = 'running'`;
  await refreshAutoDatasetJobStatus(jobId);
}
export async function failAutoDatasetJobItem(jobId: string, itemId: number, error: string): Promise<void> {
  await ensureSchema(); const sql = getDbOrThrow();
  await sql`UPDATE ops_ml_dataset_build_job_items SET status = 'failed', completed_at = NOW(), error_message = ${error.slice(0, 2000)} WHERE id = ${itemId} AND job_id = ${jobId} AND status = 'running'`;
  await refreshAutoDatasetJobStatus(jobId);
}
export async function skipAutoDatasetJobItem(jobId: string, itemId: number, reason: string): Promise<void> {
  await ensureSchema(); const sql = getDbOrThrow();
  await sql`UPDATE ops_ml_dataset_build_job_items SET status = 'skipped', completed_at = NOW(), error_message = ${reason.slice(0, 2000)} WHERE id = ${itemId} AND job_id = ${jobId} AND status = 'running'`;
  await refreshAutoDatasetJobStatus(jobId);
}

export async function cancelAllRunningAutoDatasetJobs(): Promise<number> {
  await ensureSchema(); const sql = getDbOrThrow();
  await sql`
    UPDATE ops_ml_dataset_build_job_items
    SET status = 'cancelled', completed_at = COALESCE(completed_at, NOW()), error_message = 'Cancelled by user command to stop automated processes.'
    WHERE status IN ('pending', 'running')
  `;
  const rows = await sql`
    UPDATE ops_ml_dataset_build_jobs
    SET status = 'failed',
        failures = failures || '[{"value":0,"unit":"t","error":"Automated process stopped by user authorization."}]'::jsonb,
        finished_at = COALESCE(finished_at, NOW()),
        updated_at = NOW()
    WHERE status = 'running'
    RETURNING id
  `;
  return rows.length;
}

export async function archiveAutoDatasetJob(jobId: string): Promise<{ archived: boolean; active: boolean }> {
  await ensureSchema(); const sql = getDbOrThrow();
  const rows = await sql`SELECT status, archived_at FROM ops_ml_dataset_build_jobs WHERE id = ${jobId} LIMIT 1`;
  if (!rows.length) return { archived: false, active: false };
  if (rows[0].status === 'running') return { archived: false, active: true };
  if (rows[0].archived_at) return { archived: true, active: false };
  await sql`UPDATE ops_ml_dataset_build_jobs SET archived_at = NOW(), updated_at = NOW() WHERE id = ${jobId} AND status <> 'running' AND archived_at IS NULL`;
  return { archived: true, active: false };
}

export async function refreshAutoDatasetJobStatus(jobId: string): Promise<AutoDatasetJob | null> {
  await ensureSchema(); const sql = getDbOrThrow();
  const rows = await sql`
    WITH counts AS (
      SELECT COUNT(*) FILTER (WHERE status = 'completed')::integer AS completed_count,
             COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed_count,
             COUNT(*) FILTER (WHERE status = 'skipped')::integer AS skipped_count,
             COUNT(*) FILTER (WHERE status = 'cancelled')::integer AS cancelled_count,
             COUNT(*)::integer AS total_count
      FROM ops_ml_dataset_build_job_items WHERE job_id = ${jobId}
    ), updated AS (
      UPDATE ops_ml_dataset_build_jobs AS job
      SET completed_count = counts.completed_count,
          failed_count = counts.failed_count,
          skipped_count = counts.skipped_count,
          cancelled_count = counts.cancelled_count,
          failures = COALESCE((SELECT jsonb_agg(jsonb_build_object('value', item.duration_value, 'unit', item.duration_unit, 'error', COALESCE(item.error_message, 'Dataset build failed.')) ORDER BY item.item_index) FROM ops_ml_dataset_build_job_items AS item WHERE item.job_id = job.id AND item.status = 'failed'), '[]'::jsonb),
          skips = COALESCE((SELECT jsonb_agg(jsonb_build_object('value', item.duration_value, 'unit', item.duration_unit, 'reason', COALESCE(item.error_message, 'Horizon is not currently feasible for dataset construction.')) ORDER BY item.item_index) FROM ops_ml_dataset_build_job_items AS item WHERE item.job_id = job.id AND item.status = 'skipped'), '[]'::jsonb),
          status = CASE
            WHEN counts.total_count > 0 AND counts.completed_count + counts.failed_count + counts.skipped_count + counts.cancelled_count >= counts.total_count
              THEN CASE WHEN counts.failed_count > 0 THEN 'failed' ELSE 'completed' END
            ELSE 'running'
          END,
          finished_at = CASE WHEN counts.total_count > 0 AND counts.completed_count + counts.failed_count + counts.skipped_count + counts.cancelled_count >= counts.total_count THEN COALESCE(job.finished_at, NOW()) ELSE NULL END,
          updated_at = NOW()
      FROM counts WHERE job.id = ${jobId} RETURNING job.*
    ) SELECT * FROM updated
  `;
  return rows.length ? mapJob(rows[0]) : null;
}
