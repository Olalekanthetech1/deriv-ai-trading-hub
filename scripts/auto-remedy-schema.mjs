import { getDbConnectionString, initDbSchema } from '../lib/db.ts';
import { neon } from '@neondatabase/serverless';
import { enqueueTrainingJob } from '../lib/ml-training-queue.ts';
import { getMlRuntimeSchemaContract } from '../lib/ml-runtime-schema.ts';

async function run() {
  const url = getDbConnectionString();
  if (!url) throw new Error('No DB URL');
  await initDbSchema();
  const sql = neon(url);

  const contract = await getMlRuntimeSchemaContract();
  const currentFingerprint = contract.schemaFingerprint;
  console.log('Current System Schema Fingerprint:', currentFingerprint);

  const productionModels = await sql`
    SELECT id, model_type, schema_fingerprint, status 
    FROM ml_model_registry_v2 
    WHERE status = 'production'
  `;

  let demotedCount = 0;
  for (const model of productionModels) {
    if (model.schema_fingerprint !== currentFingerprint) {
      console.log(`Mismatch found for ${model.model_type} (ID: ${model.id}): ${model.schema_fingerprint} != ${currentFingerprint}`);
      await sql`
        UPDATE ml_model_registry_v2 
        SET status = 'archived' 
        WHERE id = ${model.id}
      `;
      demotedCount++;
    }
  }

  console.log(`Demoted ${demotedCount} incompatible production models.`);

  if (demotedCount > 0 || productionModels.length === 0) {
    // Find the latest validated dataset
    const datasets = await sql`
      SELECT id FROM ml_datasets 
      WHERE status = 'validated' 
      ORDER BY created_at DESC 
      LIMIT 1
    `;
    
    if (datasets.length > 0) {
      const datasetId = datasets[0].id;
      console.log(`Queuing new training job for dataset ${datasetId}...`);
      await enqueueTrainingJob({ 
        datasetId, 
        modelTypes: ['xgboost', 'lightgbm', 'random_forest', 'gradient_boosting', 'lstm', 'svm'] 
      });
      console.log('Training job queued successfully.');
    } else {
      console.log('No validated datasets found to queue training.');
    }
  }
}

run().catch(console.error);
