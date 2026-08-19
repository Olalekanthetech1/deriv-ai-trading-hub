import crypto from 'crypto';
import {
  getFeatureDefinitions,
  getFeatureOrder,
  getFeatureCount,
  type FeatureKey,
} from './ml-feature-registry';
import { initializeMlPipelineConfig, type FeaturePipelineConfig } from './ml-pipeline-config';
import { withDurationFeatureWindows, type DurationFeatureUnit } from './ml-duration-feature-policy';

export type MlRuntimeSchemaDurationContext = {
  durationValue: number;
  durationUnit: DurationFeatureUnit;
};

export type MlRuntimeSchemaContract = {
  contractVersion: string;
  pipelineVersion: string;
  featureSchemaVersion: string;
  schemaFingerprint: string;
  featureCount: number;
  featureOrder: FeatureKey[];
  featureDefinitions: Array<{ key: FeatureKey; pillar: string }>;
  featureWindows: FeaturePipelineConfig['featureWindows'];
  canonicalFeatureWindowTicks: number;
  sequenceLength: number;
  defaultHorizonTicks: number;
  regimeThreshold: number;
  digitPrecision: number;
  syntheticSymbolPrefixes: string[];
  splitRatios: FeaturePipelineConfig['splitRatios'];
  normalizationMethod: FeaturePipelineConfig['normalizationMethod'];
  normalizationEpsilon: number;
  durationContext?: MlRuntimeSchemaDurationContext;
};

export function buildMlRuntimeSchemaContract(
  config: FeaturePipelineConfig,
  durationContext?: MlRuntimeSchemaDurationContext,
): MlRuntimeSchemaContract {
  const effectiveConfig = durationContext
    ? withDurationFeatureWindows(config, durationContext.durationValue, durationContext.durationUnit)
    : config;
  const featureOrder = getFeatureOrder();
  const featureDefinitions = getFeatureDefinitions().map(({ key, pillar }) => ({ key, pillar }));
  const featureCount = getFeatureCount();
  const sequenceLength = effectiveConfig.featureWindows.short;

  if (featureOrder.length !== featureCount) throw new Error('[ML Schema] Registry feature count/order mismatch.');
  if (sequenceLength <= 0) throw new Error('[ML Schema] Sequence length must be positive.');

  const fingerprintPayload = {
    pipelineVersion: effectiveConfig.pipelineVersion,
    featureOrder,
    featureDefinitions,
    featureWindows: effectiveConfig.featureWindows,
    canonicalFeatureWindowTicks: effectiveConfig.canonicalFeatureWindowTicks,
    sequenceLength,
    defaultHorizonTicks: effectiveConfig.defaultHorizonTicks,
    regimeThreshold: effectiveConfig.regimeThreshold,
    digitPrecision: effectiveConfig.digitPrecision,
    syntheticSymbolPrefixes: effectiveConfig.syntheticSymbolPrefixes,
    splitRatios: effectiveConfig.splitRatios,
    normalizationMethod: effectiveConfig.normalizationMethod,
    normalizationEpsilon: effectiveConfig.normalizationEpsilon,
    durationContext: durationContext ?? null,
  };
  const schemaFingerprint = crypto.createHash('sha256').update(JSON.stringify(fingerprintPayload)).digest('hex');

  return {
    contractVersion: 'runtime-schema-contract-v2',
    pipelineVersion: effectiveConfig.pipelineVersion,
    featureSchemaVersion: `feature-schema-${featureCount}-${schemaFingerprint.slice(0, 12)}`,
    schemaFingerprint,
    featureCount,
    featureOrder: [...featureOrder],
    featureDefinitions,
    featureWindows: { ...effectiveConfig.featureWindows },
    canonicalFeatureWindowTicks: effectiveConfig.canonicalFeatureWindowTicks,
    sequenceLength,
    defaultHorizonTicks: effectiveConfig.defaultHorizonTicks,
    regimeThreshold: effectiveConfig.regimeThreshold,
    digitPrecision: effectiveConfig.digitPrecision,
    syntheticSymbolPrefixes: [...effectiveConfig.syntheticSymbolPrefixes],
    splitRatios: [...['train', 'validation', 'test']].reduce((result, key) => {
      result[key as keyof FeaturePipelineConfig['splitRatios']] = effectiveConfig.splitRatios[key as keyof FeaturePipelineConfig['splitRatios']];
      return result;
    }, {} as FeaturePipelineConfig['splitRatios']),
    normalizationMethod: effectiveConfig.normalizationMethod,
    normalizationEpsilon: effectiveConfig.normalizationEpsilon,
    durationContext,
  };
}

export async function getMlRuntimeSchemaContract(
  durationContext?: MlRuntimeSchemaDurationContext,
): Promise<MlRuntimeSchemaContract> {
  const runtime = await initializeMlPipelineConfig();
  return buildMlRuntimeSchemaContract(runtime.config, durationContext);
}
