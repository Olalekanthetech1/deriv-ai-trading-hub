/**
 * Dynamic Asset Speed & Microstructure Normalization Engine
 * 
 * Continuously estimates an asset-specific speed profile from recent tick behavior.
 * Distinguishes between variance and directional velocity.
 * Dynamically categorizes assets into COMPRESSED, NORMAL, FAST, and EXTREME.
 */

export type AssetSpeedTier = 'COMPRESSED' | 'NORMAL' | 'FAST' | 'EXTREME';

export interface AssetSpeedProfile {
  symbol: string;
  tickVelocity: number;           // Ticks per second or price delta magnitude per tick
  meanAbsoluteReturn: number;     // Average |p_t - p_{t-1}| / p_{t-1}
  microVariance: number;          // Variance of tick returns
  directionalPersistence: number; // Ratio of consistent direction streaks
  efficiencyRatio: number;        // Kaufman ER: net displacement / total path
  normalizedSpeedScore: number;   // [0.0 - 1.0] composite speed index
  speedTier: AssetSpeedTier;      // Dynamic operational category
  horizonScalingMultiplier: number; // Bounded duration normalizer [0.70 - 1.35]
  timestamp: number;
}

// Rolling price history per asset for speed profiling
const assetTickHistory = new Map<string, Array<{ price: number; time: number }>>();

/**
 * Feeds a new live tick to update the asset speed profile.
 */
export function recordAssetTick(symbol: string, price: number, time = Date.now()): void {
  const history = assetTickHistory.get(symbol) || [];
  history.push({ price, time });
  if (history.length > 100) {
    history.shift();
  }
  assetTickHistory.set(symbol, history);
}

/**
 * Computes the dynamic asset speed profile from live tick prices.
 */
export function computeAssetSpeedProfile(symbol: string, prices?: number[]): AssetSpeedProfile {
  const now = Date.now();
  let priceSeries: number[] = prices && prices.length >= 3 ? prices : [];

  if (priceSeries.length === 0) {
    const recorded = assetTickHistory.get(symbol);
    if (recorded && recorded.length >= 3) {
      priceSeries = recorded.map((r) => r.price);
    }
  }

  // Fallback defaults if insufficient data
  if (priceSeries.length < 3) {
    return {
      symbol,
      tickVelocity: 1.0,
      meanAbsoluteReturn: 0.0002,
      microVariance: 0.0001,
      directionalPersistence: 0.50,
      efficiencyRatio: 0.50,
      normalizedSpeedScore: 0.50,
      speedTier: 'NORMAL',
      horizonScalingMultiplier: 1.0,
      timestamp: now,
    };
  }

  const N = Math.min(priceSeries.length, 30);
  const recent = priceSeries.slice(priceSeries.length - N);

  // 1. Efficiency Ratio & Absolute Returns
  let totalPath = 0;
  let absReturns: number[] = [];
  let deltas: number[] = [];
  let directionalStreaks = 0;
  let currentStreak = 1;
  let streakSign = 0;

  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    const absDiff = Math.abs(diff);
    totalPath += absDiff;
    deltas.push(diff);

    const prevP = recent[i - 1];
    if (prevP > 0) {
      absReturns.push(absDiff / prevP);
    }

    const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (sign !== 0 && sign === streakSign) {
      currentStreak++;
      if (currentStreak >= 3) directionalStreaks++;
    } else {
      streakSign = sign;
      currentStreak = 1;
    }
  }

  const netDisplacement = Math.abs(recent[recent.length - 1] - recent[0]);
  const er = totalPath > 0 ? netDisplacement / totalPath : 0.50;

  const meanAbsReturn = absReturns.length > 0
    ? absReturns.reduce((a, b) => a + b, 0) / absReturns.length
    : 0.0002;

  // 2. Micro-Variance
  const meanDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const variance = deltas.length > 0
    ? deltas.reduce((a, d) => a + Math.pow(d - meanDelta, 2), 0) / deltas.length
    : 0.0001;

  // 3. Directional Persistence
  const persistence = Math.min(1.0, Math.max(0.1, (directionalStreaks / (N - 1)) * 2.5 + (er * 0.5)));

  // 4. Tick Velocity (Displacement speed vs Path speed)
  const tickVelocity = Math.max(0.2, (meanAbsReturn * 1000) * (0.6 + er * 0.8));

  // 5. Normalized Speed Score [0.0 - 1.0]
  // Note: We combine velocity, persistence, and ER, strictly separating directional speed from pure chop variance
  const rawScore = (Math.min(1.0, tickVelocity / 2.5) * 0.40) +
                   (er * 0.35) +
                   (persistence * 0.25);
  const normalizedSpeedScore = Math.max(0.05, Math.min(0.98, rawScore));

  // 6. Dynamic Tier Classification
  let speedTier: AssetSpeedTier = 'NORMAL';
  if (normalizedSpeedScore >= 0.75 || (er > 0.70 && tickVelocity > 2.0)) {
    speedTier = 'EXTREME';
  } else if (normalizedSpeedScore >= 0.55 || er > 0.55) {
    speedTier = 'FAST';
  } else if (normalizedSpeedScore <= 0.28 || er < 0.25) {
    speedTier = 'COMPRESSED';
  } else {
    speedTier = 'NORMAL';
  }

  // 7. Horizon Scaling Multiplier [0.70 - 1.35]
  // On FAST/EXTREME: shorter duration window captures move without whipsaw (0.70 - 0.90x)
  // On COMPRESSED: wider duration window filters chop and lets move develop (1.10 - 1.35x)
  let horizonScalingMultiplier = 1.0;
  if (speedTier === 'EXTREME') {
    horizonScalingMultiplier = 0.72;
  } else if (speedTier === 'FAST') {
    horizonScalingMultiplier = 0.85;
  } else if (speedTier === 'COMPRESSED') {
    horizonScalingMultiplier = 1.25;
  } else {
    horizonScalingMultiplier = 1.0;
  }

  return {
    symbol,
    tickVelocity: Number(tickVelocity.toFixed(3)),
    meanAbsoluteReturn: Number(meanAbsReturn.toFixed(6)),
    microVariance: Number(variance.toFixed(6)),
    directionalPersistence: Number(persistence.toFixed(3)),
    efficiencyRatio: Number(er.toFixed(3)),
    normalizedSpeedScore: Number(normalizedSpeedScore.toFixed(3)),
    speedTier,
    horizonScalingMultiplier: Number(horizonScalingMultiplier.toFixed(2)),
    timestamp: now,
  };
}
