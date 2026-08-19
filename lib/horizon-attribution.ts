/**
 * Closed-Loop Post-Trade Attribution & Regime Feedback Engine (CPARFE)
 * 
 * In accordance with AGENTS.md:
 * - §0 Zero-Mock & Dynamic Only
 * - §8 Pure Raw Microstructure (Tick velocities, MFE, MAE, inter-arrival dynamics - NO technical indicators)
 * - §18 Model Lifecycle Integrity
 * 
 * Provides server-authoritative post-trade attribution, Maximum Favorable Excursion (MFE),
 * Maximum Adverse Excursion (MAE), horizon residual verification, and online regime prior adjustments.
 */

export interface TradeAttributionInput {
  tradeId: string;
  symbol: string;
  horizonKey: string;
  horizonValue: number;
  horizonUnit: string;
  direction: 'CALL' | 'PUT';
  entryPrice: number;
  exitPrice: number;
  entryTimestamp: number;
  exitTimestamp: number;
  outcome: 'WIN' | 'LOSS';
  profit: number;
  stake: number;
  intratradeTicks?: Array<{ price: number; timestamp: number }>;
  executionPlanId?: string;
  strategyName?: string;
}

export interface HorizonAttributionMetrics {
  tradeId: string;
  symbol: string;
  horizonKey: string;
  outcome: 'WIN' | 'LOSS';
  profit: number;
  mfe: number;                  // Maximum Favorable Excursion (in price ticks/points)
  mae: number;                  // Maximum Adverse Excursion (in price ticks/points)
  mfeRatio: number;             // MFE / (MFE + MAE + epsilon) [0.0 - 1.0]
  optimalExitTickIndex: number; // The tick index where MFE was reached
  totalTicksObserved: number;
  earlyExhaustion: boolean;     // True if MFE occurred early (<40% of duration) and decayed before expiry
  horizonFitScore: number;      // [0.0 - 1.0] Realized micro-fit score
  attributionTimestamp: number;
}

import { evaluateAndTriggerCohortRetraining, type CohortRetrainingTriggerResult } from './ml-cohort-retraining-trigger';

export interface HorizonPriorAdjustment {
  horizonKey: string;
  sampleCount: number;
  realizedWinRate: number;
  avgMfeRatio: number;
  earlyExhaustionRate: number;     // Ratio of trades with early exhaustion [0.0 - 1.0]
  regimeFitnessMultiplier: number; // [0.60 - 1.40] dynamic multiplier for HDE candidate scoring
  attributionDriftBreached: boolean;
  lastUpdated: number;
}

// In-memory sliding window of attribution records (partitioned by symbol and horizon)
const MAX_ATTRIBUTION_HISTORY = 1000;
const attributionHistory: HorizonAttributionMetrics[] = [];
const horizonPriorMap = new Map<string, HorizonPriorAdjustment>(); // key: `${symbol}:${horizonKey}`

/**
 * Computes Maximum Favorable Excursion (MFE), Maximum Adverse Excursion (MAE),
 * and horizon residual efficiency for a completed contract.
 */
export function recordTradeAttribution(input: TradeAttributionInput): HorizonAttributionMetrics {
  const {
    tradeId,
    symbol,
    horizonKey,
    direction,
    entryPrice,
    exitPrice,
    outcome,
    profit,
    intratradeTicks,
  } = input;

  const now = Date.now();
  let mfe = 0;
  let mae = 0;
  let optimalExitTickIndex = 0;
  const totalTicks = intratradeTicks && intratradeTicks.length > 0 ? intratradeTicks.length : 1;

  if (intratradeTicks && intratradeTicks.length > 0) {
    for (let i = 0; i < intratradeTicks.length; i++) {
      const p = intratradeTicks[i].price;
      const priceDelta = p - entryPrice;
      const favorableDelta = direction === 'CALL' ? priceDelta : -priceDelta;

      if (favorableDelta > mfe) {
        mfe = favorableDelta;
        optimalExitTickIndex = i;
      }
      if (-favorableDelta > mae) {
        mae = -favorableDelta;
      }
    }
  } else {
    // Fallback using terminal exit price if granular tick stream was compressed
    const terminalDelta = exitPrice - entryPrice;
    const favorableDelta = direction === 'CALL' ? terminalDelta : -terminalDelta;
    if (favorableDelta > 0) {
      mfe = favorableDelta;
    } else {
      mae = -favorableDelta;
    }
  }

  const epsilon = 1e-6;
  const mfeRatio = mfe / (mfe + mae + epsilon);
  const earlyExhaustion = totalTicks > 3 && optimalExitTickIndex < totalTicks * 0.40 && outcome === 'LOSS';

  // Realized micro-fit score calculation
  const winBonus = outcome === 'WIN' ? 0.30 : 0.0;
  const pathBonus = Math.min(Math.max(mfeRatio * 0.50, 0), 0.50);
  const exhaustionPenalty = earlyExhaustion ? 0.20 : 0.0;
  const horizonFitScore = Math.min(Math.max(0.20 + winBonus + pathBonus - exhaustionPenalty, 0.05), 1.0);

  const metrics: HorizonAttributionMetrics = {
    tradeId,
    symbol,
    horizonKey,
    outcome,
    profit,
    mfe,
    mae,
    mfeRatio,
    optimalExitTickIndex,
    totalTicksObserved: totalTicks,
    earlyExhaustion,
    horizonFitScore,
    attributionTimestamp: now,
  };

  attributionHistory.push(metrics);
  if (attributionHistory.length > MAX_ATTRIBUTION_HISTORY) {
    attributionHistory.shift();
  }

  // Update dynamic online prior adjustment for HDE
  updateHorizonPrior(symbol, horizonKey);

  return metrics;
}

