import { getDbConnectionString, initDbSchema } from '../lib/db';
import { neon } from '@neondatabase/serverless';
import { enqueueTrainingJob } from '../lib/ml-training-queue';
import { getMlRuntimeSchemaContract } from '../lib/ml-runtime-schema';

async function run() {
  const url = getDbConnectionString();
  if (!url) throw new Error('No DB URL');
  await initDbSchema();
  const sql = neon(url);

  const contract = await getMlRuntimeSchemaContract();
  const currentFingerprint = contract.schemaFingerprint;
  console.log('Current System Schema Fingerprint:', currentFingerprint);

  const productionModels = await sql`
    SELECT model_id, model_family, feature_schema_version, status 
    FROM ml_model_registry_v2 
    WHERE status = 'production'
  `;

  let demotedCount = 0;
  let mismatchedModels = [];
  for (const model of productionModels) {
    if (model.feature_schema_version !== currentFingerprint) {
      console.log(`Mismatch found for ${model.model_family} (ID: ${model.model_id}): ${model.feature_schema_version} != ${currentFingerprint}`);
      await sql`
        UPDATE ml_model_registry_v2 
        SET status = 'archived' 
        WHERE model_id = ${model.model_id}
      `;
      mismatchedModels.push(model.model_family);
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
      // We will just fetch the registered models directly
      const registeredModelTypes = await sql`SELECT DISTINCT model_family FROM ml_model_registry_v2 WHERE model_family != ''`;
      const allTypes = registeredModelTypes.map(r => r.model_family);
      const modelTypes = mismatchedModels.length > 0 ? mismatchedModels : (allTypes.length > 0 ? allTypes : ['xgboost', 'lightgbm', 'lstm']);
      
      console.log(`Queuing new training job for dataset ${datasetId} for models: ${modelTypes.join(', ')}...`);
      await enqueueTrainingJob({ 
        datasetId, 
        modelTypes
      });
      console.log('Training job queued successfully. Background ML worker will pick this up.');
    } else {
      console.log('No validated datasets found to queue training.');
    }
  } else {
    console.log('No schema mismatches found in production models.');
  }
}

run().catch(console.error);
