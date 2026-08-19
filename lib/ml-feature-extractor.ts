import { getMlPipelineConfig, isSyntheticSymbol, type FeaturePipelineConfig } from './ml-pipeline-config';
import {
  buildFeatureRecord,
  getFeatureOrder,
  type EngineeredFeatureRecord,
  type FeatureKey,
  type FeatureContext,
} from './ml-feature-registry';

export interface TickPoint {
  price: number;
  timestamp?: number;
}

export interface FeatureExtractionOptions {
  contractDurationSecs?: number;
  symbol?: string;
  assetCategoryNum?: number;
  pipelineConfig?: FeaturePipelineConfig;
}

export type EngineeredTickFeatures = EngineeredFeatureRecord;

function ensureTicks(rawTicks: TickPoint[]): TickPoint[] {
  if (!Array.isArray(rawTicks) || rawTicks.length === 0) {
    throw new Error('Feature extraction requires at least one real tick.');
  }
  const sanitized = rawTicks
    .map((tick) => ({
      price: Number(tick.price),
      timestamp: tick.timestamp != null ? Number(tick.timestamp) : undefined,
    }))
    .filter((tick) => Number.isFinite(tick.price) && tick.price > 0);

  if (!sanitized.length) {
    throw new Error('Feature extraction requires valid real tick prices.');
  }
  return sanitized;
}

function calcMomentum(arr: number[]): number {
  if (arr.length < 2) return 0;
  const start = arr[0];
  return start === 0 ? 0 : ((arr[arr.length - 1] - start) / start) * 100;
}

function calcVelocity(arr: number[]): number {
  if (arr.length < 2) return 0;
  return (arr[arr.length - 1] - arr[0]) / arr.length;
}

function calcVolatility(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((sum, value) => sum + value, 0) / arr.length;
  const variance = arr.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / arr.length;
  return Math.sqrt(variance);
}

function calcPersistence(arr: number[]): number {
  if (arr.length < 2) return 0;
  let maxRun = 1;
  let currentRun = 1;
  for (let i = 1; i < arr.length; i += 1) {
    const dirCurrent = Math.sign(arr[i] - arr[i - 1]);
    const dirPrev = Math.sign(arr[i - 1] - (arr[i - 2] ?? arr[i - 1]));
    if (dirCurrent !== 0 && dirCurrent === dirPrev) {
      currentRun += 1;
      if (currentRun > maxRun) maxRun = currentRun;
    } else {
      currentRun = 1;
    }
  }
  return maxRun / arr.length;
}

function calcReversalRate(arr: number[]): number {
  if (arr.length < 3) return 0;
  let reversals = 0;
  for (let i = 2; i < arr.length; i += 1) {
    const diff1 = arr[i - 1] - arr[i - 2];
    const diff2 = arr[i] - arr[i - 1];
    if ((diff1 > 0 && diff2 < 0) || (diff1 < 0 && diff2 > 0)) reversals += 1;
  }
  return reversals / (arr.length - 2);
}

function getSubArray(prices: number[], count: number): number[] {
  return prices.slice(Math.max(0, prices.length - count));
}

function countConsecutiveDirection(prices: number[]): { consecutive_up: number; consecutive_down: number } {
  let consecutive_up = 0;
  let consecutive_down = 0;
  for (let i = prices.length - 1; i >= 1; i -= 1) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) {
      if (consecutive_down > 0) break;
      consecutive_up += 1;
    } else if (diff < 0) {
      if (consecutive_up > 0) break;
      consecutive_down += 1;
    } else {
      break;
    }
  }
  return { consecutive_up, consecutive_down };
}

