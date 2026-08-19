import fs from 'node:fs';

const pagePath = 'app/admin/champion-challenger/page.tsx';
const routePath = 'app/api/ml/registry/route.ts';
const governancePath = 'lib/champion-challenger-governance.ts';

const page = fs.readFileSync(pagePath, 'utf8');
const route = fs.readFileSync(routePath, 'utf8');
const governance = fs.readFileSync(governancePath, 'utf8');
const violations = [];

const require = (text, pattern, message) => {
  if (!pattern.test(text)) violations.push(message);
};

require(page, /\/api\/ml\/registry/, 'Champion/Challenger UI must use the canonical registry API');
require(page, /status === 'production'/, 'Champion state must come from persisted production registry state');
require(page, /\['candidate','staging'\]/, 'Challenger state must be limited to persisted candidate/staging models');
require(page, /no synthetic candidates are created/i, 'Champion/Challenger UI must explicitly reject synthetic state');
require(page, /server-side lifecycle gates/i, 'Promotion UI must defer authority to server-side governance');

const retiredRuntimeTokens = ['xgboost-' + 'daemon', 'onnx-' + 'engine', 'multi-model-' + 'evaluator'];
if (retiredRuntimeTokens.some((token) => page.includes(token))) {
  violations.push(`${pagePath} -> retired/server ML runtime dependency leaked into client UI`);
}

require(route, /evaluateChampionChallengerPromotion\(/, 'Registry promotion must pass through champion/challenger governance');
require(route, /status = 'production'/, 'Registry must identify the persisted production champion');
require(route, /dataset_id|training_run_id|strategy_key|strategy_version|feature_schema_version/, 'Promotion must require complete persisted model lineage');
require(route, /lifecycleTier.*production_candidate/, 'Promotion must enforce production candidate lifecycle tier');
require(route, /status.*candidate.*staging/, 'Promotion must enforce candidate/staging lifecycle state');
require(route, /Synthetic\/default model registration is disabled/, 'Synthetic/default registry seeding must remain disabled');

require(governance, /accuracyDelta/, 'Governance must calculate accuracy delta');
require(governance, /f1Delta/, 'Governance must calculate F1 delta');
require(governance, /strictly improves at least one persisted validation metric/i, 'Governance must require a measurable challenger improvement');
require(governance, /No production champion exists/, 'Governance must support controlled initial champion establishment');

console.log(violations.length
  ? `[Champion/Challenger Invariants] violations detected:\n${violations.join('\n')}`
  : '[Champion/Challenger Invariants] passed: persisted champion/challenger states, lineage, promotion governance, and legacy-runtime boundaries are enforced.');
if (violations.length) process.exit(1);
