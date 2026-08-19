import { DerivDurationUnit, durationToSeconds } from './deriv-duration-registry';
import { FeatureKey, getFeatureOrder } from './ml-feature-registry';
import { deriveFeatureSchemaVersion, getCanonicalWindowTicks, getMlPipelineConfig } from './ml-pipeline-config';

/**
 * Universal horizon descriptor supporting both Tick (e.g. 1T, 5T) and Time (e.g. 15s, 60s).
 */
export type UnifiedHorizon = {
  key: string; // e.g. "1t", "5t", "15s", "60s"
  value: number;
  unit: DerivDurationUnit;
  type: 'tick' | 'time';
  seconds: number | null;
  effectiveHorizonTicks: number | null;
};

/**
 * Default standard multi-horizon suite covering both micro tick microstructure and time horizons.
 */
export const DEFAULT_UNIFIED_HORIZONS: ReadonlyArray<{ value: number; unit: DerivDurationUnit }> = [
  // Tick horizons
  { value: 1, unit: 't' },
  { value: 2, unit: 't' },
  { value: 3, unit: 't' },
  { value: 5, unit: 't' },
  { value: 10, unit: 't' },
  // Time horizons
  { value: 15, unit: 's' },
  { value: 30, unit: 's' },
  { value: 60, unit: 's' },
  { value: 120, unit: 's' },
  { value: 300, unit: 's' },
];

export function buildUnifiedHorizonKey(value: number, unit: DerivDurationUnit): string {
  const normUnit = String(unit).toLowerCase() as DerivDurationUnit;
  return `${Math.trunc(value)}${normUnit}`;
}

export function createUnifiedHorizon(
  value: number,
  unit: DerivDurationUnit,
  effectiveHorizonTicks: number | null = null,
): UnifiedHorizon {
  const normUnit = String(unit).toLowerCase() as DerivDurationUnit;
  if (!['t', 's', 'm', 'h', 'd'].includes(normUnit)) {
    throw new Error(`[Unified Horizon] Unsupported duration unit: ${String(unit)}`);
  }
  const positiveVal = Math.max(1, Math.trunc(value));
  return {
    key: buildUnifiedHorizonKey(positiveVal, normUnit),
    value: positiveVal,
    unit: normUnit,
    type: normUnit === 't' ? 'tick' : 'time',
    seconds: normUnit === 't' ? null : Number(durationToSeconds(positiveVal, normUnit)),
    effectiveHorizonTicks: effectiveHorizonTicks != null ? Math.max(1, Math.trunc(effectiveHorizonTicks)) : null,
  };
}

export type UnifiedMultiHorizonDatasetSummary = {
  datasetId: string;
  name: string;
  symbol: string;
  horizons: UnifiedHorizon[];
  sampleCount: number;
  trainCount: number;
  validationCount: number;
  testCount: number;
  featureCount: number;
  featureOrder: FeatureKey[];
  featureSchemaVersion: string;
  sourceFrom: string;
  sourceTo: string;
  checksum: string;
  leakageCheckPassed: boolean;
  status: 'completed' | 'failed' | 'building';
  createdAt: string;
};

export type HorizonValidationMetric = {
  horizonKey: string;
  horizonType: 'tick' | 'time';
  durationValue: number;
  durationUnit: string;
  samples: number;
  accuracy: number;
  f1: number;
  logLoss: number;
  winRate: number;
  brierScore?: number;
  auc?: number;
};

export type UnifiedModelTrainingResult = {
  success: boolean;
  modelId: string;
  modelType: string;
  symbol: string;
  artifactPath?: string;
  datasetId: string;
  trainingSamples: number;
  validationSamples: number;
  overallAccuracy: number;
  overallLogLoss: number;
  overallF1: number;
  horizonMetrics: Record<string, HorizonValidationMetric>;
  fitMs: number;
  trainedOnceForMultiHorizon: boolean;
  featureSchemaVersion: string;
  engine: string;
};
