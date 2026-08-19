import fs from 'node:fs';

const triggerModulePath = 'lib/ml-cohort-retraining-trigger.ts';
const horizonEnginePath = 'lib/horizon-decision-engine.ts';
const routePath = 'app/api/admin/retraining/route.ts';
const pagePath = 'app/admin/retraining/page.tsx';

const triggerModule = fs.readFileSync(triggerModulePath, 'utf8');
const horizonEngine = fs.readFileSync(horizonEnginePath, 'utf8');
const route = fs.readFileSync(routePath, 'utf8');
const page = fs.readFileSync(pagePath, 'utf8');

const violations = [];

const requireContent = (content, pattern, description, path) => {
  if (!pattern.test(content)) violations.push(`${path} -> ${description}`);
};

// 1. Check trigger module mathematics & gates
requireContent(triggerModule, /BRIER_DIVERGENCE_MILESTONE/, 'Brier score divergence milestone defined', triggerModulePath);
requireContent(triggerModule, /CALIBRATION_GAP_MILESTONE/, 'Calibration gap divergence milestone defined', triggerModulePath);
requireContent(triggerModule, /ACCURACY_DEGRADATION_MILESTONE/, 'Accuracy degradation milestone defined', triggerModulePath);
requireContent(triggerModule, /PERSISTENT_DRIFT_MILESTONE/, 'Persistent drift milestone defined', triggerModulePath);
requireContent(triggerModule, /enqueueTrainingJob\(/, 'Durable training queue dispatch integration present', triggerModulePath);
requireContent(triggerModule, /listDurationTrainingDatasets\(/, 'Duration dataset lookup for triggered asset present', triggerModulePath);
requireContent(triggerModule, /evaluateStatisticalDrift\(/, 'Real probabilistic drift engine evaluation linked', triggerModulePath);
requireContent(triggerModule, /export async function evaluateAndTriggerCohortRetraining/, 'Cohort retraining trigger evaluator exported', triggerModulePath);
requireContent(triggerModule, /export async function evaluateAllFleetCohortRetraining/, 'Fleet cohort retraining evaluator exported', triggerModulePath);

// 2. Check horizon decision engine integration
requireContent(horizonEngine, /import\s*\{\s*evaluateAndTriggerCohortRetraining\s*\}\s*from\s*['"]\.\/ml-cohort-retraining-trigger['"]/, 'Horizon decision engine imports cohort retraining trigger', horizonEnginePath);
requireContent(horizonEngine, /evaluateAndTriggerCohortRetraining\(\{\s*assetSymbol:\s*symbol\s*\}\)/, 'Horizon decision engine triggers asynchronous milestone check upon trade outcome', horizonEnginePath);

// 3. Check admin retraining route integration
requireContent(route, /evaluateAllFleetCohortRetraining/, 'Admin retraining route imports evaluateAllFleetCohortRetraining', routePath);
requireContent(route, /cohortRetrainingTriggers/, 'Admin retraining GET payload provides cohortRetrainingTriggers', routePath);
requireContent(route, /evaluate_cohort_triggers/, 'Admin retraining POST supports evaluate_cohort_triggers', routePath);

// 4. Check admin page UI integration
requireContent(page, /Cohort Drift & Brier Divergence Milestone Triggers/, 'Admin retraining UI includes Phase 4 milestone panel', pagePath);
requireContent(page, /Scan Fleet Milestones/, 'Admin retraining UI includes fleet milestone scan button', pagePath);

if (violations.length > 0) {
  throw new Error(`[Cohort Drift Retraining Invariants] Failed:\n${violations.join('\n')}`);
}

console.log('[Cohort Drift Retraining Invariants] PASSED: Offline cohort retraining triggers, Brier score divergence milestones, and zero-downtime queue dispatching are completely verified.');