export function extractTickFeatures(rawTicks: TickPoint[], options: FeatureExtractionOptions = {}): EngineeredTickFeatures {
  const config = options.pipelineConfig ?? getMlPipelineConfig();
  const ticks = ensureTicks(rawTicks);
  const symbol = options.symbol?.trim() ?? '';
  const assetCategoryNum = options.assetCategoryNum ?? 0;
  const contractDurationSecs = options.contractDurationSecs ?? config.defaultHorizonTicks;

  const prices = ticks.map((tick) => tick.price);
  const totalCount = prices.length;
  const currentPrice = prices[totalCount - 1];
  const getWindow = (count: number) => getSubArray(prices, count);

  const pN = currentPrice;
  const pN1 = prices[totalCount - 2] ?? pN;
  const pN2 = prices[totalCount - 3] ?? pN1;
  const pN3 = prices[totalCount - 4] ?? pN2;

  const deltaP1 = pN - pN1;
  const deltaP2 = pN - pN2;
  const deltaP3 = pN - pN3;

  const microTicks = getWindow(config.featureWindows.micro);
  const shortTicks = getWindow(config.featureWindows.short);
  const medTicks = getWindow(config.featureWindows.medium);
  const macroTicks = getWindow(config.featureWindows.macro);

  const upCount = prices.slice(1).reduce((sum, price, index) => sum + (price > prices[index] ? 1 : 0), 0);
  const downCount = prices.slice(1).reduce((sum, price, index) => sum + (price < prices[index] ? 1 : 0), 0);
  const totalDiffs = Math.max(1, prices.length - 1);
  const up_tick_ratio = upCount / totalDiffs;
  const down_tick_ratio = downCount / totalDiffs;
  const directional_imbalance = (upCount - downCount) / totalDiffs;
  const { consecutive_up, consecutive_down } = countConsecutiveDirection(prices);

  const v1 = calcVelocity(shortTicks.slice(0, Math.floor(shortTicks.length / 2)));
  const v2 = calcVelocity(shortTicks.slice(Math.floor(shortTicks.length / 2)));
  const shortHigh = shortTicks.length ? Math.max(...shortTicks) : currentPrice;
  const shortLow = shortTicks.length ? Math.min(...shortTicks) : currentPrice;
  const medHigh = medTicks.length ? Math.max(...medTicks) : currentPrice;
  const medLow = medTicks.length ? Math.min(...medTicks) : currentPrice;

  const micro_momentum = calcMomentum(microTicks);
  const short_momentum = calcMomentum(shortTicks);
  const medium_momentum = calcMomentum(medTicks);
  const macro_momentum = calcMomentum(macroTicks);

  const micro_velocity = calcVelocity(microTicks);
  const short_velocity = calcVelocity(shortTicks);
  const medium_velocity = calcVelocity(medTicks);
  const acceleration = v2 - v1;

  const micro_persistence = calcPersistence(microTicks);
  const short_persistence = calcPersistence(shortTicks);
  const short_reversal_rate = calcReversalRate(shortTicks);
  const medium_reversal_rate = calcReversalRate(medTicks);

  const short_volatility = calcVolatility(shortTicks);
  const medium_volatility = calcVolatility(medTicks);
  const macro_volatility = calcVolatility(macroTicks);

  const short_range = shortHigh - shortLow;
  const short_rangeCompression = short_range === 0 ? 0.5 : (shortTicks[shortTicks.length - 1] - shortLow) / short_range;
  const medium_displacement = Math.abs(medTicks[medTicks.length - 1] - medTicks[0]);
  const macro_displacement = Math.abs(macroTicks[macroTicks.length - 1] - macroTicks[0]);
  const medium_distHigh = medHigh - currentPrice;
  const medium_distLow = currentPrice - medLow;

  const firstTickTs = Number.isFinite(ticks[0].timestamp) ? Number(ticks[0].timestamp) : Date.now() - ticks.length * 1000;
  const lastTickTs = Number.isFinite(ticks[ticks.length - 1].timestamp) ? Number(ticks[ticks.length - 1].timestamp) : Date.now();
  const elapsedTimeSec = Math.max(1, (lastTickTs - firstTickTs) / 1000);

  const velocity_per_second = (currentPrice - ticks[0].price) / elapsedTimeSec;
  const ticks_per_second = totalCount / elapsedTimeSec;
  const durationFactor = Math.log(Math.max(1, contractDurationSecs));
  const macro_regime = macro_momentum > config.regimeThreshold ? 1.0 : macro_momentum < -config.regimeThreshold ? -1.0 : 0.0;
  const is1SecondSynthetic = isSyntheticSymbol(symbol, config) ? 1.0 : 0.0;

  let evenDigits = 0;
  ticks.forEach((tick) => {
    const str = tick.price.toFixed(config.digitPrecision);
    const lastDigit = parseInt(str.slice(-1), 10);
    if (!Number.isNaN(lastDigit) && lastDigit % 2 === 0) evenDigits += 1;
  });
  const digitFrequency = totalCount > 0 ? evenDigits / totalCount : 0.5;

  const context: FeatureContext = {
    deltaP1,
    deltaP2,
    deltaP3,
    micro_momentum,
    short_momentum,
    medium_momentum,
    macro_momentum,
    short_range,
    medium_displacement,
    macro_displacement,
    up_tick_ratio,
    down_tick_ratio,
    directional_imbalance,
    consecutive_up,
    consecutive_down,
    micro_persistence,
    short_persistence,
    short_reversal_rate,
    medium_reversal_rate,
    micro_velocity,
    short_velocity,
    medium_velocity,
    acceleration,
    ticks_per_second,
    velocity_per_second,
    short_volatility,
    medium_volatility,
    macro_volatility,
    short_rangeCompression,
    medium_distHigh,
    medium_distLow,
    macro_regime,
    is1SecondSynthetic,
    contractDurationSecs,
    durationFactor,
    digitFrequency,
    assetCategory: assetCategoryNum,
  };

  return buildFeatureRecord(context);
}

export const extract37TickFeatures = extractTickFeatures;

export function featureObjToArray(
  features: EngineeredTickFeatures,
  featureOrder: readonly FeatureKey[] = getFeatureOrder(),
): number[] {
  return featureOrder.map((key) => {
    const value = features[key];
    return Number.isFinite(value) ? value : 0;
  });
}
