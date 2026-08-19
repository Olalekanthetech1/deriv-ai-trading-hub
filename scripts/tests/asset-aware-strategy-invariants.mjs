import fs from 'node:fs';

const strategyPath = 'lib/asset-aware-model-strategy.ts';
const orchestratorPath = 'lib/ml-training-orchestrator.ts';
const ensemblePath = 'lib/production-ensemble.ts';
const resolverPath = 'lib/production-model-resolver.ts';
const pagePath = 'app/admin/asset-strategy/page.tsx';

const strategy = fs.readFileSync(strategyPath, 'utf8');
const orchestrator = fs.readFileSync(orchestratorPath, 'utf8');
const ensemble = fs.readFileSync(ensemblePath, 'utf8');
const resolver = fs.readFileSync(resolverPath, 'utf8');
const page = fs.readFileSync(pagePath, 'utf8');
const violations = [];

const require = (text, pattern, message) => {
  if (!pattern.test(text)) violations.push(message);
};

require(strategy, /ASSET_MODEL_STRATEGY_VERSION/, `${strategyPath} -> strategy version contract missing`);
require(strategy, /assetClass: string/, `${strategyPath} -> asset-class context missing`);
require(strategy, /marketType: string/, `${strategyPath} -> market-type context missing`);
require(strategy, /durationValue: number/, `${strategyPath} -> duration-aware input missing`);
require(strategy, /effectiveHorizonTicks: number/, `${strategyPath} -> effective horizon context missing`);
require(strategy, /sampleCount: number/, `${strategyPath} -> sample-count context missing`);
require(strategy, /function assetFactor\(/, `${strategyPath} -> asset-profile adaptation missing`);
require(strategy, /sequenceLength = clamp\(/, `${strategyPath} -> bounded sequence adaptation missing`);
require(strategy, /minimumSamples/, `${strategyPath} -> training adequacy governance missing`);
require(orchestrator, /resolveAssetAwareModelStrategy\(/, `${orchestratorPath} -> strategy is not resolved during training`);
require(orchestrator, /strategy\.key/, `${orchestratorPath} -> strategy key lineage missing`);
require(orchestrator, /strategy\.version/, `${orchestratorPath} -> strategy version lineage missing`);
require(orchestrator, /strategyMetadata/, `${orchestratorPath} -> strategy metadata lineage missing`);
require(ensemble, /resolveAssetAwareSignalContext\(/, `${ensemblePath} -> asset-aware signal context missing`);
require(ensemble, /evaluateSignalStrategyGate\(/, `${ensemblePath} -> asset-aware strategy gate missing`);
require(ensemble, /resolveProductionModels\(/, `${ensemblePath} -> production registry resolver missing`);
require(ensemble, /resolveAndMaterializeProductionModel\(/, `${ensemblePath} -> durable production artifact resolver missing`);
require(ensemble, /Native Python trained (model|production artifact)/, `${ensemblePath} -> native-runtime provenance missing`);
require(resolver, /FROM ml_model_registry_v2/, `${resolverPath} -> production registry source missing`);
require(resolver, /status = 'production'/, `${resolverPath} -> production lifecycle selection missing`);
require(resolver, /hasModelArtifact\(/, `${resolverPath} -> durable artifact presence check missing`);
require(resolver, /materializeModelArtifact\(/, `${resolverPath} -> durable artifact materialization missing`);
require(page, /strategyContexts/, `${pagePath} -> persisted strategy lineage view missing`);
require(page, /NO SYNTHETIC STATE/, `${pagePath} -> persisted-only evidence boundary missing`);

if (/xgboost-daemon|production-ensemble|onnx-engine/.test(page)) violations.push(`${pagePath} -> server ML runtime leaked into Client UI`);
if (/api\/ml\/cron-retrain|xgboostDaemon|onnx-engine/.test(strategy)) violations.push(`${strategyPath} -> retired legacy ML boundary referenced`);

if (violations.length) throw new Error(`[Asset-Aware Strategy Invariants] violations detected:\n${violations.join('\n')}`);
console.log('[Asset-Aware Strategy Invariants] passed: strategy contract, asset/duration adaptation, training lineage, native runtime provenance, durable production artifacts, and Admin evidence boundaries are intact.');
