import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from './db';
import { ensureUnifiedHorizonSchema } from './ml-unified-horizon-schema';
import { getMlRuntimeSchemaContract } from './ml-runtime-schema';
import { mlRuntimeClient } from './ml-runtime-client';
import { persistModelArtifact } from './ml-model-artifact-store';
import { registerDurationModel } from './duration-model-registry';
import { evaluateAndPromoteCandidateModels } from './ml-pipeline-auto-evaluator';
import {
  type UnifiedModelTrainingResult,
  type UnifiedMultiHorizonDatasetSummary,
  type HorizonValidationMetric,
} from './ml-unified-horizon-contract';

type Sql = any;

export type UnifiedTrainingRequest = {
  datasetId: string;
  modelType?: 'xgboost' | 'lightgbm' | 'catboost';
  hyperparameters?: Record<string, any>;
  autoPromote?: boolean;
};

function sqlClient(): Sql | null {
  const url = getDbConnectionString();
  return url ? neon(url) : null;
}

/**
 * Orchestrates a single unified multi-horizon training run.
 * Trains a single model across all horizons (tick and time) simultaneously.
 */
export async function trainUnifiedMultiHorizonModel(
  request: UnifiedTrainingRequest,
): Promise<UnifiedModelTrainingResult> {
  const datasetId = String(request.datasetId || '').trim();
  if (!datasetId) throw new Error('datasetId is required for Unified Multi-Horizon Training.');

  const modelType = request.modelType || 'xgboost';
  const sql = sqlClient();
  if (!sql || !(await initDbSchema())) throw new Error('Database is unavailable.');
  await ensureUnifiedHorizonSchema(sql);

  // Load dataset record
  const datasetRows = await sql`
    SELECT id, name, symbol, horizons, feature_schema_version, window_ticks,
           sample_count, train_count, validation_count, test_count, status, leakage_check_passed
    FROM ml_unified_horizon_datasets
    WHERE id = ${datasetId}::uuid
    LIMIT 1
  `;
  const dataset = datasetRows[0] as any;
  if (!dataset) throw new Error('UNIFIED_DATASET_NOT_FOUND');
  if (dataset.status !== 'completed' || dataset.leakage_check_passed !== true) {
    throw new Error('UNIFIED_DATASET_NOT_READY_FOR_TRAINING');
  }

  const symbol = String(dataset.symbol).toUpperCase();
  const horizons = Array.isArray(dataset.horizons) ? dataset.horizons : [];
  if (!horizons.length) throw new Error('DATASET_HAS_NO_HORIZONS');

  // Load samples
  const sampleRows = await sql`
    SELECT sample_index, split, feature_vector, horizon_labels
    FROM ml_unified_horizon_samples
    WHERE dataset_id = ${datasetId}::uuid
    ORDER BY sample_index ASC
  `;

  if (!sampleRows.length) throw new Error('DATASET_CONTAINS_NO_SAMPLES');

  const trainSamples = sampleRows
    .filter((r: any) => r.split === 'train')
    .map((r: any) => ({
      featureVector: Array.isArray(r.feature_vector) ? r.feature_vector.map(Number) : [],
      horizonLabels: r.horizon_labels || {},
    }));

  const validationSamples = sampleRows
    .filter((r: any) => r.split === 'validation')
    .map((r: any) => ({
      featureVector: Array.isArray(r.feature_vector) ? r.feature_vector.map(Number) : [],
      horizonLabels: r.horizon_labels || {},
    }));

  if (trainSamples.length < 10 || validationSamples.length < 5) {
    throw new Error('INSUFFICIENT_TRAINING_OR_VALIDATION_SAMPLES');
  }

  const schema = await getMlRuntimeSchemaContract({ durationValue: 60, durationUnit: 's' });
  const runId = crypto.randomUUID();

  // Create training run record
  await sql`
    INSERT INTO ml_unified_horizon_training_runs (
      run_id, dataset_id, symbol, model_type, status, horizons, started_at
    ) VALUES (
      ${runId}::uuid, ${datasetId}::uuid, ${symbol}::varchar, ${modelType}::varchar,
      'running'::varchar, ${JSON.stringify(horizons)}::jsonb, NOW()
    )
  `;

  try {
    const hyperparams = request.hyperparameters || {
      nEstimators: 300,
      maxDepth: 6,
      learningRate: 0.04,
      subsample: 0.85,
    };

    const response = await mlRuntimeClient.sendCommand('train_unified_multi_horizon', {
      symbol,
      modelType,
      datasetId,
      trainingRunId: runId,
      schemaContract: schema,
      horizons,
      trainSamples,
      validationSamples,
      hyperparams,
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Native unified multi-horizon training failed.');
    }

    const artifactPath = typeof response.artifactPath === 'string' ? response.artifactPath.trim() : '';
    let persistedSha256 = '';
    if (artifactPath) {
      const persisted = await persistModelArtifact(response.modelId, artifactPath);
      persistedSha256 = persisted.sha256;
      for (const h of horizons) {
        const hKey = String(h.key).toLowerCase();
        await persistModelArtifact(`${response.modelId}_${hKey}`, artifactPath).catch(() => undefined);
      }
    }

    const horizonMetrics: Record<string, HorizonValidationMetric> = response.horizonMetrics || {};
    const overallAccuracy = Number(response.overallAccuracy || 0);
    const overallLogLoss = Number(response.overallLogLoss || 0);
    const overallF1 = Number(response.overallF1 || 0);
    const fitMs = Number(response.fitMs || 0);

    // Update training run record
    await sql`
      UPDATE ml_unified_horizon_training_runs
      SET status = 'completed'::varchar,
          overall_accuracy = ${overallAccuracy}::numeric,
          overall_log_loss = ${overallLogLoss}::numeric,
          overall_f1 = ${overallF1}::numeric,
          horizon_metrics = ${JSON.stringify(horizonMetrics)}::jsonb,
          artifact_path = ${artifactPath}::varchar,
          fit_ms = ${fitMs}::numeric,
          completed_at = NOW(),
          metadata = jsonb_build_object(
            'engine', ${response.engine || 'Native Unified Multi-Horizon'}::text,
            'artifactSha256', ${persistedSha256}::text,
            'trainingSamples', ${trainSamples.length}::int,
            'validationSamples', ${validationSamples.length}::int,
            'schemaFingerprint', ${schema.schemaFingerprint}::text
          ),
          updated_at = NOW()
      WHERE run_id = ${runId}::uuid
    `;

    // Register one governed production candidate per canonical horizon. The complete
    // horizonMetrics map is persisted with every entry so production resolution can
    // validate the exact requested horizon without reconstructing or fabricating metrics.
    for (const h of horizons) {
      const hKey = String(h.key).toLowerCase();
      const hMetric = horizonMetrics[hKey];
      if (!hMetric) {
        throw new Error(`UNIFIED_HORIZON_VALIDATION_METRIC_MISSING:${hKey}`);
      }

      await registerDurationModel({
        modelId: `${response.modelId}_${hKey}`,
        modelFamily: 'tabular',
        version: `unified-${schema.featureSchemaVersion.slice(0, 8)}-${runId.slice(0, 8)}`,
        symbol,
        assetClass: 'synthetic_index',
        durationValue: Number(h.value),
        durationUnit: h.unit,
        durationSeconds: h.seconds,
        effectiveHorizonTicks: h.effectiveHorizonTicks || Number(h.value),
        datasetId,
        format: 'PKL',
        status: 'candidate',
        featureSchemaVersion: String(schema.featureSchemaVersion),
        framework: modelType,
        trainingRunId: runId,
        strategyKey: 'unified_multi_horizon',
        strategyVersion: 'v1.0.0',
        strategyMetadata: {
          unifiedTraining: true,
          totalHorizons: horizons.length,
          horizonKey: hKey,
        },
        metrics: {
          accuracy: hMetric.accuracy,
          f1: hMetric.f1,
          logLoss: hMetric.logLoss,
          winRate: hMetric.winRate,
          brierScore: hMetric.brierScore,
          auc: hMetric.auc,
          samples: hMetric.samples,
          horizonMetrics,
          overallAccuracy,
          overallF1,
          overallLogLoss,
          fitMs,
          engine: response.engine,
          trainedOnceForMultiHorizon: true,
          modelKey: modelType,
          lifecycleTier: 'production_candidate',
        },
        hyperparameters: hyperparams,
      }).catch((err) => {
        console.error(`[registerDurationModel Error for ${hKey}]:`, err);
      });
    }

    return {
      success: true,
      modelId: response.modelId,
      modelType,
      symbol,
      artifactPath,
      datasetId,
      trainingSamples: trainSamples.length,
      validationSamples: validationSamples.length,
      overallAccuracy,
      overallLogLoss,
      overallF1,
      horizonMetrics,
      fitMs,
      trainedOnceForMultiHorizon: true,
      featureSchemaVersion: schema.featureSchemaVersion,
      engine: response.engine,
    };
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE ml_unified_horizon_training_runs
      SET status = 'failed'::varchar,
          error = ${errorMsg}::text,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE run_id = ${runId}::uuid
    `;
    throw err;
  }
}

export async function listUnifiedTrainingRuns(symbol?: string) {
  const sql = sqlClient();
  if (!sql || !(await initDbSchema())) return [];
  await ensureUnifiedHorizonSchema(sql);

  return symbol
    ? sql`
        SELECT r.*, d.name AS dataset_name
        FROM ml_unified_horizon_training_runs r
        LEFT JOIN ml_unified_horizon_datasets d ON d.id = r.dataset_id
        WHERE r.symbol = ${symbol}
        ORDER BY r.created_at DESC
        LIMIT 50
      `
    : sql`
        SELECT r.*, d.name AS dataset_name
        FROM ml_unified_horizon_training_runs r
        LEFT JOIN ml_unified_horizon_datasets d ON d.id = r.dataset_id
        ORDER BY r.created_at DESC
        LIMIT 50
      `;
}
