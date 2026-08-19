import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from './db';
import { listTrainingQueueJobs } from './ml-training-queue';

/** Remove terminal failed worker-queue records while preserving queued/running work. */
export async function clearTerminalTrainingQueueHistory(): Promise<number> {
  const url = getDbConnectionString();
  if (!url) throw new Error('DATABASE_UNAVAILABLE');

  await listTrainingQueueJobs();
  const sql = neon(url);
  const active = await sql`
    SELECT job_id,dataset_id,training_run_id,worker_id,heartbeat_at,status
    FROM ml_training_job_queue
    WHERE status IN ('running','queued')
    ORDER BY created_at DESC
  `;
  if (active.length) {
    const error = new Error('TRAINING_HISTORY_RESET_BLOCKED_BY_RUNNING_JOBS');
    (error as Error & { runningQueueJobs?: unknown[] }).runningQueueJobs = active;
    throw error;
  }

  const deleted = await sql`
    DELETE FROM ml_training_job_queue
    WHERE status='failed'
    RETURNING job_id
  `;
  return deleted.length;
}

/**
 * Clear only failed/timed-out/cancelled persisted training runs.
 * Completed and partial runs are retained as ML lineage and audit history.
 * Active running/queued work is never targeted by this operation.
 */
export async function clearFailedTrainingRunHistory(): Promise<{ deletedRuns: number; deletedRunModels: number }> {
  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  const sql = neon(url);

  const active = await sql`
    SELECT run_id,asset_symbol,duration_value,duration_unit,created_at,heartbeat_at,status
    FROM ml_training_runs
    WHERE status IN ('running','queued')
    ORDER BY created_at DESC
  `;
  if (active.length) {
    const error = new Error('TRAINING_HISTORY_RESET_BLOCKED_BY_RUNNING_JOBS');
    (error as Error & { runningRuns?: unknown[] }).runningRuns = active;
    throw error;
  }

  const runRows = await sql`
    SELECT run_id
    FROM ml_training_runs
    WHERE status IN ('failed','timed_out','cancelled')
  `;
  if (!runRows.length) return { deletedRuns: 0, deletedRunModels: 0 };

  const runIds = runRows.map((row: any) => String(row.run_id));
  const modelRows = await sql`
    SELECT COUNT(*)::int AS count
    FROM ml_training_run_models
    WHERE run_id = ANY(${runIds}::uuid[])
  `;
  const modelCount = Number(modelRows[0]?.count || 0);

  await sql`
    DELETE FROM ml_training_run_models
    WHERE run_id = ANY(${runIds}::uuid[])
  `;
  await sql`
    DELETE FROM ml_training_runs
    WHERE run_id = ANY(${runIds}::uuid[])
      AND status IN ('failed','timed_out','cancelled')
  `;

  return { deletedRuns: runIds.length, deletedRunModels: modelCount };
}
