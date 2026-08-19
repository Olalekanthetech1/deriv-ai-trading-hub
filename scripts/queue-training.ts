import { getDbConnectionString, initDbSchema } from '../lib/db';
import { neon } from '@neondatabase/serverless';
import { enqueueTrainingJob } from '../lib/ml-training-queue';

async function run() {
  const url = getDbConnectionString();
  if (!url) throw new Error('No DB URL');
  await initDbSchema();
  const sql = neon(url);

  const datasetId = '1d5e15a7-545e-460a-bb9d-949b0aee563e';
  const modelTypes = ['xgboost', 'lightgbm', 'random_forest', 'gradient_boosting', 'lstm', 'svm'];
  
  await enqueueTrainingJob({ 
    datasetId, 
    modelTypes
  });
  console.log(`Training job queued successfully for dataset ${datasetId} and models: ${modelTypes.join(', ')}.`);
}

run().catch(console.error);
