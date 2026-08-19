import type { MlModelDefinition, MlModelKey } from './ml-model-registry';

export const ASSET_MODEL_STRATEGY_VERSION = '1.0.0';

export type AssetAwareStrategyContext = {
  assetClass: string;
  marketType: string;
  durationValue: number;
  durationUnit: 't' | 's' | 'm' | 'h' | 'd';
  durationSeconds: number | null;
  effectiveHorizonTicks: number;
  sampleCount: number;
};

export type AssetAwareModelStrategy = {
  key: string;
  version: string;
  assetClass: string;
  marketType: string;
  horizon: { value: number; unit: AssetAwareStrategyContext['durationUnit']; seconds: number | null; effectiveTicks: number };
  sequenceLength: number;
  minimumSamples: Partial<Record<MlModelKey, number>>;
  hyperparameters: Partial<Record<MlModelKey, Readonly<Record<string, number>>>>;
  rationale: string[];
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

function normalize(value: string): string {
  return String(value || 'unknown').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'unknown';
}

function assetFactor(assetClass: string, marketType: string): number {
  const text = `${assetClass} ${marketType}`.toLowerCase();
  if (/synthetic|volatility/.test(text)) return 0.75;
  if (/commodity|commodities|metals|energy/.test(text)) return 1.25;
  if (/index|indices/.test(text)) return 1.15;
  if (/stock|equity/.test(text)) return 1.2;
  if (/crypto/.test(text)) return 1.0;
  if (/forex|fx/.test(text)) return 1.0;
  return 1.0;
}

export function resolveAssetAwareModelStrategy(context: AssetAwareStrategyContext, definitions: readonly MlModelDefinition[]): AssetAwareModelStrategy {
  const assetClass = normalize(context.assetClass);
  const marketType = normalize(context.marketType);
  const factor = assetFactor(assetClass, marketType);
  const horizonBase = Math.sqrt(Math.max(2, context.effectiveHorizonTicks)) * 4 * factor;
  const sequenceLength = clamp(horizonBase, 32, 128);
  const sampleCount = Math.max(0, context.sampleCount);
  const treeEstimators = sampleCount >= 10_000 ? 200 : 100;
  const neuralEpochs = sampleCount >= 20_000 ? 12 : 8;
  const neuralBatchSize = sequenceLength >= 96 ? 32 : 64;
  const hmmComponents = clamp(2 + Math.log10(Math.max(100, sampleCount)), 3, 6);

  const hyperparameters: Partial<Record<MlModelKey, Readonly<Record<string, number>>>> = {};
  for (const definition of definitions) {
    const base = { ...definition.defaultHyperparameters } as Record<string, number>;
    if (definition.family === 'tabular') {
      base.numEstimators = Math.max(base.numEstimators ?? 100, treeEstimators);
      base.nJobs = Math.min(base.nJobs ?? 2, 2);
    } else if (definition.family === 'sequential') {
      base.epochs = neuralEpochs;
      base.batchSize = neuralBatchSize;
      base.sequenceLength = sequenceLength;
    } else if (definition.family === 'regime') {
      base.components = hmmComponents;
      base.iterations = Math.max(base.iterations ?? 100, 100);
    } else if (definition.family === 'anomaly') {
      base.numEstimators = Math.max(base.numEstimators ?? 200, sampleCount >= 10_000 ? 300 : 200);
      base.nJobs = Math.min(base.nJobs ?? 2, 2);
    }
    hyperparameters[definition.key] = base;
  }

  const minimumBase = Math.max(512, sequenceLength * 16);
  const minimumSamples: Partial<Record<MlModelKey, number>> = {};
  for (const definition of definitions) {
    minimumSamples[definition.key] = definition.family === 'sequential' ? Math.max(1_024, minimumBase) : Math.max(256, Math.round(minimumBase / 2));
  }

  return {
    key: `${assetClass}:${marketType}`,
    version: ASSET_MODEL_STRATEGY_VERSION,
    assetClass,
    marketType,
    horizon: { value: context.durationValue, unit: context.durationUnit, seconds: context.durationSeconds, effectiveTicks: context.effectiveHorizonTicks },
    sequenceLength,
    minimumSamples,
    hyperparameters,
    rationale: [
      'Asset profile is derived from broker/database asset metadata, not a hard-coded symbol list.',
      'Training horizon is inherited from the broker-discovered contract duration.',
      'Sequence context scales with the effective tick horizon and asset profile, then is bounded for predictable resource usage.',
      'All registered model families remain eligible; adequacy thresholds are recorded for training governance rather than silently substituting models.',
    ],
  };
}
