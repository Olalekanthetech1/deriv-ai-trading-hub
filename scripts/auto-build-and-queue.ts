import { getDbConnectionString, initDbSchema } from '../lib/db';
import { neon } from '@neondatabase/serverless';
import { buildDurationTrainingDataset } from '../lib/training-dataset-builder-duration-v2';
import { enqueueTrainingJob } from '../lib/ml-training-queue';

async function run() {
  const url = getDbConnectionString();
  if (!url) throw new Error('No DB URL');
  await initDbSchema();

  console.log("Building dataset for 1HZ10V 2t...");
  try {
    const dataset = await buildDurationTrainingDataset({ 
        symbol: '1HZ10V', 
        durationValue: 2, 
        durationUnit: 't' 
    });
    console.log("Built dataset:", dataset.datasetId);
    
    console.log("Queuing training job...");
    await enqueueTrainingJob({ 
      datasetId: dataset.datasetId, 
      modelTypes: ['xgboost', 'lightgbm', 'random_forest'] 
    });
    console.log('Training job queued successfully.');
  } catch (err) {
    console.error('Dataset build failed:', err);
  }
}

run().catch(console.error);
