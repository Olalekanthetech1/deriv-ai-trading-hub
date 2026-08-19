export type FeatureContext = {
  deltaP1: number;
  deltaP2: number;
  deltaP3: number;
  micro_momentum: number;
  short_momentum: number;
  medium_momentum: number;
  macro_momentum: number;
  short_range: number;
  medium_displacement: number;
  macro_displacement: number;
  up_tick_ratio: number;
  down_tick_ratio: number;
  directional_imbalance: number;
  consecutive_up: number;
  consecutive_down: number;
  micro_persistence: number;
  short_persistence: number;
  short_reversal_rate: number;
  medium_reversal_rate: number;
  micro_velocity: number;
  short_velocity: number;
  medium_velocity: number;
  acceleration: number;
  ticks_per_second: number;
  velocity_per_second: number;
  short_volatility: number;
  medium_volatility: number;
  macro_volatility: number;
  short_rangeCompression: number;
  medium_distHigh: number;
  medium_distLow: number;
  macro_regime: number;
  is1SecondSynthetic: number;
  contractDurationSecs: number;
  durationFactor: number;
  digitFrequency: number;
  assetCategory: number;
};

export type FeatureDefinition<K extends string = string> = {
  key: K;
  pillar: string;
  compute: (context: FeatureContext) => number;
};

const define = <K extends keyof FeatureContext>(key: K, pillar: string): FeatureDefinition<K> => ({
  key,
  pillar,
  compute: (context) => context[key],
});

export const FEATURE_DEFINITIONS = [
  define('deltaP1', 'price-behaviour'),
  define('deltaP2', 'price-behaviour'),
  define('deltaP3', 'price-behaviour'),
  define('micro_momentum', 'price-behaviour'),
  define('short_momentum', 'price-behaviour'),
  define('medium_momentum', 'price-behaviour'),
  define('macro_momentum', 'price-behaviour'),
  define('short_range', 'price-behaviour'),
  define('medium_displacement', 'price-behaviour'),
  define('macro_displacement', 'price-behaviour'),
  define('up_tick_ratio', 'tick-pressure-sequencing'),
  define('down_tick_ratio', 'tick-pressure-sequencing'),
  define('directional_imbalance', 'tick-pressure-sequencing'),
  define('consecutive_up', 'tick-pressure-sequencing'),
  define('consecutive_down', 'tick-pressure-sequencing'),
  define('micro_persistence', 'tick-pressure-sequencing'),
  define('short_persistence', 'tick-pressure-sequencing'),
  define('short_reversal_rate', 'tick-pressure-sequencing'),
  define('medium_reversal_rate', 'tick-pressure-sequencing'),
  define('micro_velocity', 'tick-velocity-acceleration'),
  define('short_velocity', 'tick-velocity-acceleration'),
  define('medium_velocity', 'tick-velocity-acceleration'),
  define('acceleration', 'tick-velocity-acceleration'),
  define('ticks_per_second', 'tick-velocity-acceleration'),
  define('velocity_per_second', 'tick-velocity-acceleration'),
  define('short_volatility', 'volatility'),
  define('medium_volatility', 'volatility'),
  define('macro_volatility', 'volatility'),
  define('short_rangeCompression', 'volatility'),
  define('medium_distHigh', 'volatility'),
  define('medium_distLow', 'volatility'),
  define('macro_regime', 'context-regime'),
  define('is1SecondSynthetic', 'context-regime'),
  define('contractDurationSecs', 'context-regime'),
  define('durationFactor', 'context-regime'),
  define('digitFrequency', 'context-regime'),
  define('assetCategory', 'context-regime'),
] as const satisfies readonly FeatureDefinition<keyof FeatureContext>[];

export type FeatureKey = typeof FEATURE_DEFINITIONS[number]['key'];
export type EngineeredFeatureRecord = Record<FeatureKey, number>;

export function getFeatureDefinitions(): readonly FeatureDefinition<FeatureKey>[] {
  return FEATURE_DEFINITIONS;
}

export function getFeatureOrder(): FeatureKey[] {
  return FEATURE_DEFINITIONS.map(({ key }) => key);
}

export function getFeatureCount(): number {
  return FEATURE_DEFINITIONS.length;
}

export function buildFeatureRecord(context: FeatureContext): EngineeredFeatureRecord {
  const record = {} as EngineeredFeatureRecord;
  const invalidKeys: string[] = [];

  for (const definition of FEATURE_DEFINITIONS) {
    const value = Number(definition.compute(context));
    if (!Number.isFinite(value)) {
      invalidKeys.push(definition.key);
      continue;
    }
    record[definition.key] = value;
  }

  if (invalidKeys.length > 0) {
    throw new Error(`FEATURE_DATA_INVALID:${invalidKeys.join(',')}`);
  }

  return record;
}

export function assertFeatureOrder(order: readonly string[]): asserts order is readonly FeatureKey[] {
  const canonical = getFeatureOrder();
  if (order.length !== canonical.length || order.some((key, index) => key !== canonical[index])) {
    throw new Error(
      `[ML Feature Registry] featureOrder must exactly match the canonical registry (${canonical.length} features).`,
    );
  }
}
