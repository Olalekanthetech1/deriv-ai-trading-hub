import type { FeaturePipelineConfig, FeatureWindowConfig } from './ml-pipeline-config';

export type DurationFeatureUnit = 't' | 's' | 'm' | 'h' | 'd';

const BASE_FEATURE_WINDOWS: FeatureWindowConfig = {
  micro: 5,
  short: 25,
  medium: 100,
  macro: 300,
};

const TIME_UNIT_SECONDS: Record<Exclude<DurationFeatureUnit, 't'>, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * Duration-aware feature topology.
 *
 * The historical 5/25/100/300 topology remains the baseline for the shortest
 * supported time duration (15s) and 1 tick. Longer contracts receive more
 * observation context using logarithmic scaling so the topology grows with
 * the contract without exploding to an impractical linear window.
 */
export function deriveDurationFeatureWindows(value: number, unit: DurationFeatureUnit): FeatureWindowConfig {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Duration value must be a positive safe integer.');
  }

  const scale = unit === 't'
    ? 1 + Math.log10(Math.max(1, value))
    : 1 + Math.log10(Math.max(1, (value * TIME_UNIT_SECONDS[unit]) / 15));

  const values = Object.entries(BASE_FEATURE_WINDOWS).map(([key, base]) => [key, Math.max(1, Math.ceil(base * scale))] as const);
  return Object.fromEntries(values) as FeatureWindowConfig;
}

export function withDurationFeatureWindows(
  config: FeaturePipelineConfig,
  value: number,
  unit: DurationFeatureUnit,
): FeaturePipelineConfig {
  const featureWindows = deriveDurationFeatureWindows(value, unit);
  return {
    ...config,
    featureWindows,
    canonicalFeatureWindowTicks: featureWindows.macro,
  };
}

export function durationFeatureTopologyLabel(featureWindows: FeatureWindowConfig): string {
  return `${featureWindows.micro} → ${featureWindows.short} → ${featureWindows.medium} → ${featureWindows.macro}`;
}

export function durationSecondsForFeaturePolicy(value: number, unit: DurationFeatureUnit): number | null {
  return unit === 't' ? null : value * TIME_UNIT_SECONDS[unit];
}

export function getDurationFeaturePolicyExamples() {
  const examples = [
    { value: 1, unit: 't' as const },
    { value: 15, unit: 's' as const },
    { value: 60, unit: 's' as const },
    { value: 1, unit: 'm' as const },
    { value: 1, unit: 'h' as const },
    { value: 1, unit: 'd' as const },
  ];
  return examples.map((duration) => ({
    ...duration,
    durationSeconds: durationSecondsForFeaturePolicy(duration.value, duration.unit),
    featureWindows: deriveDurationFeatureWindows(duration.value, duration.unit),
  }));
}
