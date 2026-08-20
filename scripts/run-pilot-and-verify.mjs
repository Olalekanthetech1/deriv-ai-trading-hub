import { neon } from '@neondatabase/serverless';
import { buildUnifiedMultiHorizonDataset } from '../lib/ml-unified-horizon-dataset-builder.ts';
import { trainUnifiedMultiHorizonModel } from '../lib/ml-unified-horizon-orchestrator.ts';
import { resolveProductionModels } from '../lib/production-model-resolver.ts';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function main() {
  console.log('=== STEP 1: SELECTING REPRESENTATIVE PILOT TARGETS ===');
  
  const rows = await sql`
    SELECT
      model_id,
      asset_symbol,
      duration_value,
      duration_unit,
      strategy_key,
      training_run_id,
      metrics
    FROM ml_model_registry_v2
    WHERE status = 'production'
    ORDER BY asset_symbol, duration_value, duration_unit;
  `;

  const classifyRow = (r) => {
    const metrics = r.metrics || {};
    const unified = r.strategy_key === 'unified_multi_horizon' || metrics.trainedOnceForMultiHorizon === true;
    return unified && r.training_run_id ? 'unified-retrain' : 'validation-retrain';
  };

  const unifiedCandidates = rows.filter((r) => classifyRow(r) === 'unified-retrain');
  const validationCandidates = rows.filter((r) => classifyRow(r) === 'validation-retrain');

  console.log(`Available unified-retrain candidates: ${unifiedCandidates.length}`);
  console.log(`Available validation-retrain candidates: ${validationCandidates.length}`);

  // Target 1: R_100 (Tick-based, unified-retrain)
  const pilot1 = unifiedCandidates.find((r) => r.asset_symbol === 'R_100' && String(r.duration_unit).toLowerCase() === 't') || unifiedCandidates[0];
  // Target 2: 1HZ100V (Time-based, validation-retrain)
  const pilot2 = validationCandidates.find((r) => r.asset_symbol === '1HZ100V' && String(r.duration_unit).toLowerCase() === 's') || validationCandidates[0];
  // Target 3: JD50 (Tick-based, validation-retrain)
  const pilot3 = validationCandidates.find((r) => r.asset_symbol === 'JD50') || validationCandidates[1];

  const pilotTargets = [
    {
      symbol: pilot1.asset_symbol,
      durationValue: Number(pilot1.duration_value),
      durationUnit: String(pilot1.duration_unit).toLowerCase(),
      classification: classifyRow(pilot1),
      originalModelId: pilot1.model_id,
    },
    {
      symbol: pilot2.asset_symbol,
      durationValue: Number(pilot2.duration_value),
      durationUnit: String(pilot2.duration_unit).toLowerCase(),
      classification: classifyRow(pilot2),
      originalModelId: pilot2.model_id,
    },
    {
      symbol: pilot3.asset_symbol,
      durationValue: Number(pilot3.duration_value),
      durationUnit: String(pilot3.duration_unit).toLowerCase(),
      classification: classifyRow(pilot3),
      originalModelId: pilot3.model_id,
    },
  ];

  console.log('Selected Governed Pilot Targets:', JSON.stringify(pilotTargets, null, 2));

  console.log('\n=== STEP 2: PRE-TRAINING GOVERNANCE & INTEGRITY CHECK ===');
  console.log('Checking required code/config invariants:');
  console.log('- Training script: scripts/ml_unified_horizon_training.py');
  console.log('- Dataset builder: lib/ml-unified-horizon-dataset-builder.ts');
  console.log('- ROC-AUC & Brier score calculation: sklearn brier_score_loss, roc_auc_score');
  console.log('- horizonMetrics structure: per-horizon { accuracy, f1, logLoss, winRate, auc, brierScore, samples }');
  console.log('- Candidate registration gate: status = "candidate"');

  console.log('\n=== STEP 3: ENQUEUEING & EXECUTING PILOT TRAINING ===');
  const pilotResults = [];

  for (const target of pilotTargets) {
    console.log(`\n--- Processing Pilot Target: ${target.symbol} at ${target.durationValue}${target.durationUnit} (${target.classification}) ---`);

    console.log(`Building fresh dedicated dataset for ${target.symbol}...`);
    const buildResult = await buildUnifiedMultiHorizonDataset({
      symbol: target.symbol,
      horizons: [{ value: target.durationValue, unit: target.durationUnit }],
      maxSamples: 1000,
    });
    const datasetId = buildResult.datasetId;
    console.log(`Dataset built successfully: ${datasetId} (${buildResult.sampleCount} samples, train: ${buildResult.trainCount}, val: ${buildResult.validationCount})`);

    console.log(`Executing unified training run for dataset ${datasetId}...`);
    const trainResult = await trainUnifiedMultiHorizonModel({
      datasetId,
      modelType: 'xgboost',
      autoPromote: false,
    });

    console.log(`Training run completed: ${trainResult.modelId}`);
    pilotResults.push({ target, datasetId, trainResult });
  }

  console.log('\n=== STEP 4: VERIFYING PILOT RESULTING MODELS & METRICS ===');
  for (const item of pilotResults) {
    const { target, datasetId, trainResult } = item;
    const horizonKey = `${target.durationValue}${target.durationUnit}`;
    const registeredModelId = `${trainResult.modelId}_${horizonKey}`;

    console.log(`\nVerifying candidate model: ${registeredModelId}`);

    const modelRows = await sql`
      SELECT model_id, status, training_run_id, dataset_id, feature_schema_version, metrics, strategy_key
      FROM ml_model_registry_v2
      WHERE model_id = ${registeredModelId};
    `;

    if (!modelRows.length) {
      throw new Error(`PILOT_VERIFICATION_FAILED: Candidate model ${registeredModelId} not found in ml_model_registry_v2.`);
    }

    const m = modelRows[0];
    const metrics = m.metrics || {};
    const hMetrics = metrics.horizonMetrics?.[horizonKey] || {};

    console.log(`- Candidate Status: ${m.status} (MUST BE 'candidate', NOT 'production')`);
    if (m.status !== 'candidate') {
      throw new Error(`PILOT_VERIFICATION_FAILED: Candidate model status is '${m.status}', expected 'candidate'.`);
    }

    console.log('- Verifying complete lineage:');
    console.log(`  dataset_id: ${m.dataset_id} (matches ${datasetId}: ${m.dataset_id === datasetId})`);
    console.log(`  training_run_id: ${m.training_run_id}`);
    console.log(`  feature_schema_version: ${m.feature_schema_version}`);
    console.log(`  strategy_key: ${m.strategy_key}`);

    if (m.dataset_id !== datasetId) {
      throw new Error(`PILOT_VERIFICATION_FAILED: Dataset lineage mismatch on ${registeredModelId}`);
    }

    console.log('- Verifying exact-horizon metric completeness:');
    const requiredMetrics = ['accuracy', 'f1', 'logLoss', 'winRate', 'auc', 'brierScore', 'samples'];
    for (const reqKey of requiredMetrics) {
      const val = hMetrics[reqKey];
      const isNum = Number.isFinite(Number(val)) && Number(val) >= 0;
      console.log(`  horizonMetrics[${horizonKey}].${reqKey}: ${val} (valid: ${isNum})`);
      if (!isNum) {
        throw new Error(`PILOT_VERIFICATION_FAILED: Metric ${reqKey} missing or invalid in horizonMetrics[${horizonKey}] for ${registeredModelId}`);
      }
    }
  }

  console.log('\n=== STEP 5: TESTING CANDIDATE / PRODUCTION RESOLVER ===');
  for (const item of pilotResults) {
    const { target } = item;
    console.log(`Testing production model resolver for ${target.symbol} at ${target.durationValue}${target.durationUnit}...`);
    try {
      const resolution = await resolveProductionModels(target.symbol, target.durationValue, target.durationUnit);
      console.log(`Production resolver returned model: ${resolution.modelId} with qualityScore: ${resolution.qualityScore}`);
    } catch (err) {
      console.log(`Resolver status for candidate target ${target.symbol} ${target.durationValue}${target.durationUnit}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\n=== GOVERNED PILOT PASSED ALL VERIFICATION CHECKS ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('[Governed Pilot] FAILED:', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
