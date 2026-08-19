import fs from 'node:fs';

const sources = [
  ['app/api/ml/predict/route.ts', 'ML prediction route'],
  ['app/api/signals/predict/route.ts', 'Signal prediction route'],
  ['app/api/trades/log/route.ts', 'Trade telemetry route'],
  ['components/custom/ai-trader-controls.tsx', 'AI Trader UI'],
  ['components/custom/pro-mode-controls.tsx', 'Pro AI UI'],
  ['hooks/use-rise-fall-trading.ts', 'Trade execution hook'],
  ['lib/execution-plan-telemetry.ts', 'Execution plan telemetry schema'],
  ['lib/production-ensemble.ts', 'Production ensemble'],
  ['lib/production-model-resolver.ts', 'Production model resolver'],
  ['lib/ml-model-artifact-store.ts', 'Durable model artifact store'],
  ['scripts/ml_ensemble_runtime.py', 'Native production ensemble runtime'],
  ['app/admin/final-verification/page.tsx', 'Admin final verification'],
  ['hooks/use-realtime-signals.ts', 'Realtime signal consumer'],
];

const contents = new Map(sources.map(([path]) => [path, fs.readFileSync(path, 'utf8')]));
const mlPredictionRoute = contents.get('app/api/ml/predict/route.ts');
const predictionRoute = contents.get('app/api/signals/predict/route.ts');
const tradeLogRoute = contents.get('app/api/trades/log/route.ts');
const aiTrader = contents.get('components/custom/ai-trader-controls.tsx');
const proMode = contents.get('components/custom/pro-mode-controls.tsx');
const tradingHook = contents.get('hooks/use-rise-fall-trading.ts');
const telemetrySchema = contents.get('lib/execution-plan-telemetry.ts');
const ensemble = contents.get('lib/production-ensemble.ts');
const resolver = contents.get('lib/production-model-resolver.ts');
const artifactStore = contents.get('lib/ml-model-artifact-store.ts');
const nativeEnsemble = contents.get('scripts/ml_ensemble_runtime.py');
const adminVerification = contents.get('app/admin/final-verification/page.tsx');
const realtimeSignals = contents.get('hooks/use-realtime-signals.ts');
const violations = [];

const require = (text, pattern, message) => {
  if (!pattern.test(text)) violations.push(message);
};

