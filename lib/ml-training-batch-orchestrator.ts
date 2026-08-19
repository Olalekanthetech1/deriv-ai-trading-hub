import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from './db';
import { ensureTrainingDurationSchema } from './training-duration-schema';
import { ensureTrainingBatchSchema } from './training-batch-schema';
import { getMlModelKeys, type MlModelKey } from './ml-model-registry';
import { trainDatasetModels } from './ml-training-orchestrator';

type TrainingBatchStatus = 'queued' | 'running' | 'partial' | 'completed' | 'failed';
type TrainingBatchItemStatus = 'queued' | 'running' | 'skipped' | 'partial' | 'completed' | 'failed';
type TrainingBatchItem = {
  id: number;
  batch_id: string;
  dataset_id: string;
  status: TrainingBatchItemStatus;
  requested_models: MlModelKey[];
  skipped_models: MlModelKey[];
  run_id?: string | null;
  completed_models: number;
  failed_models: number;
  error?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  heartbeat_at?: string | null;
  asset_symbol?: string;
  duration_value?: number;
  duration_unit?: string;
  horizon_ticks?: number;
};
type TrainingBatchRecord = {
  batch_id: string;
  status: TrainingBatchStatus;
  requested_datasets: number;
  requested_models: number;
  total_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  skipped_jobs: number;
  started_at?: string | null;
  completed_at?: string | null;
  heartbeat_at?: string | null;
  worker_id?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

type TrainingBatchPlan = {
  datasetIds: string[];
  modelTypes?: MlModelKey[];
  skipCompleted?: boolean;
  retryFailed?: boolean;
};

function workerId() {
  return `${process.env.RENDER_INSTANCE_ID?.trim() || 'node'}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value.trim())).map((value) => value.trim()))];
}

function normalizeModels(values: unknown): MlModelKey[] {
  const valid = new Set(getMlModelKeys());
  if (!Array.isArray(values)) return [...getMlModelKeys()];
  return [...new Set(values.filter((value): value is MlModelKey => typeof value === 'string' && valid.has(value as MlModelKey)))];
}

function toBatchRecord(row: Record<string, unknown>): TrainingBatchRecord {
  return {
    batch_id: String(row.batch_id),
    status: String(row.status || 'queued') as TrainingBatchStatus,
    requested_datasets: Number(row.requested_datasets || 0),
    requested_models: Number(row.requested_models || 0),
    total_jobs: Number(row.total_jobs || 0),
    completed_jobs: Number(row.completed_jobs || 0),
    failed_jobs: Number(row.failed_jobs || 0),
    skipped_jobs: Number(row.skipped_jobs || 0),
    started_at: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
    completed_at: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
    heartbeat_at: row.heartbeat_at ? new Date(String(row.heartbeat_at)).toISOString() : null,
    worker_id: row.worker_id ? String(row.worker_id) : null,
    error: row.error ? String(row.error) : null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {},
    created_at: row.created_at ? new Date(String(row.created_at)).toISOString() : undefined,
    updated_at: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined,
  };
}

async function existingCompletedModels(sql: any, datasetId: string, candidates: MlModelKey[]): Promise<MlModelKey[]> {
  const rows = await sql`
    SELECT metrics->>'engine' AS engine
    FROM ml_model_registry_v2
    WHERE dataset_id=${datasetId}
      AND status IN ('candidate','staging','production')
  `;
  const existing = new Set(rows.map((row: any) => String(row.engine || '').trim().toLowerCase()));
  return candidates.filter((model) => existing.has(model));
}

async function updateBatch(sql: any, batchId: string, values: Partial<TrainingBatchRecord>) {
  if (values.status !== undefined) await sql`UPDATE ml_training_batches SET status=${values.status},updated_at=NOW() WHERE batch_id=${batchId}::uuid`;
  if (values.total_jobs !== undefined) await sql`UPDATE ml_training_batches SET total_jobs=${values.total_jobs},updated_at=NOW() WHERE batch_id=${batchId}::uuid`;
  if (values.completed_jobs !== undefined) await sql`UPDATE ml_training_batches SET completed_jobs=${values.completed_jobs},updated_at=NOW() WHERE batch_id=${batchId}::uuid`;
  if (values.failed_jobs !== undefined) await sql`UPDATE ml_training_batches SET failed_jobs=${values.failed_jobs},updated_at=NOW() WHERE batch_id=${batchId}::uuid`;
  if (values.skipped_jobs !== undefined) await sql`UPDATE ml_training_batches SET skipped_jobs=${values.skipped_jobs},updated_at=NOW() WHERE batch_id=${batchId}::uuid`;
  if (values.started_at !== undefined) await sql`UPDATE ml_training_batches SET started_at=${values.started_at},updated_at=NOW() WHERE batch_id=${batchId}::uuid`;
  if (values.completed_at !== undefined) await sql`UPDATE ml_training_batches SET completed_at=${values.completed_at},updated_at=NOW() WHERE batch_id=${batchId}::uuid`;
  if (values.heartbeat_at !== undefined) await sql`UPDATE ml_training_batches SET heartbeat_at=${values.heartbeat_at},updated_at=NOW() WHERE batch_id=${batchId}::uuid`;
  if (values.worker_id !== undefined) await sql`UPDATE ml_training_batches SET worker_id=${values.worker_id},updated_at=NOW() WHERE batch_id=${batchId}::uuid`;
  if (values.error !== undefined) await sql`UPDATE ml_training_batches SET error=${values.error},updated_at=NOW() WHERE batch_id=${batchId}::uuid`;
}

export async function createTrainingBatch(plan: TrainingBatchPlan) {
  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  const sql = neon(url);
  await ensureTrainingDurationSchema(sql);
  await ensureTrainingBatchSchema(sql);
  const datasetIds = normalizeIds(plan.datasetIds);
  const modelTypes = normalizeModels(plan.modelTypes);
  if (!datasetIds.length) throw new Error('NO_DATASETS_SELECTED');
  if (!modelTypes.length) throw new Error('NO_MODELS_SELECTED');
  if (datasetIds.length > 100) throw new Error('TRAINING_BATCH_DATASET_LIMIT_EXCEEDED');
  const runningBatch = await sql`SELECT batch_id FROM ml_training_batches WHERE status IN ('running','queued') ORDER BY created_at DESC LIMIT 1`;
  if (runningBatch.length) throw new Error('TRAINING_BATCH_ALREADY_RUNNING');
  const runningRun = await sql`SELECT run_id FROM ml_training_runs WHERE status='running' ORDER BY created_at DESC LIMIT 1`;
  if (runningRun.length) throw new Error('TRAINING_ALREADY_RUNNING');
  const datasets = await sql`SELECT id,asset_symbol,duration_value,duration_unit,duration_seconds,horizon_ticks,status,leakage_check_passed,sample_count FROM training_datasets WHERE id = ANY(${datasetIds}::text[])`;
  const datasetMap = new Map(datasets.map((row: any) => [String(row.id), row]));
  if (datasetMap.size !== datasetIds.length) throw new Error('ONE_OR_MORE_DATASETS_NOT_FOUND');
  const batchId = crypto.randomUUID();
  const activeWorkerId = workerId();
  let totalJobs = 0;
  let skippedJobs = 0;
  const itemPlans: Array<{ datasetId: string; requestedModels: MlModelKey[]; skippedModels: MlModelKey[] }> = [];
  for (const datasetId of datasetIds) {
    const dataset = datasetMap.get(datasetId);
    if (dataset.status !== 'completed' || dataset.leakage_check_passed !== true) throw new Error(`DATASET_NOT_READY_FOR_TRAINING:${datasetId}`);
    const completedModels = plan.skipCompleted === false ? [] : await existingCompletedModels(sql, datasetId, modelTypes);
    const requestedModels = modelTypes.filter((model) => !completedModels.includes(model));
    itemPlans.push({ datasetId, requestedModels, skippedModels: completedModels });
    totalJobs += requestedModels.length;
    skippedJobs += completedModels.length;
  }
  await sql`INSERT INTO ml_training_batches (batch_id,status,requested_datasets,requested_models,total_jobs,completed_jobs,failed_jobs,skipped_jobs,worker_id,metadata) VALUES (${batchId}::uuid,'queued',${datasetIds.length},${modelTypes.length},${totalJobs},0,0,${skippedJobs},${activeWorkerId},${JSON.stringify({datasetIds,modelTypes,skipCompleted:plan.skipCompleted !== false,retryFailed:plan.retryFailed === true})}::jsonb)`;
  for (const item of itemPlans) {
    await sql`INSERT INTO ml_training_batch_items (batch_id,dataset_id,status,requested_models,skipped_models,completed_models,failed_models,metadata) VALUES (${batchId}::uuid,${item.datasetId},${item.requestedModels.length ? 'queued' : 'skipped'},${JSON.stringify(item.requestedModels)}::jsonb,${JSON.stringify(item.skippedModels)}::jsonb,0,0,${JSON.stringify({retryFailed:plan.retryFailed === true})}::jsonb)`;
  }
  void processTrainingBatch(batchId);
  return { batchId, status: totalJobs ? 'queued' : 'completed', requestedDatasets: datasetIds.length, requestedModels: modelTypes.length, totalJobs, skippedJobs, remainingJobs: totalJobs };
}

export async function processTrainingBatch(batchId: string) {
  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) return;
  const sql = neon(url);
  await ensureTrainingDurationSchema(sql);
  await ensureTrainingBatchSchema(sql);
  const batchRows = await sql`SELECT * FROM ml_training_batches WHERE batch_id=${batchId}::uuid LIMIT 1`;
  if (!batchRows.length) return;
  const activeWorkerId = String(batchRows[0].worker_id || workerId());
  await updateBatch(sql, batchId, { status: 'running', started_at: batchRows[0].started_at ? new Date(String(batchRows[0].started_at)).toISOString() : new Date().toISOString(), heartbeat_at: new Date().toISOString(), worker_id: activeWorkerId });
  const heartbeat = setInterval(() => { void updateBatch(sql, batchId, { heartbeat_at: new Date().toISOString() }).catch(() => undefined); }, 15000);
  try {
    const items = await sql`SELECT * FROM ml_training_batch_items WHERE batch_id=${batchId}::uuid AND status='queued' ORDER BY id ASC`;
    for (const item of items) {
      await sql`UPDATE ml_training_batch_items SET status='running',started_at=NOW(),heartbeat_at=NOW(),updated_at=NOW() WHERE id=${item.id} AND status='queued'`;
      try {
        const requestedModels = normalizeModels(item.requested_models);
        const result = await trainDatasetModels({ datasetId: String(item.dataset_id), modelTypes: requestedModels });
        const failedModels = Number(result.failedModels || 0);
        const completedModels = Number(result.completedModels || 0);
        const itemStatus: TrainingBatchItemStatus = result.status === 'completed' ? 'completed' : failedModels > 0 && completedModels > 0 ? 'partial' : 'failed';
        const errorText = failedModels ? JSON.stringify((result.results || []).filter((r: any) => !r.success)) : null;
        await sql`UPDATE ml_training_batch_items SET status=${itemStatus},run_id=${result.runId}::uuid,completed_models=${completedModels},failed_models=${failedModels},completed_at=NOW(),heartbeat_at=NULL,error=${errorText},updated_at=NOW() WHERE id=${item.id}`;
      } catch (error) {
        await sql`UPDATE ml_training_batch_items SET status='failed',error=${error instanceof Error ? error.message : 'Batch item failed.'},completed_at=NOW(),heartbeat_at=NULL,updated_at=NOW() WHERE id=${item.id}`;
      }
      const counts = await sql`SELECT COALESCE(SUM(completed_models),0)::int AS completed_models,COALESCE(SUM(failed_models),0)::int AS failed_models FROM ml_training_batch_items WHERE batch_id=${batchId}::uuid`;
      await updateBatch(sql, batchId, { completed_jobs: Number(counts[0]?.completed_models || 0), failed_jobs: Number(counts[0]?.failed_models || 0), heartbeat_at: new Date().toISOString() });
    }
    const final = await sql`SELECT COUNT(*)::int AS total_items,COUNT(*) FILTER (WHERE status='skipped')::int AS skipped_items,COUNT(*) FILTER (WHERE status='completed')::int AS completed_items,COUNT(*) FILTER (WHERE status IN ('failed','partial'))::int AS failed_items,COALESCE(SUM(completed_models),0)::int AS completed_jobs,COALESCE(SUM(failed_models),0)::int AS failed_jobs FROM ml_training_batch_items WHERE batch_id=${batchId}::uuid`;
    const row = final[0];
    const terminalStatus: TrainingBatchStatus = Number(row.failed_items || 0) === 0 ? 'completed' : Number(row.completed_items || 0) > 0 || Number(row.skipped_items || 0) > 0 ? 'partial' : 'failed';
    await updateBatch(sql, batchId, { status: terminalStatus, completed_jobs: Number(row.completed_jobs || 0), failed_jobs: Number(row.failed_jobs || 0), skipped_jobs: Number(row.skipped_jobs || 0), completed_at: new Date().toISOString(), heartbeat_at: null });
  } catch (error) {
    await updateBatch(sql, batchId, { status: 'failed', error: error instanceof Error ? error.message : 'Training batch failed.', completed_at: new Date().toISOString(), heartbeat_at: null });
  } finally {
    clearInterval(heartbeat);
  }
}

export async function getTrainingBatch(batchId: string) {
  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  const sql = neon(url);
  await ensureTrainingDurationSchema(sql);
  await ensureTrainingBatchSchema(sql);
  const rows = await sql`SELECT * FROM ml_training_batches WHERE batch_id=${batchId}::uuid LIMIT 1`;
  if (!rows.length) throw new Error('TRAINING_BATCH_NOT_FOUND');
  const record = toBatchRecord(rows[0] as Record<string, unknown>);
  const itemRows = await sql`SELECT i.*,d.name,d.asset_symbol,d.duration_value,d.duration_unit,d.horizon_ticks FROM ml_training_batch_items i LEFT JOIN training_datasets d ON d.id=i.dataset_id::uuid WHERE i.batch_id=${batchId}::uuid ORDER BY i.id ASC`;
  const items: TrainingBatchItem[] = itemRows.map((row: any) => ({ id: Number(row.id), batch_id: String(row.batch_id), dataset_id: String(row.dataset_id), status: String(row.status || 'queued') as TrainingBatchItemStatus, requested_models: normalizeModels(row.requested_models), skipped_models: normalizeModels(row.skipped_models), run_id: row.run_id ? String(row.run_id) : null, completed_models: Number(row.completed_models || 0), failed_models: Number(row.failed_models || 0), error: row.error ? String(row.error) : null, started_at: row.started_at ? new Date(row.started_at).toISOString() : null, completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null, heartbeat_at: row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null, asset_symbol: row.asset_symbol ? String(row.asset_symbol) : undefined, duration_value: row.duration_value == null ? undefined : Number(row.duration_value), duration_unit: row.duration_unit ? String(row.duration_unit) : undefined, horizon_ticks: row.horizon_ticks == null ? undefined : Number(row.horizon_ticks) }));
  return { ...record, items };
}

export async function resumeTrainingBatch(batchId: string) {
  const batch = await getTrainingBatch(batchId);
  if (!['queued','running','partial'].includes(batch.status)) return batch;
  void processTrainingBatch(batchId);
  return { ...batch, resumed: true };
}
