import fs from 'node:fs';

const strategyPath = 'lib/asset-aware-model-strategy.ts';
const orchestratorPath = 'lib/ml-training-orchestrator.ts';
const pagePath = 'app/admin/asset-strategy/page.tsx';
const ensemblePath = 'lib/production-ensemble.ts';

const strategy = fs.readFileSync(strategyPath, 'utf8');
const orchestrator = fs.readFileSync(orchestratorPath, 'utf8');
const page = fs.readFileSync(pagePath, 'utf8');
const ensemble = fs.readFileSync(ensemblePath, 'utf8');
const violations = [];

const require = (content, pattern, file, description) => {
  if (!pattern.test(content)) violations.push(`${file} -> ${description}`);
};

require(strategy, /ASSET_MODEL_STRATEGY_VERSION/, strategyPath, 'strategy version contract missing');
require(strategy, /assetClass: string/, strategyPath, 'asset class context missing');
require(strategy, /marketType: string/, strategyPath, 'market type context missing');
require(strategy, /durationValue: number/, strategyPath, 'duration context missing');
require(strategy, /effectiveHorizonTicks: number/, strategyPath, 'effective horizon contract missing');
require(strategy, /sampleCount: number/, strategyPath, 'sample-count governance missing');
require(strategy, /sequenceLength/, strategyPath, 'sequence-length adaptation missing');
require(strategy, /minimumSamples/, strategyPath, 'minimum sample governance missing');
require(strategy, /rationale/, strategyPath, 'strategy rationale lineage missing');

require(orchestrator, /resolveAssetAwareModelStrategy\(/, orchestratorPath, 'training orchestrator does not resolve the canonical asset-aware strategy');
require(orchestrator, /strategyMetadata/, orchestratorPath, 'strategy metadata is not persisted with training lineage');
require(orchestrator, /strategyKey|strategy\.key/, orchestratorPath, 'strategy key is not persisted');
require(orchestrator, /strategyVersion|strategy\.version/, orchestratorPath, 'strategy version is not persisted');
require(orchestrator, /assetAwareStrategy/, orchestratorPath, 'native runtime does not receive asset-aware strategy context');

require(ensemble, /resolveAssetAwareSignalContext\(/, ensemblePath, 'production prediction path does not resolve asset-aware context');
require(ensemble, /evaluateSignalStrategyGate\(/, ensemblePath, 'asset-aware strategy gate is not enforced on prediction');

if (page.includes('/api/ml/')) violations.push(`${pagePath} -> legacy/non-admin ML API usage detected in Admin Asset Strategy page`);
if (!page.includes('/api/admin/')) violations.push(`${pagePath} -> canonical Admin API boundary missing`);
if (page.includes('Math.random')) violations.push(`${pagePath} -> synthetic runtime strategy state detected`);

if (violations.length) {
  throw new Error(`[Asset Strategy Invariants] violations detected:\n${violations.join('\n')}`);
}

console.log('[Asset Strategy Invariants] passed: asset metadata, duration lineage, strategy persistence, native runtime propagation, prediction gating and Admin boundary are intact.');
