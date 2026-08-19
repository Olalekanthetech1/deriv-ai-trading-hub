import { randomUUID } from 'node:crypto';
import { getDbOrThrow } from '@/lib/db';
import type { DerivDurationUnit } from '@/lib/deriv-duration-registry';
import { getAutoDatasetJob, getLatestAutoDatasetJob } from '@/lib/auto-dataset-job-store';
import type { AutoDatasetJob } from '@/lib/auto-dataset-job-store';

type ScopeDuration = { value: number; unit: DerivDurationUnit; rangeId: string | null };

/**
 * Persist an AUTO dataset job and every requested horizon item in one database
 * statement. The parent job can never become visible without its complete
 * scope. Existing running work for the same asset/scope is reused; a different
 * running scope is reported as an explicit conflict instead of being silently
 * superseded.
 *
 * Scope identity is intentionally symbol + duration value + duration unit.
 * Deriv discovery range IDs are metadata only and never define build identity.
 */
export async function createAutoDatasetJobAtomic(symbol: string, durations: ScopeDuration[]): Promise<AutoDatasetJob> {
  if (!durations.length) throw new Error('AUTO_DATASET_SCOPE_EMPTY: at least one horizon is required.');

  await getLatestAutoDatasetJob();

  const existing = await getAutoDatasetJobBySymbol(symbol);
  if (existing) {
    if (await runningScopeMatches(existing.id, durations)) return existing;
    throw new Error(`AUTO_DATASET_SCOPE_CONFLICT:${existing.id}:another dataset build is already running for ${symbol}.`);
  }

  const sql = getDbOrThrow();
  const jobId = randomUUID();
  const requestedCount = durations.length;
  const indices = durations.map((_, index) => index);
  const values = durations.map((item) => item.value);
  const units = durations.map((item) => item.unit);
  const rangeIds = durations.map((item) => item.rangeId);

  const rows = await sql`
    WITH inserted_job AS (
      INSERT INTO ops_ml_dataset_build_jobs (id, symbol, status, requested_count)
      VALUES (${jobId}, ${symbol}, 'running', ${requestedCount})
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    INSERT INTO ops_ml_dataset_build_job_items
      (job_id, item_index, duration_value, duration_unit, duration_range_id)
    SELECT
      inserted_job.id,
      scope.item_index,
      scope.duration_value,
      scope.duration_unit,
      scope.duration_range_id
    FROM inserted_job
    CROSS JOIN UNNEST(
      ${indices}::integer[],
      ${values}::integer[],
      ${units}::text[],
      ${rangeIds}::text[]
    ) AS scope(item_index, duration_value, duration_unit, duration_range_id)
    RETURNING job_id
  `;

  if (rows.length === requestedCount) {
    const created = await getAutoDatasetJob(String(rows[0].job_id));
    if (created) return created;
  }

  const winner = await getAutoDatasetJobBySymbol(symbol);
  if (winner && await runningScopeMatches(winner.id, durations)) return winner;
  if (winner) {
    throw new Error(`AUTO_DATASET_SCOPE_CONFLICT:${winner.id}:another dataset build won the concurrent scope reservation for ${symbol}.`);
  }
  throw new Error(`AUTO_DATASET_JOB_PERSIST_FAILED:${symbol}:the job scope could not be atomically persisted.`);
}

async function getAutoDatasetJobBySymbol(symbol: string): Promise<AutoDatasetJob | null> {
  const sql = getDbOrThrow();
  const rows = await sql`
    SELECT *
    FROM ops_ml_dataset_build_jobs
    WHERE symbol = ${symbol} AND status = 'running'
    ORDER BY started_at DESC
    LIMIT 1
  `;
  if (!rows.length) return null;
  return {
    id: String(rows[0].id),
    symbol: String(rows[0].symbol),
    status: rows[0].status,
    requestedCount: Number(rows[0].requested_count),
    completedCount: Number(rows[0].completed_count ?? 0),
    failedCount: Number(rows[0].failed_count ?? 0),
    skippedCount: Number(rows[0].skipped_count ?? 0),
    cancelledCount: Number(rows[0].cancelled_count ?? 0),
    failures: Array.isArray(rows[0].failures) ? rows[0].failures : [],
    skips: Array.isArray(rows[0].skips) ? rows[0].skips : [],
    startedAt: new Date(rows[0].started_at).toISOString(),
    ...(rows[0].finished_at ? { finishedAt: new Date(rows[0].finished_at).toISOString() } : {}),
    ...(rows[0].archived_at ? { archivedAt: new Date(rows[0].archived_at).toISOString() } : {}),
  } as AutoDatasetJob;
}

async function runningScopeMatches(jobId: string, durations: ScopeDuration[]): Promise<boolean> {
  const sql = getDbOrThrow();
  const rows = await sql`
    SELECT item_index, duration_value, duration_unit
    FROM ops_ml_dataset_build_job_items
    WHERE job_id = ${jobId}
    ORDER BY item_index
  `;
  if (rows.length !== durations.length) return false;
  return rows.every((row: any, index: number) =>
    Number(row.item_index) === index
      && Number(row.duration_value) === durations[index].value
      && String(row.duration_unit) === durations[index].unit,
  );
}