for (const [path, text] of [['app/api/ml/predict/route.ts', mlPredictionRoute], ['app/api/signals/predict/route.ts', predictionRoute]]) {
  require(text, /evaluateProductionEnsemble\(/, `${path} must use the canonical production ensemble`);
  require(text, /Cache-Control.*no-store/, `${path} must disable stale prediction caching`);
}

require(predictionRoute, /strategyGate\.accepted/, 'Signal output must remain gated by the strategy decision boundary');
require(predictionRoute, /correlationId/, 'Signal prediction must expose request correlation for traceability');
require(predictionRoute, /modelVersion/, 'Prediction response must expose model version traceability');
require(predictionRoute, /probabilityUp|probabilityDown/, 'Prediction response must expose model probabilities');
require(predictionRoute, /assetContext/, 'Prediction response must expose asset context');
require(predictionRoute, /isAdminDiagnosticAuthorized/, 'Admin diagnostics must require server-side authorization');
require(predictionRoute, /Native model probability/, 'Prediction data must identify native model probability rather than synthetic win-rate claims');
require(predictionRoute, /executionPlan/, 'Signal prediction must return a canonical execution plan');
require(predictionRoute, /executionPlanId/, 'Execution plan must expose a stable execution plan identifier');
require(predictionRoute, /requestedHorizon/, 'Execution plan must preserve the requested optimizer horizon');
require(predictionRoute, /selectedHorizon/, 'Execution plan must expose the selected horizon');
require(predictionRoute, /predictionHorizon/, 'Execution plan must expose the model prediction horizon');
require(predictionRoute, /horizonAligned/, 'Execution plan must enforce model/execution horizon alignment');
require(predictionRoute, /STRATEGY_GATE_BLOCKED_SELECTED_HORIZON/, 'Selected-horizon inference must fail closed when its strategy gate rejects');
require(predictionRoute, /HORIZON_ALIGNMENT_FAILED/, 'Horizon lineage mismatches must fail closed');

if (/placeOrder|executeOrder|autoTrade|autotrade/i.test(predictionRoute)) violations.push('Signal prediction route must not own trading execution');

require(aiTrader, /\/api\/signals\/predict/, 'AI Trader must consume the canonical signal prediction API');
require(aiTrader, /executionPlan/, 'AI Trader must consume the canonical execution plan');
require(aiTrader, /executionPlanId/, 'AI Trader must preserve the execution plan identifier');
require(aiTrader, /horizonAligned/, 'AI Trader must block execution on horizon lineage mismatch');
require(aiTrader, /strategyGateAccepted/, 'AI Trader must honor the selected-horizon strategy gate');
require(aiTrader, /executionPlanId: executionPlan\.executionPlanId/, 'AI Trader must pass the canonical plan ID into trade execution');
if (/models_cache|model_path\(|load_duration|predict_ensemble.*fallback/i.test(aiTrader)) violations.push('AI Trader must not resolve or load ML artifacts directly');

require(proMode, /executionPlanId/, 'Pro AI controls must preserve the execution plan identifier');
require(proMode, /executeBatchTrade\(aiDirection, \{[\s\S]*executionPlanId:/, 'Pro AI execution must pass the canonical plan ID into batch execution');

require(tradingHook, /executionPlanId\?: string/, 'Trade execution hook must accept an execution plan identifier');
require(tradingHook, /execution_plan_id:/, 'Trade execution hook must send the execution plan identifier to trade telemetry');
require(tradeLogRoute, /execution_plan_id/, 'Trade telemetry route must accept the execution plan identifier');
require(tradeLogRoute, /executionPlanTelemetrySchemaReady|ensureExecutionPlanTelemetrySchema/, 'Trade telemetry route must ensure the lineage schema exists before insertion');
require(tradeLogRoute, /execution_plan_id\)?,? executed_at|execution_plan_id, executed_at/, 'Trade telemetry insert must persist execution_plan_id as a first-class column');
require(telemetrySchema, /ADD COLUMN IF NOT EXISTS execution_plan_id UUID/, 'Execution telemetry schema must add the lineage column idempotently');
require(telemetrySchema, /idx_execution_trades_execution_plan_id/, 'Execution telemetry schema must index execution plan lineage lookups');
require(telemetrySchema, /normalizeExecutionPlanId/, 'Execution plan IDs must be normalized before persistence');

require(ensemble, /resolveProductionModels\(/, 'Production ensemble must delegate production model selection to the canonical resolver');
require(ensemble, /resolveAndMaterializeProductionModel\(/, 'Production ensemble must delegate durable artifact materialization to the canonical resolver');
require(ensemble, /NO_VALIDATED_TRAINED_MODELS_AVAILABLE/, 'Production ensemble must fail closed when no validated production model is executable');

require(resolver, /status = [^\n]*production/, 'Production resolver must select only persisted production models');
require(resolver, /resolveAndMaterializeProductionModel/, 'Production resolver must expose governed artifact materialization');
require(resolver, /hasModelArtifact/, 'Production resolver must verify durable model artifacts');
require(artifactStore, /sha256/, 'Durable artifact store must checksum model artifacts');
require(artifactStore, /BYTEA/, 'Durable artifact store must persist artifact bytes durably');
require(nativeEnsemble, /productionModels/, 'Native ensemble must receive registry-selected production models');
require(nativeEnsemble, /artifactPath/, 'Native ensemble must load the materialized governed artifact');
require(nativeEnsemble, /PROMOTED_MODEL_ARTIFACT_CHECKSUM_MISMATCH/, 'Native ensemble must reject corrupted promoted artifacts');
if (/load_duration|runtime\.predict_one\(\{\*\*request/i.test(nativeEnsemble)) violations.push('Native production ensemble must not fall back to legacy runtime model resolution');

require(adminVerification, /signals\/predict/, 'Final verification must exercise the canonical production signal path');
require(realtimeSignals, /signals\/predict/, 'Realtime signal consumer must use the canonical prediction path');

const retiredTokens = [['xgboost', 'daemon'].join('-'), ['onnx', 'engine'].join('-'), ['multi-model', 'evaluator'].join('')];
for (const [path, text] of contents.entries()) {
  if (retiredTokens.some((token) => text.toLowerCase().includes(token))) violations.push(`${path} -> retired/server ML runtime dependency leaked into prediction/trading integration boundary`);
}

console.log(violations.length
  ? `[Prediction/Trading Integration Invariants] violations detected:\n${violations.join('\n')}`
  : '[Prediction/Trading Integration Invariants] passed: unified production registry, durable artifacts, governed native inference, strategy gating, canonical execution-plan lineage, and direct AI trade telemetry linkage are enforced.');
if (violations.length) process.exit(1);
