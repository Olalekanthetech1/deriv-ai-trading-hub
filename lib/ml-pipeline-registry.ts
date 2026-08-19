import { getFeatureOrder } from './ml-feature-registry';
import type { FeaturePipelineConfig } from './ml-pipeline-config';

/**
 * Canonical ML pipeline topology and bootstrap-only operational values.
 *
 * The feature schema remains owned by ml-feature-registry. This registry owns
 * the initial pipeline template used only when the persistent configuration
 * store has no active version yet. Once an admin configuration is activated,
 * runtime configuration is loaded from the persistent registry.
 */
export const ML_PIPELINE_BOOTSTRAP: Omit<FeaturePipelineConfig, 'featureOrder'> = {
  pipelineVersion: 'ml-pipeline-v1',
  canonicalFeatureWindowTicks: 300,
  defaultHorizonTicks: 5,
  maxHorizonTicks: 5000,
  featureWindows: {
    micro: 5,
    short: 25,
    medium: 100,
    macro: 300,
  },
  regimeThreshold: 0.05,
  digitPrecision: 5,
  syntheticSymbolPrefixes: ['1HZ', 'R_'],
  splitRatios: {
    train: 0.7,
    validation: 0.15,
    test: 0.15,
  },
  splitGapMultiplier: 1,
  normalizationMethod: 'zscore',
  normalizationEpsilon: 1e-12,
};

export function buildBootstrapMlPipelineConfig(): FeaturePipelineConfig {
  return {
    ...ML_PIPELINE_BOOTSTRAP,
    featureWindows: { ...ML_PIPELINE_BOOTSTRAP.featureWindows },
    syntheticSymbolPrefixes: [...ML_PIPELINE_BOOTSTRAP.syntheticSymbolPrefixes],
    splitRatios: { ...ML_PIPELINE_BOOTSTRAP.splitRatios },
    featureOrder: getFeatureOrder(),
  };
}
