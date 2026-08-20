import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const predictRoute = read('app/api/signals/predict/route.ts');
const resolver = read('lib/production-model-resolver.ts');
const horizonEngine = read('lib/horizon-decision-engine.ts');
const ensemble = read('lib/production-ensemble.ts');
const pythonEnsemble = read('scripts/ml_ensemble_runtime.py');

const violations = [];
const assert = (condition, message) => {
  if (!condition) violations.push(message);
};

// 1. Dynamic eligible horizon discovery for Auto/AI mode
assert(resolver.includes('export async function getEligibleProductionHorizons'), 'production-model-resolver must export getEligibleProductionHorizons');
assert(predictRoute.includes('getEligibleProductionHorizons(symbol)'), 'predict route must discover eligible production horizons for symbol');
assert(predictRoute.includes("mode === 'manual'"), 'predict route must distinguish manual vs auto/ai mode');
assert(predictRoute.includes('initialEvaluationHorizon'), 'predict route must resolve initial evaluation horizon from eligible set in auto mode');
assert(predictRoute.includes('sameHorizon(initialEvaluationHorizon, selectedHorizon)'), 'predict route must align initial evaluation with selected horizon');

// 2. Strict exact-horizon invariant for manual mode (No silent substitution)
assert(resolver.includes('NO_VALIDATED_PRODUCTION_MODELS:'), 'resolver must fail closed with NO_VALIDATED_PRODUCTION_MODELS on missing horizon');
assert(!resolver.includes('fallbackToClosestHorizon'), 'resolver must never silently fall back to an unvalidated horizon');

// 3. Cadence-aware live tick freshness
assert(predictRoute.includes('assertFreshLiveTicks'), 'predict route must assert tick freshness');
assert(predictRoute.includes('Math.max(medianInterval * 4, 6000)'), 'predict route must use a bounded cadence-aware freshness tolerance');
assert(predictRoute.includes('latestAge < -2000'), 'predict route must accommodate minor sub-second clock drift');

// 4. Authoritative horizon analysis availability
assert(ensemble.includes('remote.horizons || remote.models?.horizons'), 'production ensemble must accept authoritative horizons from runtime');
assert(pythonEnsemble.includes('horizon_surface = _aggregate_horizon_surface(request, model_types)'), 'native ensemble must compute authoritative horizon surface');
assert(horizonEngine.includes('getLiveCandidateHorizons'), 'horizon engine must resolve live candidate horizons');

if (violations.length > 0) {
  console.error('Horizon discovery and freshness invariant violations:');
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}

console.log('Horizon discovery and freshness invariants passed (all checks verified).');
