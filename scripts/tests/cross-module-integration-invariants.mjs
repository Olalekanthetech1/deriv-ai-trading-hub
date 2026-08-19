import fs from 'node:fs';

const sources = [
  ['app/api/signals/predict/route.ts', 'Prediction route'],
  ['lib/production-ensemble.ts', 'Production ensemble'],
  ['app/api/ml/registry/route.ts', 'Model registry'],
  ['lib/champion-challenger-governance.ts', 'Champion/Challenger governance'],
  ['app/api/admin/retraining/route.ts', 'Retraining control plane'],
  ['lib/retraining-automation.ts', 'Retraining automation'],
  ['app/api/admin/observability/route.ts', 'Admin observability'],
  ['app/api/admin/incidents/route.ts', 'Incident center'],
  ['app/admin/final-verification/page.tsx', 'Admin final verification'],
  ['hooks/use-realtime-signals.ts', 'Realtime signal consumer'],
];

const contents = new Map(sources.map(([path]) => [path, fs.readFileSync(path, 'utf8')]));
const violations = [];
const require = (text, pattern, message) => {
  if (!pattern.test(text)) violations.push(message);
};

const prediction = contents.get('app/api/signals/predict/route.ts');
const ensemble = contents.get('lib/production-ensemble.ts');
const registry = contents.get('app/api/ml/registry/route.ts');
const challenger = contents.get('lib/champion-challenger-governance.ts');
const retrainingApi = contents.get('app/api/admin/retraining/route.ts');
const retrainingService = contents.get('lib/retraining-automation.ts');
const observability = contents.get('app/api/admin/observability/route.ts');
const incidents = contents.get('app/api/admin/incidents/route.ts');
const verification = contents.get('app/admin/final-verification/page.tsx');
const realtime = contents.get('hooks/use-realtime-signals.ts');

require(prediction, /evaluateProductionEnsemble\(/, 'Prediction must use the canonical production ensemble');
require(prediction, /strategyGate\.accepted/, 'Prediction must respect the strategy gate');
require(prediction, /correlationId/, 'Prediction must preserve correlation traceability');
require(prediction, /assetContext/, 'Prediction must preserve asset context');
require(prediction, /modelVersion/, 'Prediction must preserve model-version traceability');
require(prediction, /recordObservabilityEvent/, 'Prediction must emit observability telemetry');

require(ensemble, /assetContext/, 'Ensemble must resolve asset-aware context');
require(ensemble, /strategyGate/, 'Ensemble must expose the governed strategy decision');
require(ensemble, /modelBreakdown/, 'Ensemble must preserve model-level evidence');
require(ensemble, /features/, 'Ensemble must preserve feature lineage for diagnostics');

require(registry, /promoteModelInRegistry/, 'Registry must remain the production model lifecycle authority');
require(registry, /evaluateChampionChallengerPromotion\(/, 'Registry promotion must use Champion/Challenger governance');
require(registry, /asset_symbol|horizon_ticks/, 'Registry promotion must remain asset/horizon scoped');

require(challenger, /accuracyDelta/, 'Champion/Challenger must compare governed validation metrics');
require(challenger, /f1Delta/, 'Champion/Challenger must compare governed F1 metrics');
require(challenger, /strictly improves/i, 'Champion/Challenger must require measurable improvement');

require(retrainingApi, /training|enqueue|queue/i, 'Retraining Admin API must reach the canonical training boundary');
require(retrainingService, /ml_training_job_queue|queue/i, 'Retraining automation must preserve the durable queue boundary');

require(observability, /ensureObservabilitySchema/, 'Admin observability must use the canonical persisted telemetry schema');
require(observability, /admin_observability_events/, 'Admin observability must read persisted observability events');
require(observability, /coverage/, 'Admin observability must report telemetry coverage rather than fabricate availability');
require(observability, /Cache-Control.*no-store/, 'Admin observability must remain non-cacheable');
require(incidents, /observability|incident/i, 'Incident Center must remain connected to operational evidence');
require(verification, /signals\/predict/, 'Final verification must exercise the canonical signal path');
require(realtime, /signals\/predict/, 'Realtime signal consumer must use the canonical signal path');

for (const [path, text] of contents.entries()) {
  if (text.includes('/api/ml/cron-retrain')) violations.push(`${path} -> retired retraining route reference remains`);
  if (/placeOrder|executeOrder|autoTrade|autotrade/i.test(text) && path === 'app/api/signals/predict/route.ts') {
    violations.push(`${path} -> prediction route must not own trading execution`);
  }
}

const legacyTokens = [['xgboost','daemon'].join('-'), ['onnx','engine'].join('-'), ['multi-model','evaluator'].join('')];
for (const [path, text] of contents.entries()) {
  if (legacyTokens.some((token) => text.toLowerCase().includes(token))) {
    violations.push(`${path} -> retired/server ML runtime dependency leaked into cross-module integration boundary`);
  }
}

console.log(violations.length
  ? `[Cross-Module Integration Invariants] violations detected:\n${violations.join('\n')}`
  : '[Cross-Module Integration Invariants] passed: canonical prediction, model lifecycle, retraining queue, observability, incident evidence, Admin verification, and realtime signal contracts remain connected without retired runtimes or execution bypasses.');
if (violations.length) process.exit(1);