/**
 * Updates the online dynamic prior multiplier for a (symbol, horizonKey) pair.
 */
function updateHorizonPrior(symbol: string, horizonKey: string): void {
  const mapKey = `${symbol}:${horizonKey}`;
  const recentRecords = attributionHistory
    .filter((r) => r.symbol === symbol && r.horizonKey === horizonKey)
    .slice(-20); // Last 20 trades for responsiveness

  if (recentRecords.length < 3) {
    return; // Maintain neutral prior until minimum sample size reached
  }

  const wins = recentRecords.filter((r) => r.outcome === 'WIN').length;
  const realizedWinRate = wins / recentRecords.length;
  const avgMfeRatio = recentRecords.reduce((acc, r) => acc + r.mfeRatio, 0) / recentRecords.length;
  const avgFitScore = recentRecords.reduce((acc, r) => acc + r.horizonFitScore, 0) / recentRecords.length;
  const earlyExhaustions = recentRecords.filter((r) => r.earlyExhaustion).length;
  const earlyExhaustionRate = earlyExhaustions / recentRecords.length;

  // Multiplier centered at 1.00, bounded in [0.70, 1.30]
  // Win rate baseline 0.55 (standard binary options payout threshold)
  const winDelta = (realizedWinRate - 0.55) * 0.60;
  const mfeDelta = (avgMfeRatio - 0.50) * 0.40;
  const exhaustionDelta = earlyExhaustionRate * -0.30;
  const rawMultiplier = 1.00 + winDelta + mfeDelta + exhaustionDelta;
  const regimeFitnessMultiplier = Math.min(Math.max(rawMultiplier, 0.60), 1.40);

  // Critical Attribution Residual Threshold δ_crit
  // If realized win rate < 0.40, or early exhaustion > 40%, or avgMfeRatio < 0.35 across 10+ samples
  const isBreached = recentRecords.length >= 10 && (realizedWinRate < 0.40 || earlyExhaustionRate > 0.40 || avgMfeRatio < 0.35);

  horizonPriorMap.set(mapKey, {
    horizonKey,
    sampleCount: recentRecords.length,
    realizedWinRate,
    avgMfeRatio,
    earlyExhaustionRate,
    regimeFitnessMultiplier,
    attributionDriftBreached: isBreached,
    lastUpdated: Date.now(),
  });

  // Circuit Breaker Interlocking: Dispatch automated background ML retraining trigger if breached
  if (isBreached) {
    void evaluateAndTriggerCohortRetraining({ assetSymbol: symbol }).catch((err) => {
      console.warn(`[CPARFE] Automated cohort retraining dispatch failed for ${symbol}:`, err);
    });
  }
}

/**
 * Retrieves the dynamic online regime fitness multiplier for HDE candidate scoring.
 * Returns 1.00 if insufficient attribution data exists.
 */
export function getHorizonAttributionMultiplier(symbol: string, horizonKey: string): number {
  const mapKey = `${symbol}:${horizonKey}`;
  const prior = horizonPriorMap.get(mapKey);
  if (!prior) return 1.00;

  // Prior decay if older than 30 minutes
  const ageMs = Date.now() - prior.lastUpdated;
  if (ageMs > 30 * 60 * 1000) {
    const decayFactor = Math.max(0, 1 - (ageMs - 30 * 60 * 1000) / (60 * 60 * 1000));
    return 1.00 + (prior.regimeFitnessMultiplier - 1.00) * decayFactor;
  }

  return prior.regimeFitnessMultiplier;
}

/**
 * Returns attribution diagnostic summary across all tracked horizons for a symbol or globally.
 */
export function getAttributionDiagnostics(symbol?: string): {
  totalAttributions: number;
  recentAttributions: HorizonAttributionMetrics[];
  horizonPriors: HorizonPriorAdjustment[];
  mfeDistribution: {
    excellent: number; // MFE ratio >= 0.70
    moderate: number;  // 0.40 <= MFE ratio < 0.70
    adverse: number;   // MFE ratio < 0.40
  };
  earlyExhaustionTotal: number;
} {
  const filtered = symbol && symbol !== 'all'
    ? attributionHistory.filter((r) => r.symbol === symbol)
    : attributionHistory;

  const recent = filtered.slice(-30);
  const priors: HorizonPriorAdjustment[] = [];

  for (const [key, prior] of horizonPriorMap.entries()) {
    if (!symbol || symbol === 'all' || key.startsWith(`${symbol}:`)) {
      priors.push(prior);
    }
  }

  const excellent = filtered.filter((r) => r.mfeRatio >= 0.70).length;
  const moderate = filtered.filter((r) => r.mfeRatio >= 0.40 && r.mfeRatio < 0.70).length;
  const adverse = filtered.filter((r) => r.mfeRatio < 0.40).length;
  const earlyExhaustionTotal = filtered.filter((r) => r.earlyExhaustion).length;

  return {
    totalAttributions: filtered.length,
    recentAttributions: recent,
    horizonPriors: priors,
    mfeDistribution: {
      excellent,
      moderate,
      adverse,
    },
    earlyExhaustionTotal,
  };
}
