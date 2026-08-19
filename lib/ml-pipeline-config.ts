import crypto from 'crypto';
import { assertFeatureOrder, getFeatureDefinitions, getFeatureOrder, type FeatureKey } from './ml-feature-registry';
import { buildBootstrapMlPipelineConfig } from './ml-pipeline-registry';
import {
  ensureBootstrapMlPipelineConfig,
  getActiveMlPipelineConfig,
  type StoredMlPipelineConfig,
} from './ml-pipeline-config-store';

export type FeatureWindowConfig = {
  micro: number;
  short: number;
  medium: number;
  macro: number;
};

export type FeaturePipelineConfig = {
  pipelineVersion: string;
  /** Derived from featureWindows.macro; retained in persisted config/schema for lineage compatibility. */
  canonicalFeatureWindowTicks: number;
  defaultHorizonTicks: number;
  maxHorizonTicks: number;
  featureWindows: FeatureWindowConfig;
  regimeThreshold: number;
  digitPrecision: number;
  syntheticSymbolPrefixes: string[];
  featureOrder: FeatureKey[];
  splitRatios: {
    train: number;
    validation: number;
    test: number;
  };
  splitGapMultiplier: number;
  normalizationMethod: 'zscore';
  normalizationEpsilon: number;
};

export type FeatureVectorSnapshot = {
  featureOrder: FeatureKey[];
  featureCount: number;
  schemaVersion: string;
};

export type MlPipelineConfigRuntime = {
  config: FeaturePipelineConfig;
  source: 'persistent-active' | 'bootstrap';
  version: number | null;
  configHash: string;
  featureSchemaVersion: string;
};

type UnknownRecord = Record<string, unknown>;

let cachedRuntime: MlPipelineConfigRuntime | null = null;
let initializationPromise: Promise<MlPipelineConfigRuntime> | null = null;

