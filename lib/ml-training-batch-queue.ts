import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from './db';
import { ensureTrainingDurationSchema } from './training-duration-schema';
import { ensureTrainingBatchSchema } from './training-batch-schema';
import { getMlModelKeys, type MlModelKey } from './ml-model-registry';
import { enqueueTrainingJob, recoverAbandonedTrainingJobs } from './ml-training-queue';
import { resolveTrainingDedup } from './ml-training-dedup';
import { getTrainingBatch } from './ml-training-batch-orchestrator';

type TrainingBatchPlan = { datasetIds: string[]; modelTypes?: MlModelKey[]; skipCompleted?: boolean; retryFailed?: boolean };

function normalizeIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())).map((value) => value.trim()))];
}

function normalizeModels(values: unknown): MlModelKey[] {
  const valid = new Set(getMlModelKeys());
  if (!Array.isArray(values)) return [...getMlModelKeys()];
  return [...new Set(values.filter((value): value is MlModelKey => typeof value === 'string' && valid.has(value as MlModelKey)))];
}

function staleBatchAfterMs(): number {
  const raw = Number(process.env.ML_TRAINING_BATCH_STALE_AFTER_MS || 5 * 60 * 1000);
  if (!Number.isFinite(raw)) return 5 * 60 * 1000;
  return Math.min(60 * 60 * 1000, Math.max(60_000, Math.trunc(raw)));
}

async function db() {
  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  const sql = neon(url);
  await ensureTrainingDurationSchema(sql);
  await ensureTrainingBatchSchema(sql);
  return sql;
}

async function enqueueBatchItems(sql: any, batchId: string) {
  const items = await sql`SELECT id,dataset_id,requested_models,status FROM ml_training_batch_items WHERE batch_id=${batchId}::uuid AND status='queued' ORDER BY id ASC`;
  for (const item of items) {
    await enqueueTrainingJob({
      datasetId: String(item.dataset_id),
      modelTypes: normalizeModels(item.requested_models),
      batchId,
      batchItemId: Number(item.id),
    });
  }
}

/**
 * A batch may remain queued after a failed web request/deploy before its queue
 * items are successfully created. Those orphaned records must not block every
 * subsequent training plan forever. We only reconcile when there are no active
 * queue jobs and the batch has been inactive for the configured grace period.
 */
async function reconcileStaleBatches(sql: any): Promise<number> {
  const staleMs = staleBatchAfterMs();
  const rows = await sql`
    SELECT b.batch_id,b.status,b.updated_at,b.heartbeat_at
    FROM ml_training_batches b
    WHERE b.status IN ('queued','running','partial')
      AND NOT EXISTS (
        SELECT 1
        FROM ml_training_job_queue q
        WHERE q.batch_id=b.batch_id::uuid
          AND q.status IN ('queued','running')
      )
      AND COALESCE(b.heartbeat_at,b.updated_at,b.created_at) < NOW() - (${staleMs}::bigint * INTERVAL '1 millisecond')
    ORDER BY b.updated_at ASC
  `;
  for (const row of rows) {
    await sql`
      UPDATE ml_training_batches
      SET status='failed',
          error='Training batch became stale before an active queue worker remained observable; the batch was reconciled automatically and can be retried safely.',
          completed_at=COALESCE(completed_at,NOW()),
          heartbeat_at=NULL,
          worker_id=NULL,
          updated_at=NOW()
      WHERE batch_id=${String(row.batch_id)}::uuid
        AND status IN ('queued','running','partial')
    `;
  }
  return rows.length;
}

