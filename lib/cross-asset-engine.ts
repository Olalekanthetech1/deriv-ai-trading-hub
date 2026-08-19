/**
 * Cross-Asset Relationship & Information Engine
 * 
 * Evaluates rolling return relationships, contemporaneous Pearson correlation,
 * lag cross-correlations, correlation stability, and common volatility factors
 * across Synthetic Volatility Indices.
 * 
 * Output is strictly a bounded feature/modulator, not an unconditional trade signal.
 */

export interface CrossAssetRelationshipProfile {
  primarySymbol: string;
  comparisonSymbols: string[];
  contemporaneousCorrelation: number; // [-1.0 to 1.0]
  lag1Correlation: number;           // [-1.0 to 1.0]
  correlationStability: number;      // [0.0 to 1.0] (1.0 = highly stable)
  isStatisticallySignificant: boolean;
  commonVolatilityFactor: number;    // Shared volatility dispersion [0.0 to 1.0]
  crossAssetInfoScore: number;       // [0.0 to 1.0] Normalized information index
  horizonModulationFactor: number;   // Bounded multiplier [0.92 to 1.08]
  timestamp: number;
}

// In-memory synchronized tick returns buffer for multi-asset monitoring
const assetPriceStreams = new Map<string, Array<{ price: number; time: number }>>();

/**
 * Feeds a tick price into the cross-asset stream cache.
 */
export function recordCrossAssetTick(symbol: string, price: number, time = Date.now()): void {
  const stream = assetPriceStreams.get(symbol) || [];
  stream.push({ price, time });
  if (stream.length > 80) stream.shift();
  assetPriceStreams.set(symbol, stream);
}

/**
 * Calculates Pearson correlation coefficient between two series of equal length.
 */
function computePearsonCorrelation(x: number[], y: number[]): { corr: number; pSignificant: boolean } {
  const n = Math.min(x.length, y.length);
  if (n < 5) return { corr: 0, pSignificant: false };

  const xSlice = x.slice(x.length - n);
  const ySlice = y.slice(y.length - n);

  const meanX = xSlice.reduce((a, b) => a + b, 0) / n;
  const meanY = ySlice.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let denX = 0;
  let denY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - meanX;
    const dy = ySlice[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  if (den === 0) return { corr: 0, pSignificant: false };

  const corr = Math.max(-1.0, Math.min(1.0, num / den));
  // Approximate t-test significance: t = r * sqrt((n-2)/(1-r^2)) > 2.0 (~p < 0.05 for n > 15)
  const df = n - 2;
  const tStat = Math.abs(corr) * Math.sqrt(Math.max(0.001, df / Math.max(0.001, 1 - corr * corr)));
  const pSignificant = tStat > 2.0 && n >= 10;

  return { corr, pSignificant };
}

/**
 * Evaluates the cross-asset relationships for a given primary symbol against active synthetic peers.
 */
export function computeCrossAssetRelationship(
  primarySymbol: string,
  primaryPrices?: number[]
): CrossAssetRelationshipProfile {
  const now = Date.now();
  let pSeries: number[] = primaryPrices && primaryPrices.length >= 5 ? primaryPrices : [];

  if (pSeries.length === 0) {
    const stream = assetPriceStreams.get(primarySymbol);
    if (stream && stream.length >= 5) pSeries = stream.map((s) => s.price);
  }

  // Derive percentage returns for primary series
  const pReturns: number[] = [];
  for (let i = 1; i < pSeries.length; i++) {
    const prev = pSeries[i - 1];
    if (prev > 0) pReturns.push((pSeries[i] - prev) / prev);
  }

  const peerSymbols = Array.from(assetPriceStreams.keys()).filter((k) => k !== primarySymbol);

  if (pReturns.length < 5 || peerSymbols.length === 0) {
    return {
      primarySymbol,
      comparisonSymbols: [],
      contemporaneousCorrelation: 0.0,
      lag1Correlation: 0.0,
      correlationStability: 0.50,
      isStatisticallySignificant: false,
      commonVolatilityFactor: 0.50,
      crossAssetInfoScore: 0.50,
      horizonModulationFactor: 1.0,
      timestamp: now,
    };
  }

  let totalCorr = 0;
  let totalLagCorr = 0;
  let significantCount = 0;
  let validPeers: string[] = [];

  for (const peer of peerSymbols) {
    const peerData = assetPriceStreams.get(peer) || [];
    if (peerData.length < 5) continue;
    const peerPrices = peerData.map((d) => d.price);
    const peerReturns: number[] = [];
    for (let i = 1; i < peerPrices.length; i++) {
      const prev = peerPrices[i - 1];
      if (prev > 0) peerReturns.push((peerPrices[i] - prev) / prev);
    }

    if (peerReturns.length < 5) continue;

    // Contemporaneous
    const { corr, pSignificant } = computePearsonCorrelation(pReturns, peerReturns);
    totalCorr += corr;
    if (pSignificant) significantCount++;

    // Lag 1 (Peer leading Primary)
    if (peerReturns.length >= 6 && pReturns.length >= 6) {
      const lagPeer = peerReturns.slice(0, peerReturns.length - 1);
      const leadPrimary = pReturns.slice(1);
      const { corr: lagCorr } = computePearsonCorrelation(leadPrimary, lagPeer);
      totalLagCorr += lagCorr;
    }

    validPeers.push(peer);
  }

  const numPeers = Math.max(1, validPeers.length);
  const avgCorr = totalCorr / numPeers;
  const avgLagCorr = totalLagCorr / numPeers;
  const isStatisticallySignificant = significantCount > 0;

  // Correlation stability: measure consistency vs noise
  const correlationStability = isStatisticallySignificant
    ? Math.max(0.40, Math.min(0.95, 1.0 - Math.abs(avgCorr - avgLagCorr)))
    : 0.50;

  // Common Volatility Factor: measure synchrony of return variance
  const commonVolatilityFactor = Math.min(1.0, Math.max(0.1, (Math.abs(avgCorr) * 0.7) + (correlationStability * 0.3)));

  // Bounded Cross-Asset Info Score [0.0 - 1.0]
  const crossAssetInfoScore = isStatisticallySignificant
    ? (Math.abs(avgCorr) * 0.5 + Math.abs(avgLagCorr) * 0.3 + correlationStability * 0.2)
    : 0.50;

  // Bounded Horizon Modulation Factor [0.92 - 1.08]
  // High inter-market synchrony allows slightly tighter horizon confirmation
  const horizonModulationFactor = isStatisticallySignificant
    ? Math.max(0.92, Math.min(1.08, 1.0 - (avgLagCorr * 0.08)))
    : 1.0;

  return {
    primarySymbol,
    comparisonSymbols: validPeers,
    contemporaneousCorrelation: Number(avgCorr.toFixed(3)),
    lag1Correlation: Number(avgLagCorr.toFixed(3)),
    correlationStability: Number(correlationStability.toFixed(3)),
    isStatisticallySignificant,
    commonVolatilityFactor: Number(commonVolatilityFactor.toFixed(3)),
    crossAssetInfoScore: Number(crossAssetInfoScore.toFixed(3)),
    horizonModulationFactor: Number(horizonModulationFactor.toFixed(3)),
    timestamp: now,
  };
}
