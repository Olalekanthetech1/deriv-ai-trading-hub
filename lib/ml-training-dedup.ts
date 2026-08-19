import { getDbConnectionString, initDbSchema } from './db';
import type { MlModelKey } from './ml-model-registry';
import { neon } from '@neondatabase/serverless';

export type TrainingDedupDecision = {
  allowedModelTypes: MlModelKey[];
  skippedCompletedModelTypes: MlModelKey[];
  blockedFailedModelTypes: MlModelKey[];
};

export async function resolveTrainingDedup(datasetId: string, requestedModelTypes: MlModelKey[], retryFailed = false): Promise<TrainingDedupDecision> {
  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  const sql = neon(url);
  const candidates: MlModelKey[] = [...new Set(requestedModelTypes)];
  if (!candidates.length) return { allowedModelTypes: [], skippedCompletedModelTypes: [], blockedFailedModelTypes: [] };

  const runModelRows = await sql`
    SELECT m.model_type,m.status,r.created_at
    FROM ml_training_run_models m
    INNER JOIN ml_training_runs r ON r.run_id=m.run_id
    WHERE r.dataset_id=${datasetId}
      AND m.model_type = ANY(${candidates}::text[])
      AND m.status IN ('completed','failed','partial','timed_out','cancelled')
    ORDER BY r.created_at DESC
  `;

  const completed = new Set<MlModelKey>();
  const failed = new Set<MlModelKey>();
  for (const row of runModelRows) {
    const model = String(row.model_type) as MlModelKey;
    if (!candidates.includes(model) || completed.has(model)) continue;
    const status = String(row.status);
    if (status === 'completed') completed.add(model);
    else if (['failed','partial','timed_out','cancelled'].includes(status)) failed.add(model);
  }

  const registryRows = await sql`
    SELECT metrics->>'engine' AS engine
    FROM ml_model_registry_v2
    WHERE dataset_id=${datasetId}
      AND status IN ('candidate','staging','production')
  `;
  for (const row of registryRows) {
    const model = String(row.engine || '').trim() as MlModelKey;
    if (candidates.includes(model)) completed.add(model);
  }

  return {
    allowedModelTypes: candidates.filter((model) => !completed.has(model) && (!failed.has(model) || retryFailed)),
    skippedCompletedModelTypes: candidates.filter((model) => completed.has(model)),
    blockedFailedModelTypes: candidates.filter((model) => !completed.has(model) && failed.has(model) && !retryFailed),
  };
}