export async function createTrainingBatchQueued(plan: TrainingBatchPlan) {
  const sql = await db();
  await recoverAbandonedTrainingJobs();
  await reconcileStaleBatches(sql);

  const datasetIds = normalizeIds(plan.datasetIds);
  const modelTypes = normalizeModels(plan.modelTypes);
  if (!datasetIds.length) throw new Error('NO_DATASETS_SELECTED');
  if (!modelTypes.length) throw new Error('NO_MODELS_SELECTED');
  if (datasetIds.length > 100) throw new Error('TRAINING_BATCH_DATASET_LIMIT_EXCEEDED');

  const active = await sql`SELECT batch_id,status,updated_at,error FROM ml_training_batches WHERE status IN ('running','queued') ORDER BY created_at DESC LIMIT 1`;
  if (active.length) {
    const activeId = String(active[0].batch_id);
    const activeStatus = String(active[0].status);
    throw new Error(`TRAINING_BATCH_ALREADY_RUNNING:${activeId}:${activeStatus}`);
  }
  const runningRun = await sql`SELECT run_id FROM ml_training_runs WHERE status='running' ORDER BY created_at DESC LIMIT 1`;
  if (runningRun.length) throw new Error('TRAINING_ALREADY_RUNNING');

  const rows = await sql`SELECT id,asset_symbol,duration_value,duration_unit,horizon_ticks,status,leakage_check_passed,sample_count FROM training_datasets WHERE id = ANY(${datasetIds}::uuid[])`;
  const datasetMap = new Map(rows.map((row: any) => [String(row.id), row]));
  if (datasetMap.size !== datasetIds.length) throw new Error('ONE_OR_MORE_DATASETS_NOT_FOUND');

  const batchId = crypto.randomUUID();
  let totalJobs = 0;
  let skippedJobs = 0;
  let blockedFailedJobs = 0;
  const plans: Array<{ datasetId: string; requestedModels: MlModelKey[]; skippedModels: MlModelKey[]; blockedFailedModels: MlModelKey[] }> = [];

  for (const datasetId of datasetIds) {
    const dataset = datasetMap.get(datasetId);
    if (dataset.status !== 'completed' || dataset.leakage_check_passed !== true) throw new Error(`DATASET_NOT_READY_FOR_TRAINING:${datasetId}`);

    const dedup = await resolveTrainingDedup(datasetId, modelTypes, plan.retryFailed === true);
    const skippedModels = plan.skipCompleted === false ? [] : dedup.skippedCompletedModelTypes;
    const blockedFailedModels = dedup.blockedFailedModelTypes;
    const requestedModels = dedup.allowedModelTypes.filter((model) => !skippedModels.includes(model));

    plans.push({ datasetId, requestedModels, skippedModels: [...skippedModels, ...blockedFailedModels], blockedFailedModels });
    totalJobs += requestedModels.length;
    skippedJobs += skippedModels.length;
    blockedFailedJobs += blockedFailedModels.length;
  }

  const createdBatch = await sql`
    INSERT INTO ml_training_batches (batch_id,status,requested_datasets,requested_models,total_jobs,completed_jobs,failed_jobs,skipped_jobs,worker_id,metadata)
    VALUES (${batchId}::uuid,${totalJobs ? 'queued' : 'completed'},${datasetIds.length},${modelTypes.length},${totalJobs},0,0,${skippedJobs + blockedFailedJobs},NULL,${JSON.stringify({ datasetIds, modelTypes, skipCompleted:plan.skipCompleted !== false, retryFailed:plan.retryFailed === true, blockedFailedJobs, executionBoundary:'dedicated-ml-worker' })}::jsonb)
    ON CONFLICT DO NOTHING
    RETURNING batch_id
  `;
  if (!createdBatch.length) {
    const existing = await sql`SELECT batch_id,status FROM ml_training_batches WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`;
    if (existing.length) throw new Error(`TRAINING_BATCH_ALREADY_RUNNING:${String(existing[0].batch_id)}:${String(existing[0].status)}`);
    throw new Error('TRAINING_BATCH_CREATE_CONFLICT');
  }

  for (const item of plans) {
    await sql`INSERT INTO ml_training_batch_items (batch_id,dataset_id,status,requested_models,skipped_models,completed_models,failed_models,metadata)
      VALUES (${batchId}::uuid,${item.datasetId}::text,${item.requestedModels.length ? 'queued' : 'skipped'},${JSON.stringify(item.requestedModels)}::jsonb,${JSON.stringify(item.skippedModels)}::jsonb,0,0,${JSON.stringify({ retryFailed:plan.retryFailed === true, blockedFailedModels:item.blockedFailedModels })}::jsonb)`;
  }

  if (totalJobs) await enqueueBatchItems(sql, batchId);
  return { batchId, status: totalJobs ? 'queued' : 'completed', requestedDatasets: datasetIds.length, requestedModels: modelTypes.length, totalJobs, skippedJobs: skippedJobs + blockedFailedJobs, remainingJobs: totalJobs, blockedFailedJobs };
}

export async function resumeTrainingBatchQueued(batchId: string) {
  const sql = await db();
  const batch = await getTrainingBatch(batchId);
  if (!['queued','running','partial'].includes(batch.status)) return batch;

  const queued = await sql`SELECT id,dataset_id,requested_models,status FROM ml_training_batch_items WHERE batch_id=${batchId}::uuid AND status IN ('queued','failed','partial') ORDER BY id ASC`;
  for (const item of queued) {
    const existing = await sql`SELECT job_id FROM ml_training_job_queue WHERE batch_id=${batchId}::uuid AND batch_item_id=${Number(item.id)} AND status IN ('queued','running') LIMIT 1`;
    if (existing.length) continue;
    await sql`UPDATE ml_training_batch_items SET status='queued',error=NULL,heartbeat_at=NULL,updated_at=NOW() WHERE id=${Number(item.id)}`;
    const dedup = await resolveTrainingDedup(String(item.dataset_id), normalizeModels(item.requested_models), false);
    if (!dedup.allowedModelTypes.length) {
      await sql`UPDATE ml_training_batch_items SET status='skipped',skipped_models=${JSON.stringify([...dedup.skippedCompletedModelTypes, ...dedup.blockedFailedModelTypes])}::jsonb,error=NULL,completed_at=NOW(),updated_at=NOW() WHERE id=${Number(item.id)}`;
      continue;
    }
    await sql`UPDATE ml_training_batch_items SET requested_models=${JSON.stringify(dedup.allowedModelTypes)}::jsonb,skipped_models=${JSON.stringify([...dedup.skippedCompletedModelTypes, ...dedup.blockedFailedModelTypes])}::jsonb WHERE id=${Number(item.id)}`;
    await enqueueTrainingJob({ datasetId:String(item.dataset_id), modelTypes:dedup.allowedModelTypes, batchId, batchItemId:Number(item.id) });
  }
  await sql`UPDATE ml_training_batches SET status='queued',error=NULL,heartbeat_at=NULL,updated_at=NOW() WHERE batch_id=${batchId}::uuid AND status IN ('partial','running','queued')`;
  return { ...(await getTrainingBatch(batchId)), resumed:true };
}