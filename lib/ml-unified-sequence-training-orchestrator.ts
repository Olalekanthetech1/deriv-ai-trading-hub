import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from './db';
import { getMlModelDefinitions, type MlModelKey } from './ml-model-registry';
import { getMlRuntimeSchemaContract } from './ml-runtime-schema';
import { resolveAssetAwareModelStrategy } from './asset-aware-model-strategy';
import { mlRuntimeClient } from './ml-runtime-client';
import { persistModelArtifact } from './ml-model-artifact-store';
import { registerDurationModel } from './duration-model-registry';
import { loadUnifiedSequenceDataset } from './ml-unified-sequence-adapter';
import { evaluateAndPromoteCandidateModels } from './ml-pipeline-auto-evaluator';

export type UnifiedSequenceTrainingRequest = {
  datasetId: string;
  horizonKey: string;
  modelTypes?: string[];
  trainingRunId?: string;
  autoPromote?: boolean;
};

function workerId(): string {
  return `${process.env.RENDER_INSTANCE_ID?.trim() || 'node'}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
}

function selectedSequenceDefinitions(modelTypes?: string[]) {
  const requested = new Set((modelTypes || []).map((value) => String(value).trim()));
  const definitions = getMlModelDefinitions().filter((definition) => definition.family === 'sequential' && definition.predictive);
  const selected = requested.size
    ? definitions.filter((definition) => requested.has(definition.key))
    : definitions.filter((definition) => definition.defaultEnabled && definition.lifecycleTier === 'production_candidate');
  if (!selected.length) throw new Error('NO_REGISTERED_SEQUENCE_MODELS_SELECTED');
  return selected;
}

async function sqlClient() {
  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  return neon(url);
}

export async function trainUnifiedSequenceModels(request: UnifiedSequenceTrainingRequest) {
  const dataset = await loadUnifiedSequenceDataset({ datasetId: request.datasetId, horizonKey: request.horizonKey });
  if (!dataset.effectiveHorizonTicks) throw new Error('UNIFIED_HORIZON_EFFECTIVE_TICKS_UNAVAILABLE');

  const definitions = selectedSequenceDefinitions(request.modelTypes);
  const sql = await sqlClient();
  const runId = request.trainingRunId || crypto.randomUUID();
  const activeWorkerId = workerId();

  const assetRows = await sql`SELECT asset_class,market_type,metadata FROM market_assets WHERE symbol=${dataset.symbol}::varchar LIMIT 1`;
  const assetClass = String(assetRows[0]?.asset_class || 'unknown');
  const marketType = String(assetRows[0]?.market_type || 'unknown');
  const assetMetadata = assetRows[0]?.metadata && typeof assetRows[0].metadata === 'object' ? assetRows[0].metadata : {};
  const schema = await getMlRuntimeSchemaContract({ durationValue: dataset.durationValue, durationUnit: dataset.durationUnit });
  const strategy = resolveAssetAwareModelStrategy({
    assetClass,
    marketType,
    durationValue: dataset.durationValue,
    durationUnit: dataset.durationUnit,
    durationSeconds: dataset.durationSeconds,
    effectiveHorizonTicks: dataset.effectiveHorizonTicks,
    sampleCount: dataset.trainSamples + dataset.validationSamples + dataset.testSamples,
  }, definitions);

  await sql`
    INSERT INTO ml_training_runs (
      run_id,dataset_id,asset_symbol,duration_value,duration_unit,duration_seconds,horizon_ticks,status,
      requested_models,started_at,heartbeat_at,worker_id,metadata,strategy_key,strategy_version,strategy_metadata
    ) VALUES (
      ${runId}::uuid,${dataset.sourceDatasetId}::text,${dataset.symbol}::varchar,${dataset.durationValue}::integer,
      ${dataset.durationUnit}::varchar,${dataset.durationSeconds}::numeric,${dataset.effectiveHorizonTicks}::integer,'running'::varchar,
      ${JSON.stringify(definitions.map((definition) => definition.key))}::jsonb,NOW(),NOW(),${activeWorkerId}::varchar,
      ${JSON.stringify({
        datasetSource: 'unified',
        sourceDatasetId: dataset.sourceDatasetId,
        horizonKey: dataset.horizonKey,
        featureSchemaVersion: dataset.featureSchemaVersion,
        schemaFingerprint: dataset.schemaFingerprint,
        sequenceLength: dataset.sequenceLength,
        trainSamples: dataset.trainSamples,
        validationSamples: dataset.validationSamples,
        testSamples: dataset.testSamples,
      })}::jsonb,
      ${strategy.key}::varchar,${strategy.version}::varchar,${JSON.stringify({ ...strategy, assetMetadata })}::jsonb
    )
    ON CONFLICT (run_id) DO NOTHING
  `;
  for (const definition of definitions) {
    await sql`INSERT INTO ml_training_run_models(run_id,model_type,status) VALUES(${runId}::uuid,${definition.key}::varchar,'queued'::varchar) ON CONFLICT DO NOTHING`;
  }

  const results: Array<{ modelKey: MlModelKey; modelId?: string; status: 'completed' | 'failed'; error?: string }> = [];
  let completed = 0;
  let failed = 0;
  const runHeartbeat = setInterval(() => {
    void sql`UPDATE ml_training_runs SET heartbeat_at=NOW(),updated_at=NOW() WHERE run_id=${runId}::uuid AND status='running'`;
  }, 15_000);

  try {
    for (const definition of definitions) {
      await sql`UPDATE ml_training_run_models SET status='running'::varchar,started_at=NOW(),heartbeat_at=NOW() WHERE run_id=${runId}::uuid AND model_type=${definition.key}::varchar`;
      try {
        const hyperparameters: Record<string, number> = {
          ...definition.defaultHyperparameters,
          sequenceLength: dataset.sequenceLength,
          ...(strategy.hyperparameters[definition.key] || {}),
        };
        const result = await mlRuntimeClient.sendCommand('train_partitioned', {
          symbol: dataset.symbol,
          modelType: definition.key,
          durationValue: dataset.durationValue,
          durationUnit: dataset.durationUnit,
          durationSeconds: dataset.durationSeconds,
          effectiveHorizonTicks: dataset.effectiveHorizonTicks,
          datasetId: dataset.sourceDatasetId,
          trainingRunId: runId,
          schemaContract: schema,
          trainSequenceDataset: dataset.train,
          validationSequenceDataset: dataset.validation,
          hyperparams: hyperparameters,
          assetAwareStrategy: {
            key: strategy.key,
            version: strategy.version,
            assetClass: strategy.assetClass,
            marketType: strategy.marketType,
            sequenceLength: dataset.sequenceLength,
            minimumSamples: strategy.minimumSamples[definition.key],
          },
          datasetSource: 'unified',
          sourceDatasetId: dataset.sourceDatasetId,
          horizonKey: dataset.horizonKey,
        });
        if (!result?.success) throw new Error(result?.error || 'Native sequence training failed.');
        const modelId = String(result.modelId || '').trim();
        const artifactPath = typeof result.artifactPath === 'string' ? result.artifactPath.trim() : '';
        if (!modelId) throw new Error('TRAINED_MODEL_ID_MISSING');
        if (!artifactPath) throw new Error('TRAINED_MODEL_ARTIFACT_PATH_MISSING');
        const artifact = await persistModelArtifact(modelId, artifactPath);
        const metrics = {
          ...(result.metrics || {}),
          engine: result.engine,
          samplesCount: result.samplesCount,
          validationSamples: result.validationSamples,
          datasetSource: 'unified',
          sourceDatasetId: dataset.sourceDatasetId,
          horizonKey: dataset.horizonKey,
          sequenceLength: dataset.sequenceLength,
          featureSchemaVersion: dataset.featureSchemaVersion,
          schemaFingerprint: dataset.schemaFingerprint,
          artifactSha256: artifact.sha256,
          artifactByteSize: artifact.byteSize,
          durableArtifactStore: true,
        };
        await registerDurationModel({
          modelId,
          modelFamily: definition.family,
          version: `${dataset.featureSchemaVersion}-${dataset.horizonKey}-${runId.slice(0, 8)}`,
          symbol: dataset.symbol,
          assetClass,
          durationValue: dataset.durationValue,
          durationUnit: dataset.durationUnit,
          durationSeconds: dataset.durationSeconds,
          effectiveHorizonTicks: dataset.effectiveHorizonTicks,
          datasetId: dataset.sourceDatasetId,
          format: 'PT_STATE',
          status: 'candidate',
          featureSchemaVersion: dataset.featureSchemaVersion,
          framework: 'pytorch',
          trainingRunId: runId,
          strategyKey: strategy.key,
          strategyVersion: strategy.version,
          strategyMetadata: { datasetSource: 'unified', sourceDatasetId: dataset.sourceDatasetId, horizonKey: dataset.horizonKey, sequenceLength: dataset.sequenceLength, assetClass, marketType },
          metrics: { ...metrics, artifactPath },
          hyperparameters,
        });
        await sql`UPDATE ml_training_run_models SET status='completed'::varchar,model_id=${modelId}::text,metrics=${JSON.stringify(metrics)}::jsonb,completed_at=NOW(),heartbeat_at=NULL WHERE run_id=${runId}::uuid AND model_type=${definition.key}::varchar`;
        completed += 1;
        results.push({ modelKey: definition.key, modelId, status: 'completed' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed += 1;
        results.push({ modelKey: definition.key, status: 'failed', error: message });
        await sql`UPDATE ml_training_run_models SET status='failed'::varchar,error=${message}::text,completed_at=NOW(),heartbeat_at=NULL WHERE run_id=${runId}::uuid AND model_type=${definition.key}::varchar`;
      }
    }
    const finalStatus = completed > 0 && failed === 0 ? 'completed' : completed > 0 ? 'partial' : 'failed';
    await sql`UPDATE ml_training_runs SET status=${finalStatus}::varchar,completed_models=${completed}::integer,failed_models=${failed}::integer,completed_at=NOW(),heartbeat_at=NULL,updated_at=NOW(),metadata=COALESCE(metadata,'{}'::jsonb) || ${JSON.stringify({ datasetSource: 'unified', sourceDatasetId: dataset.sourceDatasetId, horizonKey: dataset.horizonKey })}::jsonb WHERE run_id=${runId}::uuid`;

    // Automated Walk-Forward Backtest & Governed Cohort Promotion Phase
    let pipelineEvaluation = null;
    const trainedModelIds = results.filter((r) => r.status === 'completed' && r.modelId).map((r) => String(r.modelId));
    if (trainedModelIds.length > 0) {
      try {
        pipelineEvaluation = await evaluateAndPromoteCandidateModels(trainedModelIds, {
          autoPromoteOnPass: request.autoPromote ?? true,
        });
      } catch (evalErr) {
        console.warn(`[ML Sequence Training Pipeline] Auto-backtest evaluation error for run ${runId}:`, evalErr);
      }
    }

    return { runId, status: finalStatus, completedModels: completed, failedModels: failed, results, sourceDatasetId: dataset.sourceDatasetId, horizonKey: dataset.horizonKey, pipelineEvaluation };
  } finally {
    clearInterval(runHeartbeat);
  }
}
