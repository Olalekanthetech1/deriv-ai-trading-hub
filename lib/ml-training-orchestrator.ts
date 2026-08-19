import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from './db';
import { ensureTrainingDurationSchema } from './training-duration-schema';
import { getMlModelDefinitions, type MlModelKey } from './ml-model-registry';
import { registerDurationModel } from './duration-model-registry';
import { getMlRuntimeSchemaContract } from './ml-runtime-schema';
import { resolveAssetAwareModelStrategy } from './asset-aware-model-strategy';
import { mlRuntimeClient } from './ml-runtime-client';
import { persistModelArtifact } from './ml-model-artifact-store';
import { evaluateAndPromoteCandidateModels } from './ml-pipeline-auto-evaluator';

type DurationUnit = 't' | 's' | 'm' | 'h' | 'd';
type TrainingRequest = { datasetId: string; modelTypes?: MlModelKey[]; autoPromote?: boolean };
const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_TRAINING_STALE_AFTER_MS = 20 * 60 * 1000;
function envDurationMs(name: string, fallback: number, minimum: number, maximum: number): number { const raw = process.env[name]?.trim(); const value = raw ? Number(raw) : fallback; if (!Number.isFinite(value)) return fallback; return Math.min(maximum, Math.max(minimum, Math.trunc(value))); }
function trainingStaleAfterMs(): number { return envDurationMs('ML_TRAINING_STALE_AFTER_MS', DEFAULT_TRAINING_STALE_AFTER_MS, 60_000, 24 * 60 * 60 * 1000); }
function workerId(): string { return `${process.env.RENDER_INSTANCE_ID?.trim() || 'node'}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`; }
function normalizeId(value: unknown): string { return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : ''; }
function asRecord(value: unknown): Record<string, unknown> | null { if (!value || typeof value !== 'object' || Array.isArray(value)) return null; return value as Record<string, unknown>; }
function sameFeatureWindows(a: Record<string, unknown>, b: Record<string, unknown>): boolean { return ['micro', 'short', 'medium', 'macro'].every((key) => Number(a[key]) === Number(b[key])); }
function sameSplitRatios(a: Record<string, unknown>, b: Record<string, unknown>): boolean { return ['train', 'validation', 'test'].every((key) => Number(a[key]) === Number(b[key])); }
function isStructurallyCompatibleDataset(dataset: any, schema: any): boolean { const metadata = asRecord(dataset?.metadata); const pipelineConfig = asRecord(metadata?.pipelineConfig); if (!pipelineConfig) return false; const featureOrder = Array.isArray(pipelineConfig.featureOrder) ? pipelineConfig.featureOrder.map((value) => String(value)) : []; if (featureOrder.length !== schema.featureCount || featureOrder.join('|') !== schema.featureOrder.join('|')) return false; if (Number(pipelineConfig.canonicalFeatureWindowTicks) !== Number(schema.canonicalFeatureWindowTicks)) return false; const configuredFeatureWindows = asRecord(pipelineConfig.featureWindows); const configuredSequenceLength = Number(pipelineConfig.sequenceLength ?? configuredFeatureWindows?.short ?? NaN); if (configuredSequenceLength !== Number(schema.sequenceLength) || !configuredFeatureWindows || !sameFeatureWindows(configuredFeatureWindows, schema.featureWindows)) return false; const splitRatios = asRecord(pipelineConfig.splitRatios); if (!splitRatios || !sameSplitRatios(splitRatios, schema.splitRatios)) return false; if (String(pipelineConfig.normalizationMethod ?? '') !== String(schema.normalizationMethod) || Number(pipelineConfig.normalizationEpsilon ?? NaN) !== Number(schema.normalizationEpsilon)) return false; return true; }
function sequencePartitions(rows: any[], sequenceLength: number, schema: any) { const result: Record<string, any> = {}; for (const split of ['train', 'validation', 'test']) { const ordered = rows.filter((row) => row.split === split).sort((a, b) => Number(a.sample_index) - Number(b.sample_index)); const featureSequences: number[][][] = []; const labels: number[] = []; for (let i = sequenceLength - 1; i < ordered.length; i += 1) { const window = ordered.slice(i - sequenceLength + 1, i + 1); const vectors = window.map((row) => Array.isArray(row.feature_vector) ? row.feature_vector.map(Number) : null); if (vectors.some((v: number[] | null) => !v || v.length !== schema.featureCount || v.some((x) => !Number.isFinite(x)))) continue; featureSequences.push(vectors as number[][]); labels.push(String(ordered[i].label).toUpperCase() === 'RISE' ? 1 : 0); } result[split] = { featureSequences, labels, featureCount: schema.featureCount, sequenceLength, schemaVersion: schema.featureSchemaVersion, schemaFingerprint: schema.schemaFingerprint }; } return result; }
async function updateRun(sql: any, runId: string, status: string, completedModels: number, failedModels: number, completedAt: string | null = null, metadata: Record<string, unknown> = {}) { await sql`UPDATE ml_training_runs SET status=${status}::varchar,completed_models=${completedModels}::integer,failed_models=${failedModels}::integer,completed_at=${completedAt}::timestamptz,metadata=${JSON.stringify(metadata)}::jsonb,updated_at=NOW() WHERE run_id=${runId}::uuid`; }
async function reconcileStaleTrainingRuns(sql: any): Promise<number> { const staleMs = trainingStaleAfterMs(); const staleRuns = await sql`SELECT run_id FROM ml_training_runs WHERE status='running' AND COALESCE(heartbeat_at, updated_at, started_at, created_at) < NOW() - (${staleMs}::bigint * INTERVAL '1 millisecond')`; if (!staleRuns.length) return 0; for (const row of staleRuns) { const runId = String(row.run_id); await sql`UPDATE ml_training_run_models SET status=CASE WHEN status='running' THEN 'timed_out' ELSE 'cancelled' END,error=CASE WHEN status='running' THEN 'Training worker heartbeat expired; the active worker was no longer observable.' ELSE 'Training run became stale before this model started.' END,completed_at=COALESCE(completed_at, NOW()),heartbeat_at=NULL WHERE run_id=${runId}::uuid AND status IN ('running','queued')`; await sql`UPDATE ml_training_runs SET status='timed_out',error='Training worker heartbeat expired; the run was reconciled as stale.',completed_at=COALESCE(completed_at, NOW()),heartbeat_at=NULL,metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('staleRecovery', jsonb_build_object('reconciledAt', NOW(), 'staleAfterMs', (${staleMs}::bigint))),updated_at=NOW() WHERE run_id=${runId}::uuid AND status='running'`; await sql`DELETE FROM ml_training_run_reservations WHERE run_id=${runId}::uuid`; } return staleRuns.length; }
function startTrainingHeartbeat(sql: any, runId: string, modelType: string, activeWorkerId: string) { const beat = async () => { try { await sql`UPDATE ml_training_runs SET heartbeat_at=NOW(), worker_id=${activeWorkerId}::varchar, updated_at=NOW() WHERE run_id=${runId}::uuid AND status='running'`; await sql`UPDATE ml_training_run_models SET heartbeat_at=NOW() WHERE run_id=${runId}::uuid AND model_type=${modelType}::varchar AND status='running'`; } catch {} }; void beat(); const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS); return () => clearInterval(timer); }

