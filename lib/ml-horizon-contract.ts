import { durationToSeconds, type DerivDurationUnit } from './deriv-duration-registry';
import type { FeatureKey } from './ml-feature-registry';
import { deriveFeatureSchemaVersion, getCanonicalWindowTicks, getMlPipelineConfig } from './ml-pipeline-config';

/**
 * Canonical horizon identity used across dataset generation, training, validation,
 * artifact lineage and production eligibility.
 *
 * This contract deliberately describes broker duration semantics rather than
 * technical indicators. Model features remain the canonical tick-property
 * feature vector.
 */
export type MlHorizonDescriptor = {
  value: number;
  unit: DerivDurationUnit;
  type: 'tick' | 'time';
  seconds: number | null;
  /** Resolved from persisted ticks for a concrete dataset. Required for lineage. */
  effectiveHorizonTicks: number | null;
  key: string;
};

export type MlHorizonCohort = {
  horizons: MlHorizonDescriptor[];
  symbol: string;
  featureSchemaVersion: string;
  featureOrder: FeatureKey[];
  featureWindowTicks: number;
  pipelineVersion: string;
};

export type MlHorizonTrainingRow = {
  horizon: MlHorizonDescriptor;
  featureVector: number[];
  label: 'RISE' | 'FALL';
};

function positiveSafeInteger(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`[ML Horizon] ${name} must be a positive safe integer.`);
  return n;
}

function canonicalSymbol(symbol: unknown): string {
  const value = String(symbol ?? '').trim().toUpperCase();
  if (!value) throw new Error('[ML Horizon] symbol must be non-empty.');
  return value;
}

export function buildHorizonKey(value: number, unit: DerivDurationUnit): string {
  return `${positiveSafeInteger(value, 'durationValue')}${unit}`;
}

export function createMlHorizonDescriptor(
  value: number,
  unit: DerivDurationUnit,
  effectiveHorizonTicks: number | null = null,
): MlHorizonDescriptor {
  const durationValue = positiveSafeInteger(value, 'durationValue');
  if (!['t', 's', 'm', 'h', 'd'].includes(unit)) throw new Error(`[ML Horizon] Unsupported duration unit: ${String(unit)}.`);

  const resolvedTicks = effectiveHorizonTicks == null ? null : positiveSafeInteger(effectiveHorizonTicks, 'effectiveHorizonTicks');
  return {
    value: durationValue,
    unit,
    type: unit === 't' ? 'tick' : 'time',
    seconds: unit === 't' ? null : Number(durationToSeconds(durationValue, unit)),
    effectiveHorizonTicks: resolvedTicks,
    key: buildHorizonKey(durationValue, unit),
  };
}

export function assertHorizonDescriptor(value: unknown): asserts value is MlHorizonDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('[ML Horizon] Horizon descriptor must be an object.');
  const horizon = value as Partial<MlHorizonDescriptor>;
  const expected = createMlHorizonDescriptor(Number(horizon.value), horizon.unit as DerivDurationUnit, horizon.effectiveHorizonTicks ?? null);
  if (horizon.key !== expected.key || horizon.type !== expected.type || horizon.seconds !== expected.seconds) {
    throw new Error(`[ML Horizon] Invalid canonical descriptor for ${expected.key}.`);
  }
}

/**
 * A shared artifact may cover multiple horizons only when every horizon uses
 * the same symbol, pipeline version, feature order/schema and observation
 * topology. Duration changes must not silently change the feature vector shape.
 */
export function validateHorizonCohort(cohort: MlHorizonCohort): MlHorizonCohort {
  const symbol = canonicalSymbol(cohort.symbol);
  if (!Array.isArray(cohort.horizons) || cohort.horizons.length === 0) throw new Error('[ML Horizon] A cohort must contain at least one horizon.');

  const config = getMlPipelineConfig();
  const expectedWindow = getCanonicalWindowTicks(config);
  const expectedSchema = deriveFeatureSchemaVersion(config.featureOrder, config.pipelineVersion);
  if (cohort.featureWindowTicks !== expectedWindow) {
    throw new Error(`[ML Horizon] Feature topology mismatch: expected ${expectedWindow} ticks, received ${cohort.featureWindowTicks}.`);
  }
  if (cohort.pipelineVersion !== config.pipelineVersion) {
    throw new Error(`[ML Horizon] Pipeline version mismatch: expected ${config.pipelineVersion}, received ${cohort.pipelineVersion}.`);
  }
  if (cohort.featureSchemaVersion !== expectedSchema) {
    throw new Error(`[ML Horizon] Feature schema mismatch: expected ${expectedSchema}, received ${cohort.featureSchemaVersion}.`);
  }
  if (JSON.stringify(cohort.featureOrder) !== JSON.stringify(config.featureOrder)) {
    throw new Error('[ML Horizon] Feature order mismatch with the active canonical tick-property feature contract.');
  }

  const keys = new Set<string>();
  for (const horizon of cohort.horizons) {
    assertHorizonDescriptor(horizon);
    if (horizon.effectiveHorizonTicks == null) {
      throw new Error(`[ML Horizon] ${horizon.key} is missing resolved effectiveHorizonTicks.`);
    }
    if (keys.has(horizon.key)) throw new Error(`[ML Horizon] Duplicate horizon in cohort: ${horizon.key}.`);
    keys.add(horizon.key);
  }
  return { ...cohort, symbol, horizons: [...cohort.horizons] };
}

export function buildMlHorizonCohort(symbol: string, horizons: MlHorizonDescriptor[]): MlHorizonCohort {
  const config = getMlPipelineConfig();
  return validateHorizonCohort({
    symbol: canonicalSymbol(symbol),
    horizons,
    featureSchemaVersion: deriveFeatureSchemaVersion(config.featureOrder, config.pipelineVersion),
    featureOrder: [...config.featureOrder],
    featureWindowTicks: getCanonicalWindowTicks(config),
    pipelineVersion: config.pipelineVersion,
  });
}

export function validateHorizonTrainingRow(row: MlHorizonTrainingRow, featureCount: number): void {
  assertHorizonDescriptor(row.horizon);
  if (!Array.isArray(row.featureVector) || row.featureVector.length !== featureCount) {
    throw new Error(`[ML Horizon] Feature vector for ${row.horizon.key} must contain exactly ${featureCount} values.`);
  }
  if (row.featureVector.some(value => !Number.isFinite(value))) throw new Error(`[ML Horizon] Non-finite feature value for ${row.horizon.key}.`);
  if (row.label !== 'RISE' && row.label !== 'FALL') throw new Error(`[ML Horizon] Invalid label for ${row.horizon.key}.`);
}
