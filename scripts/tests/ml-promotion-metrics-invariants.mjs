import fs from 'node:fs';

const training = fs.readFileSync('scripts/ml_duration_training.py', 'utf8');
const governed = fs.readFileSync('scripts/ml_duration_training_governed.py', 'utf8');
const orchestrator = fs.readFileSync('lib/ml-training-orchestrator.ts', 'utf8');
const unifiedTraining = fs.readFileSync('scripts/ml_unified_horizon_training.py', 'utf8');
const unifiedOrchestrator = fs.readFileSync('lib/ml-unified-horizon-orchestrator.ts', 'utf8');
const productionResolver = fs.readFileSync('lib/production-model-resolver.ts', 'utf8');
const backfill = fs.readFileSync('scripts/backfill-unified-horizon-metrics.mjs', 'utf8');

if (!governed.includes('from sklearn.metrics import f1_score')) {
  throw new Error('[ML Promotion Metrics] governed trainer must calculate validation F1.');
}
if (!governed.includes('validation["f1"] = f1')) {
  throw new Error('[ML Promotion Metrics] governed trainer must persist validation F1.');
}
if (!governed.includes('metrics["modelKey"] = kind')) {
  throw new Error('[ML Promotion Metrics] governed trainer must return canonical modelKey.');
}
if (!orchestrator.includes('modelKey: definition.key')) {
  throw new Error('[ML Promotion Metrics] canonical modelKey must be persisted by the orchestrator.');
}
if (!training.includes('validation')) {
  throw new Error('[ML Promotion Metrics] native training validation contract is missing.');
}

if (!unifiedTraining.includes('brier_score_loss') || !unifiedTraining.includes('roc_auc_score')) {
  throw new Error('[ML Promotion Metrics] unified trainer must calculate authoritative Brier and ROC-AUC metrics.');
}
if (!unifiedTraining.includes('UNIFIED_HORIZON_VALIDATION_SINGLE_CLASS')) {
  throw new Error('[ML Promotion Metrics] unified trainer must reject single-class horizon validation cohorts.');
}
if (!unifiedTraining.includes('"auc": auc') || !unifiedTraining.includes('"brierScore": brier')) {
  throw new Error('[ML Promotion Metrics] unified trainer must persist per-horizon AUC and Brier metrics.');
}
if (!unifiedOrchestrator.includes('horizonMetrics,') || !unifiedOrchestrator.includes('UNIFIED_HORIZON_VALIDATION_METRIC_MISSING')) {
  throw new Error('[ML Promotion Metrics] unified orchestrator must persist and require the complete authoritative horizon map.');
}
if (!productionResolver.includes('AUTHORITATIVE_HORIZON_METRICS_UNAVAILABLE')) {
  throw new Error('[ML Promotion Metrics] production resolver must reject missing authoritative horizon metrics.');
}
if (!productionResolver.includes('MODEL_VALIDATION_METRIC_UNAVAILABLE')) {
  throw new Error('[ML Promotion Metrics] production resolver must reject missing validation metrics.');
}
if (!productionResolver.includes('if (rowSec !== reqSec) continue')) {
  throw new Error('[ML Promotion Metrics] production resolver must not use nearest-horizon substitution.');
}
if (/if \(!Number\.isFinite\(auc\)\).*acc/.test(productionResolver) || /if \(!Number\.isFinite\(brier\).*acc/.test(productionResolver)) {
  throw new Error('[ML Promotion Metrics] production resolver must not fabricate AUC or Brier metrics.');
}

if (!backfill.includes("const EXECUTE = process.argv.includes('--execute');")) {
  throw new Error('[ML Promotion Metrics] existing-model backfill must default to dry-run and require --execute.');
}
if (!backfill.includes('ml_unified_horizon_training_runs') || !backfill.includes('horizon_metrics')) {
  throw new Error('[ML Promotion Metrics] existing-model backfill must source evidence from unified training runs.');
}
if (!backfill.includes('TRAINING_RUN_HORIZON_METRICS_UNAVAILABLE')) {
  throw new Error('[ML Promotion Metrics] backfill must block when authoritative training evidence is unavailable.');
}
if (!backfill.includes('authoritativeMetricsSource')) {
  throw new Error('[ML Promotion Metrics] backfill must preserve provenance metadata.');
}

console.log('[ML Promotion Metrics] passed: governed validation, authoritative unified horizon metrics, exact-horizon resolution, non-fabricated quality scoring, and safe existing-model backfill are enforced.');