export async function trainDatasetModels(request: TrainingRequest) {
  const datasetId = normalizeId(request.datasetId); if (!datasetId) throw new Error('datasetId is required.');
  const url = getDbConnectionString(); if (!url || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  const sql = neon(url); await ensureTrainingDurationSchema(sql);
  await sql`CREATE TABLE IF NOT EXISTS ml_training_run_reservations (dataset_id UUID PRIMARY KEY,run_id UUID NOT NULL UNIQUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`; await reconcileStaleTrainingRuns(sql);
  let dataset: any = null;
  let isUnifiedDataset = false;
  const standardRows = await sql`SELECT id,name,asset_symbol,duration_value,duration_unit,duration_seconds,horizon_type,horizon_ticks,status,leakage_check_passed,feature_schema_version,sample_count,train_count,validation_count,test_count,metadata FROM training_datasets WHERE id=${datasetId} LIMIT 1`;
  if (standardRows.length) {
    dataset = standardRows[0];
  } else {
    const unifiedRows = await sql`SELECT id,name,symbol AS asset_symbol,2 AS duration_value,'t' AS duration_unit,NULL AS duration_seconds,'ticks' AS horizon_type,2 AS horizon_ticks,status,leakage_check_passed,feature_schema_version,sample_count,train_count,validation_count,test_count,metadata,horizons FROM ml_unified_horizon_datasets WHERE id=${datasetId}::uuid LIMIT 1`;
    if (unifiedRows.length) {
      dataset = unifiedRows[0];
      isUnifiedDataset = true;
    }
  }
  if (!dataset) throw new Error('TRAINING_DATASET_NOT_FOUND'); if (dataset.status !== 'completed' || dataset.leakage_check_passed !== true) throw new Error('DATASET_NOT_READY_FOR_TRAINING');
  const durationValue = Number(dataset.duration_value); const durationUnit = dataset.duration_unit as DurationUnit; const durationSeconds = dataset.duration_seconds == null ? null : Number(dataset.duration_seconds); const effectiveHorizonTicks = Number(dataset.horizon_ticks);
  if (!Number.isSafeInteger(durationValue) || durationValue <= 0 || !['t', 's', 'm', 'h', 'd'].includes(durationUnit) || !Number.isSafeInteger(effectiveHorizonTicks) || effectiveHorizonTicks <= 0) throw new Error('INVALID_DATASET_DURATION_METADATA');
  const schema = await getMlRuntimeSchemaContract({ durationValue, durationUnit }); const datasetSchemaVersion = String(dataset.feature_schema_version ?? ''); const currentSchemaVersion = String(schema.featureSchemaVersion); const schemaCompatible = datasetSchemaVersion === currentSchemaVersion || isStructurallyCompatibleDataset(dataset, schema) || isUnifiedDataset; if (!schemaCompatible) throw new Error(`DATASET_FEATURE_SCHEMA_VERSION_MISMATCH: dataset=${datasetSchemaVersion || 'unknown'} current=${currentSchemaVersion}`);
  const running = await sql`SELECT run_id FROM ml_training_runs WHERE status='running' ORDER BY created_at DESC LIMIT 1`; if (running.length) throw new Error('TRAINING_ALREADY_RUNNING');
  let samples: any[] = [];
  if (isUnifiedDataset) {
    const rawUnified = await sql`SELECT sample_index,split,feature_vector,horizon_labels FROM ml_unified_horizon_samples WHERE dataset_id=${datasetId}::uuid ORDER BY sample_index ASC`;
    samples = rawUnified.map((r: any) => {
      const labels = r.horizon_labels || {};
      const firstLabel = labels['2t'] || labels['1m'] || Object.values(labels)[0] || 'RISE';
      return {
        sample_index: r.sample_index,
        split: r.split,
        label: String(firstLabel).toUpperCase() === 'FALL' ? 'FALL' : 'RISE',
        feature_vector: r.feature_vector,
      };
    });
  } else {
    samples = await sql`SELECT sample_index,split,label,feature_vector FROM training_dataset_samples WHERE dataset_id=${datasetId} ORDER BY sample_index ASC`;
  }
  if (!samples.length) throw new Error('DATASET_CONTAINS_NO_SAMPLES');
  const partitions: Record<string, any> = {}; for (const split of ['train', 'validation', 'test']) { const splitRows = samples.filter((row: any) => row.split === split); const vectors = splitRows.map((row: any) => Array.isArray(row.feature_vector) ? row.feature_vector.map(Number) : null); if (vectors.some((v: number[] | null) => !v || v.length !== schema.featureCount || v.some((x) => !Number.isFinite(x)))) throw new Error(`INVALID_FEATURE_VECTOR:${split}`); partitions[split] = { featureVectors: vectors, labels: splitRows.map((row: any) => String(row.label).toUpperCase() === 'RISE' ? 1 : 0), sampleCount: splitRows.length, featureCount: schema.featureCount, schemaVersion: schema.featureSchemaVersion, schemaFingerprint: schema.schemaFingerprint }; }
  if (partitions.train.sampleCount < 2 || new Set(partitions.train.labels).size < 2 || partitions.validation.sampleCount < 2 || new Set(partitions.validation.labels).size < 2) throw new Error('INSUFFICIENT_TWO_CLASS_TRAIN_VALIDATION_DATA');
  const assetRows = await sql`SELECT asset_class,market_type,metadata FROM market_assets WHERE symbol=${String(dataset.asset_symbol)}::varchar LIMIT 1`; const assetClass = String(assetRows[0]?.asset_class || 'unknown'); const marketType = String(assetRows[0]?.market_type || 'unknown'); const assetMetadata = assetRows[0]?.metadata && typeof assetRows[0].metadata === 'object' ? assetRows[0].metadata : {};
  const definitions = getMlModelDefinitions().filter((d) => !request.modelTypes?.length || request.modelTypes.includes(d.key)); if (!definitions.length) throw new Error('NO_REGISTERED_MODELS_SELECTED');
  const strategy = resolveAssetAwareModelStrategy({ assetClass, marketType, durationValue, durationUnit, durationSeconds, effectiveHorizonTicks, sampleCount: Number(dataset.sample_count) || samples.length }, definitions); const sequenceLength = schema.sequenceLength; const sequence = sequencePartitions(samples, sequenceLength, schema); if (sequence.train.featureSequences.length < 2 || new Set(sequence.train.labels).size < 2 || sequence.validation.featureSequences.length < 2 || new Set(sequence.validation.labels).size < 2) throw new Error('INSUFFICIENT_TWO_CLASS_SEQUENCE_DATA');
  const runId = crypto.randomUUID(); const activeWorkerId = workerId(); const strategyMetadata = { ...strategy, sequenceLength, featureTopology: schema.featureWindows, featureSchemaVersion: schema.featureSchemaVersion, schemaFingerprint: schema.schemaFingerprint, assetMetadata };
  const reservation = await sql`INSERT INTO ml_training_run_reservations (dataset_id,run_id) VALUES (${datasetId}::uuid,${runId}::uuid) ON CONFLICT (dataset_id) DO NOTHING RETURNING dataset_id`; if (!reservation.length) throw new Error('TRAINING_ALREADY_RUNNING');
  try { await sql`INSERT INTO ml_training_runs (run_id,dataset_id,asset_symbol,duration_value,duration_unit,duration_seconds,horizon_ticks,status,requested_models,started_at,heartbeat_at,worker_id,metadata,strategy_key,strategy_version,strategy_metadata) VALUES (${runId}::uuid,${datasetId}::text,${String(dataset.asset_symbol)}::varchar,${durationValue}::integer,${durationUnit}::varchar,${durationSeconds}::numeric,${effectiveHorizonTicks}::integer,'running'::varchar,${JSON.stringify(definitions.map((d) => d.key))}::jsonb,NOW(),NOW(),${activeWorkerId}::varchar,${JSON.stringify({featureSchemaVersion:schema.featureSchemaVersion,schemaFingerprint:schema.schemaFingerprint,datasetFeatureSchemaVersion: datasetSchemaVersion,datasetSchemaCompatibility: schemaCompatible ? 'compatible' : 'exact',featureTopology:schema.featureWindows,sequenceLength,workerId:activeWorkerId})}::jsonb,${strategy.key}::varchar,${strategy.version}::varchar,${JSON.stringify(strategyMetadata)}::jsonb)`; for (const d of definitions) await sql`INSERT INTO ml_training_run_models(run_id,model_type,status) VALUES(${runId}::uuid,${d.key}::varchar,'queued'::varchar)`; } catch (error) { await sql`DELETE FROM ml_training_run_reservations WHERE run_id=${runId}::uuid`; throw error; }
  const results: any[] = []; let completed = 0; let failed = 0; let timeoutCount = 0;
  for (const definition of definitions) {
    await sql`UPDATE ml_training_run_models SET status='running'::varchar,started_at=NOW(),heartbeat_at=NOW() WHERE run_id=${runId}::uuid AND model_type=${definition.key}::varchar`; const stopHeartbeat = startTrainingHeartbeat(sql, runId, definition.key, activeWorkerId); let modelTimedOut = false;
    try {
      const sequenceModel = definition.family === 'sequential'; const configuredHyperparameters = { ...strategy.hyperparameters[definition.key] } as Record<string, number>; if (sequenceModel) configuredHyperparameters.sequenceLength = sequenceLength;
      const result = await mlRuntimeClient.sendCommand('train_partitioned', { symbol: String(dataset.asset_symbol), modelType: definition.key, durationValue, durationUnit, durationSeconds, effectiveHorizonTicks, datasetId, trainingRunId: runId, schemaContract: schema, trainTabularDataset: sequenceModel ? undefined : partitions.train, validationTabularDataset: sequenceModel ? undefined : partitions.validation, trainSequenceDataset: sequenceModel ? sequence.train : undefined, validationSequenceDataset: sequenceModel ? sequence.validation : undefined, hyperparams: configuredHyperparameters, assetAwareStrategy: { key: strategy.key, version: strategy.version, assetClass: strategy.assetClass, marketType: strategy.marketType, sequenceLength, minimumSamples: strategy.minimumSamples[definition.key] } });
      if (!result?.success) throw new Error(result?.error || 'Native training failed.');
      const modelId = String(result.modelId); const artifactPath = typeof result.artifactPath === 'string' ? result.artifactPath.trim() : '';
      if (!artifactPath) throw new Error('TRAINED_MODEL_ARTIFACT_PATH_MISSING');
      const artifact = await persistModelArtifact(modelId, artifactPath);
      const metrics = { modelKey: definition.key, ...(result.metrics || {}), engine: result.engine, samplesCount: result.samplesCount, validationSamples: result.validationSamples, assetAwareStrategy: strategy.key, assetAwareStrategyVersion: strategy.version, featureTopology: schema.featureWindows, featureSchemaVersion: schema.featureSchemaVersion, artifactSha256: artifact.sha256, artifactByteSize: artifact.byteSize, durableArtifactStore: true };
      await registerDurationModel({ modelId, modelFamily: definition.family, version: `${schema.featureSchemaVersion}-${runId.slice(0, 8)}`, symbol: String(dataset.asset_symbol), assetClass, durationValue, durationUnit, durationSeconds, effectiveHorizonTicks, datasetId, format: sequenceModel ? 'PT_STATE' : 'PKL', status: 'candidate', featureSchemaVersion: String(schema.featureSchemaVersion), framework: sequenceModel ? 'pytorch' : definition.key, trainingRunId: runId, strategyKey: strategy.key, strategyVersion: strategy.version, strategyMetadata: { sequenceLength, featureTopology: schema.featureWindows, minimumSamples: strategy.minimumSamples[definition.key], assetClass: strategy.assetClass, marketType: strategy.marketType }, metrics, hyperparameters: configuredHyperparameters });
      await sql`UPDATE ml_training_run_models SET status='completed'::varchar,model_id=${modelId}::text,metrics=${JSON.stringify(metrics)}::jsonb,completed_at=NOW(),heartbeat_at=NULL WHERE run_id=${runId}::uuid AND model_type=${definition.key}::varchar`;
      completed += 1; results.push({ modelType: definition.key, success: true, modelId, metrics, engine: result.engine });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Native training failed.'; modelTimedOut = message.startsWith('ML_TRAINING_TIMEOUT'); await sql`UPDATE ml_training_run_models SET status=${modelTimedOut ? 'timed_out' : 'failed'}::varchar,error=${message}::text,completed_at=NOW(),heartbeat_at=NULL WHERE run_id=${runId}::uuid AND model_type=${definition.key}::varchar`; failed += 1; if (modelTimedOut) timeoutCount += 1; results.push({ modelType: definition.key, success: false, timedOut: modelTimedOut, error: message });
    } finally { stopHeartbeat(); }
    const done = completed + failed; await updateRun(sql, runId, done === definitions.length ? (failed === 0 ? 'completed' : completed > 0 ? 'partial' : 'failed') : 'running', completed, failed, done === definitions.length ? new Date().toISOString() : null, { progress: { completed, failed, total: definitions.length }, featureSchemaVersion: schema.featureSchemaVersion, schemaFingerprint: schema.schemaFingerprint, featureTopology: schema.featureWindows, sequenceLength, timeoutCount, strategy: { key: strategy.key, version: strategy.version, assetClass: strategy.assetClass, marketType: strategy.marketType, sequenceLength }, lastModel: { modelType: definition.key, timedOut: modelTimedOut } });
  }
  const finalStatus = failed === 0 ? 'completed' : completed > 0 ? 'partial' : 'failed';
  await sql`UPDATE ml_training_runs SET status=${finalStatus}::varchar,completed_models=${completed}::integer,failed_models=${failed}::integer,completed_at=COALESCE(completed_at,NOW()),heartbeat_at=NULL,metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('timeoutCount', ${timeoutCount}::integer),updated_at=NOW() WHERE run_id=${runId}::uuid`;
  if (finalStatus !== 'completed') await sql`DELETE FROM ml_training_run_reservations WHERE run_id=${runId}::uuid`;

  // Automated Walk-Forward Backtest & Governed Cohort Promotion Phase
  let pipelineEvaluation = null;
  const trainedModelIds = results.filter((r) => r.success && r.modelId).map((r) => String(r.modelId));
  if (trainedModelIds.length > 0) {
    try {
      pipelineEvaluation = await evaluateAndPromoteCandidateModels(trainedModelIds, {
        autoPromoteOnPass: request.autoPromote ?? true,
      });
    } catch (evalErr) {
      console.warn(`[ML Training Pipeline] Auto-backtest evaluation error for run ${runId}:`, evalErr);
    }
  }

  return { runId, status: finalStatus, completedModels: completed, failedModels: failed, totalModels: definitions.length, strategy: { key: strategy.key, version: strategy.version, sequenceLength, featureTopology: schema.featureWindows }, dataset: { id: datasetId, symbol: dataset.asset_symbol, durationValue, durationUnit, durationSeconds, effectiveHorizonTicks }, results, pipelineEvaluation };
}

export async function listTrainingRuns(symbol?: string) { const url = getDbConnectionString(); if (!url || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE'); const sql = neon(url); await ensureTrainingDurationSchema(sql); await reconcileStaleTrainingRuns(sql); const rows = symbol ? await sql`SELECT r.*,COALESCE(json_agg(m ORDER BY m.created_at) FILTER(WHERE m.id IS NOT NULL),'[]'::json) AS models FROM ml_training_runs r LEFT JOIN ml_training_run_models m ON m.run_id=r.run_id WHERE r.asset_symbol=${symbol}::varchar GROUP BY r.run_id ORDER BY r.created_at DESC LIMIT 50` : await sql`SELECT r.*,COALESCE(json_agg(m ORDER BY m.created_at) FILTER(WHERE m.id IS NOT NULL),'[]'::json) AS models FROM ml_training_runs r LEFT JOIN ml_training_run_models m ON m.run_id=r.run_id GROUP BY r.run_id ORDER BY r.created_at DESC LIMIT 50`; return rows; }
export async function clearTrainingRunHistory() { const url = getDbConnectionString(); if (!url || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE'); const sql = neon(url); await ensureTrainingDurationSchema(sql); await sql`UPDATE ml_training_run_models SET status='cancelled'::varchar,error=COALESCE(error,'Training history archived by admin.'),completed_at=COALESCE(completed_at,NOW()),heartbeat_at=NULL WHERE run_id IN (SELECT run_id FROM ml_training_runs WHERE status IN ('failed','partial','timed_out','cancelled')) AND status IN ('queued','running')`; await sql`DELETE FROM ml_training_run_models WHERE run_id IN (SELECT run_id FROM ml_training_runs WHERE status IN ('failed','partial','timed_out','cancelled'))`; await sql`DELETE FROM ml_training_runs WHERE status IN ('failed','partial','timed_out','cancelled')`; return true; }
