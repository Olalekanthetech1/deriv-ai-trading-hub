import fs from 'node:fs';

const sources = [
  ['app/api/signals/predict/route.ts', 'Signal prediction route'],
  ['lib/production-ensemble.ts', 'Production ensemble'],
  ['app/admin/final-verification/page.tsx', 'Admin final verification'],
  ['hooks/use-realtime-signals.ts', 'Realtime signal consumer'],
];

const contents = new Map(sources.map(([path]) => [path, fs.readFileSync(path, 'utf8')]));
const predictionRoute = contents.get('app/api/signals/predict/route.ts');
const ensemble = contents.get('lib/production-ensemble.ts');
const adminVerification = contents.get('app/admin/final-verification/page.tsx');
const realtimeSignals = contents.get('hooks/use-realtime-signals.ts');
const violations = [];

const require = (text, pattern, message) => {
  if (!pattern.test(text)) violations.push(message);
};

require(predictionRoute, /evaluateProductionEnsemble\(/, 'Signal prediction must use the canonical production ensemble');
require(predictionRoute, /strategyGate\.accepted/, 'Signal output must remain gated by the strategy decision boundary');
require(predictionRoute, /correlationId/, 'Signal prediction must expose request correlation for traceability');
require(predictionRoute, /modelVersion/, 'Prediction response must expose model version traceability');
require(predictionRoute, /probabilityUp|probabilityDown/, 'Prediction response must expose model probabilities');
require(predictionRoute, /assetContext/, 'Prediction response must expose asset context');
require(predictionRoute, /isAdminDiagnosticAuthorized/, 'Admin diagnostics must require server-side authorization');
require(predictionRoute, /Cache-Control.*no-store/, 'Prediction responses must not be served from stale caches');
require(predictionRoute, /Native model probability/, 'Prediction data must identify native model probability rather than synthetic win-rate claims');

if (/placeOrder|executeOrder|autoTrade|autotrade/i.test(predictionRoute)) {
  violations.push('Signal prediction route must not own trading execution');
}

require(ensemble, /assetContext/, 'Production ensemble must resolve asset-aware context');
require(ensemble, /strategyGate/, 'Production ensemble must apply a strategy gate');
require(ensemble, /modelBreakdown/, 'Production ensemble must preserve model-level traceability');
require(ensemble, /features/, 'Production ensemble must expose feature lineage for diagnostics');
require(adminVerification, /signals\/predict/, 'Final verification must exercise the canonical production signal path');
require(realtimeSignals, /signals\/predict/, 'Realtime signal consumer must use the canonical prediction path');

const retiredTokens = [['xgboost', 'daemon'].join('-'), ['onnx', 'engine'].join('-'), ['multi-model', 'evaluator'].join('')];
for (const [path, text] of contents.entries()) {
  if (retiredTokens.some((token) => text.toLowerCase().includes(token))) {
    violations.push(`${path} -> retired/server ML runtime dependency leaked into prediction/trading integration boundary`);
  }
}

console.log(violations.length
  ? `[Prediction/Trading Integration Invariants] violations detected:\n${violations.join('\n')}`
  : '[Prediction/Trading Integration Invariants] passed: canonical ensemble, strategy gating, traceability, diagnostic authorization, no-store responses, and execution-boundary separation are enforced.');
if (violations.length) process.exit(1);
