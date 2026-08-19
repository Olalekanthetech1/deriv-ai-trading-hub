import { NextResponse } from 'next/server';
import { getDbConnectionString } from '@/lib/db';
import { neon } from '@neondatabase/serverless';
import { enqueueTrainingJob } from '@/lib/ml-training-queue';
import { getMlRuntimeSchemaContract } from '@/lib/ml-runtime-schema';

export async function POST(req: Request) {
  try {
    const url = getDbConnectionString();
    if (!url) {
      return NextResponse.json({ error: 'Database connection not configured' }, { status: 500 });
    }
    const sql = neon(url);

    const contract = await getMlRuntimeSchemaContract();
    const currentFingerprint = contract.schemaFingerprint;

    const productionModels = await sql`
      SELECT model_id, model_family, feature_schema_version, status 
      FROM ml_model_registry_v2 
      WHERE status = 'production'
    `;

    let demotedCount = 0;
    const mismatchedModels: string[] = [];
    
    for (const model of productionModels) {
      if (model.feature_schema_version !== currentFingerprint) {
        await sql`
          UPDATE ml_model_registry_v2 
          SET status = 'archived' 
          WHERE model_id = ${model.model_id}
        `;
        mismatchedModels.push(model.model_family);
        demotedCount++;
      }
    }

    let queuedCount = 0;
    
    if (demotedCount > 0 || productionModels.length === 0) {
      // Find the latest dataset
      const datasets = await sql`
        SELECT id FROM training_datasets 
        WHERE status = 'completed' 
        ORDER BY created_at DESC 
        LIMIT 1
      `;
      
      if (datasets.length > 0) {
        const datasetId = datasets[0].id;
        
        // Find distinct model types registered in the system
        const registeredModelTypes = await sql`SELECT DISTINCT model_family FROM ml_model_registry_v2 WHERE model_family != ''`;
        const allTypes = registeredModelTypes.map(r => r.model_family);
        const defaultTypes = ['xgboost', 'lightgbm', 'random_forest'];
        
        const modelTypes = mismatchedModels.length > 0 ? Array.from(new Set(mismatchedModels)) : (allTypes.length > 0 ? allTypes : defaultTypes);
        
        await enqueueTrainingJob({ 
          datasetId, 
          modelTypes
        });
        queuedCount = modelTypes.length;
      } else {
        // Find any dataset if validated is missing
        const anyDatasets = await sql`SELECT id FROM training_datasets ORDER BY created_at DESC LIMIT 1`;
        if (anyDatasets.length > 0) {
           const datasetId = anyDatasets[0].id;
           
           const registeredModelTypes = await sql`SELECT DISTINCT model_family FROM ml_model_registry_v2 WHERE model_family != ''`;
           const allTypes = registeredModelTypes.map(r => r.model_family);
           const defaultTypes = ['xgboost', 'lightgbm', 'random_forest'];
           const modelTypes = mismatchedModels.length > 0 ? Array.from(new Set(mismatchedModels)) : (allTypes.length > 0 ? allTypes : defaultTypes);
          
           await enqueueTrainingJob({ 
            datasetId, 
            modelTypes
          });
          queuedCount = modelTypes.length;
        }
      }
    }

    return NextResponse.json({ 
      success: true, 
      demotedCount, 
      queuedCount, 
      message: `Demoted ${demotedCount} models. Queued ${queuedCount} training jobs.` 
    });
  } catch (error: any) {
    console.error('Failed to remedy schema:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