function asRecord(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[ML Config] ${path} must be an object.`);
  }
  return value as UnknownRecord;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`[ML Config] ${path} must be a non-empty string.`);
  return value.trim();
}

function requiredPositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`[ML Config] ${path} must be a positive safe integer.`);
  return Number(value);
}

function requiredNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`[ML Config] ${path} must be a non-negative safe integer.`);
  return Number(value);
}

function requiredFiniteNumber(value: unknown, path: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`[ML Config] ${path} must be a finite number.`);
  return parsed;
}

function requiredPositiveNumber(value: unknown, path: string): number {
  const parsed = requiredFiniteNumber(value, path);
  if (parsed <= 0) throw new Error(`[ML Config] ${path} must be greater than zero.`);
  return parsed;
}

function requiredRatio(value: unknown, path: string): number {
  const parsed = requiredFiniteNumber(value, path);
  if (parsed <= 0 || parsed >= 1) throw new Error(`[ML Config] ${path} must be greater than zero and less than one.`);
  return parsed;
}

function requiredStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`[ML Config] ${path} must be a non-empty array.`);
  const result = value.map((item, index) => requiredString(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`[ML Config] ${path} must not contain duplicate values.`);
  return result;
}

/**
 * The effective observation window is derived from the configured feature-window topology.
 * It is deliberately not a universal 300-tick constant.
 */
export function deriveCanonicalFeatureWindowTicks(featureWindows: FeatureWindowConfig): number {
  return featureWindows.macro;
}

function canonicalizeConfig(source: UnknownRecord): FeaturePipelineConfig {
  const bootstrap = buildBootstrapMlPipelineConfig();
  const featureWindowsSource = asRecord(source.featureWindows ?? bootstrap.featureWindows, 'featureWindows');
  const splitSource = asRecord(source.splitRatios ?? bootstrap.splitRatios, 'splitRatios');

  const featureWindows: FeatureWindowConfig = {
    micro: requiredPositiveInteger(featureWindowsSource.micro, 'featureWindows.micro'),
    short: requiredPositiveInteger(featureWindowsSource.short, 'featureWindows.short'),
    medium: requiredPositiveInteger(featureWindowsSource.medium, 'featureWindows.medium'),
    macro: requiredPositiveInteger(featureWindowsSource.macro, 'featureWindows.macro'),
  };

  if (!(featureWindows.micro <= featureWindows.short && featureWindows.short <= featureWindows.medium && featureWindows.medium <= featureWindows.macro)) {
    throw new Error('[ML Config] featureWindows must be ordered micro <= short <= medium <= macro.');
  }

  // Older persisted configs may still contain canonicalFeatureWindowTicks=300.
  // Treat that field as lineage metadata and derive the effective value from the active topology.
  const canonicalFeatureWindowTicks = deriveCanonicalFeatureWindowTicks(featureWindows);

  const defaultHorizonTicks = requiredPositiveInteger(source.defaultHorizonTicks ?? bootstrap.defaultHorizonTicks, 'defaultHorizonTicks');
  const maxHorizonTicks = requiredPositiveInteger(source.maxHorizonTicks ?? bootstrap.maxHorizonTicks, 'maxHorizonTicks');
  if (defaultHorizonTicks > maxHorizonTicks) throw new Error('[ML Config] defaultHorizonTicks cannot exceed maxHorizonTicks.');

  const splitRatios = {
    train: requiredRatio(splitSource.train, 'splitRatios.train'),
    validation: requiredRatio(splitSource.validation, 'splitRatios.validation'),
    test: requiredRatio(splitSource.test, 'splitRatios.test'),
  };
  const splitSum = splitRatios.train + splitRatios.validation + splitRatios.test;
  if (Math.abs(splitSum - 1) > 1e-9) throw new Error('[ML Config] splitRatios must sum to 1.');

  const normalizationMethod = requiredString(source.normalizationMethod ?? bootstrap.normalizationMethod, 'normalizationMethod');
  if (normalizationMethod !== 'zscore') throw new Error(`[ML Config] Unsupported normalizationMethod: ${normalizationMethod}.`);

  const suppliedOrder = source.featureOrder == null ? getFeatureOrder() : requiredStringArray(source.featureOrder, 'featureOrder');
  assertFeatureOrder(suppliedOrder);

  return {
    pipelineVersion: requiredString(source.pipelineVersion ?? bootstrap.pipelineVersion, 'pipelineVersion'),
    canonicalFeatureWindowTicks,
    defaultHorizonTicks,
    maxHorizonTicks,
    featureWindows,
    regimeThreshold: requiredFiniteNumber(source.regimeThreshold ?? bootstrap.regimeThreshold, 'regimeThreshold'),
    digitPrecision: requiredNonNegativeInteger(source.digitPrecision ?? bootstrap.digitPrecision, 'digitPrecision'),
    syntheticSymbolPrefixes: requiredStringArray(source.syntheticSymbolPrefixes ?? bootstrap.syntheticSymbolPrefixes, 'syntheticSymbolPrefixes'),
    featureOrder: getFeatureOrder(),
    splitRatios,
    splitGapMultiplier: requiredPositiveInteger(source.splitGapMultiplier ?? bootstrap.splitGapMultiplier, 'splitGapMultiplier'),
    normalizationMethod: 'zscore',
    normalizationEpsilon: requiredPositiveNumber(source.normalizationEpsilon ?? bootstrap.normalizationEpsilon, 'normalizationEpsilon'),
  };
}

export function validateMlPipelineConfig(value: unknown): FeaturePipelineConfig {
  return canonicalizeConfig(asRecord(value, 'ML pipeline configuration'));
}

function hashConfig(config: FeaturePipelineConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function buildSchemaFingerprint(config: FeaturePipelineConfig, featureOrder: readonly string[] = config.featureOrder, pipelineVersion = config.pipelineVersion): string {
  const featureDefinitions = getFeatureDefinitions().map(({ key, pillar }) => ({ key, pillar }));
  const fingerprintPayload = {
    pipelineVersion,
    featureOrder: [...featureOrder],
    featureDefinitions,
    featureWindows: config.featureWindows,
    canonicalFeatureWindowTicks: deriveCanonicalFeatureWindowTicks(config.featureWindows),
    sequenceLength: config.featureWindows.short,
    defaultHorizonTicks: config.defaultHorizonTicks,
    regimeThreshold: config.regimeThreshold,
    digitPrecision: config.digitPrecision,
    syntheticSymbolPrefixes: config.syntheticSymbolPrefixes,
    splitRatios: config.splitRatios,
    normalizationMethod: config.normalizationMethod,
    normalizationEpsilon: config.normalizationEpsilon,
  };
  return crypto.createHash('sha256').update(JSON.stringify(fingerprintPayload)).digest('hex');
}

function buildRuntime(config: FeaturePipelineConfig, stored?: StoredMlPipelineConfig | null): MlPipelineConfigRuntime {
  return {
    config,
    source: stored ? 'persistent-active' : 'bootstrap',
    version: stored?.version ?? null,
    configHash: stored?.configHash ?? hashConfig(config),
    featureSchemaVersion: deriveFeatureSchemaVersion(config.featureOrder, config.pipelineVersion, config),
  };
}

export async function initializeMlPipelineConfig(): Promise<MlPipelineConfigRuntime> {
  if (cachedRuntime) return cachedRuntime;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    const bootstrap = buildBootstrapMlPipelineConfig();
    try {
      const active = await getActiveMlPipelineConfig();
      if (active) {
        const validated = validateMlPipelineConfig(active.config);
        cachedRuntime = buildRuntime(validated, active);
        return cachedRuntime;
      }

      const featureSchemaVersion = deriveFeatureSchemaVersion(bootstrap.featureOrder, bootstrap.pipelineVersion, bootstrap);
      const created = await ensureBootstrapMlPipelineConfig(bootstrap, featureSchemaVersion);
      if (created) {
        const validated = validateMlPipelineConfig(created.config);
        cachedRuntime = buildRuntime(validated, created);
        return cachedRuntime;
      }
    } catch (error) {
      console.error('[ML Config] persistent initialization failed; using centralized bootstrap template:', error);
    }

    cachedRuntime = buildRuntime(bootstrap);
    return cachedRuntime;
  })().finally(() => {
    initializationPromise = null;
  });

  return initializationPromise;
}

export async function reloadMlPipelineConfig(): Promise<MlPipelineConfigRuntime> {
  cachedRuntime = null;
  return initializeMlPipelineConfig();
}

export function getMlPipelineConfig(): FeaturePipelineConfig {
  return cachedRuntime?.config ?? buildBootstrapMlPipelineConfig();
}

export function getMlPipelineConfigRuntime(): MlPipelineConfigRuntime {
  const config = getMlPipelineConfig();
  return cachedRuntime ?? buildRuntime(config);
}

export function getFeatureVectorSnapshot(config: FeaturePipelineConfig = getMlPipelineConfig()): FeatureVectorSnapshot {
  return {
    featureOrder: [...config.featureOrder],
    featureCount: config.featureOrder.length,
    schemaVersion: deriveFeatureSchemaVersion(config.featureOrder, config.pipelineVersion, config),
  };
}

export function deriveFeatureSchemaVersion(featureOrder: readonly string[], pipelineVersion = getMlPipelineConfig().pipelineVersion, config: FeaturePipelineConfig = getMlPipelineConfig()): string {
  const fingerprint = buildSchemaFingerprint(config, featureOrder, pipelineVersion);
  return `feature-schema-${featureOrder.length}-${fingerprint.slice(0, 12)}`;
}

export function deriveLabelSchemaVersion(labelDeadZone: number, horizonTicks: number, config: FeaturePipelineConfig = getMlPipelineConfig()): string {
  const deadZone = Number.isFinite(labelDeadZone) ? labelDeadZone : 0;
  const digest = crypto.createHash('sha256').update(`${config.pipelineVersion}|${horizonTicks}|${deadZone.toFixed(12)}`).digest('hex').slice(0, 12);
  return `label-schema-${horizonTicks}-${digest}`;
}

export function deriveNormalizationVersion(fingerprint: string, config: FeaturePipelineConfig = getMlPipelineConfig()): string {
  const digest = crypto.createHash('sha256').update(`${config.pipelineVersion}|${config.normalizationMethod}|${fingerprint}`).digest('hex').slice(0, 12);
  return `norm-${config.normalizationMethod}-${digest}`;
}

export function buildDatasetFingerprint(parts: Array<string | number>, config: FeaturePipelineConfig = getMlPipelineConfig()): string {
  return crypto.createHash('sha256').update(`${config.pipelineVersion}|${parts.join('|')}`).digest('hex');
}

export function getRequiredSplitGapTicks(horizonTicks: number, config: FeaturePipelineConfig = getMlPipelineConfig()): number {
  return Math.max(1, Math.ceil(horizonTicks * config.splitGapMultiplier));
}

export function isSyntheticSymbol(symbol: string, config: FeaturePipelineConfig = getMlPipelineConfig()): boolean {
  const normalized = symbol.trim().toUpperCase();
  return config.syntheticSymbolPrefixes.some((prefix) => normalized.startsWith(prefix.toUpperCase()));
}

export function getCanonicalWindowTicks(config: FeaturePipelineConfig = getMlPipelineConfig()): number {
  return deriveCanonicalFeatureWindowTicks(config.featureWindows);
}

export function getDefaultHorizonTicks(config: FeaturePipelineConfig = getMlPipelineConfig()): number {
  return config.defaultHorizonTicks;
}
