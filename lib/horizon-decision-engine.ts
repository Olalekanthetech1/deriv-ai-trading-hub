import type { ProductionEnsembleResult, Signal } from './production-ensemble';
import { durationToSeconds } from './deriv-duration-registry';
import type { DurationOption, DurationSelectUnit } from './duration-utils';
import { recordModelTradeOutcome } from './probabilistic-drift-engine';
import { evaluateAndTriggerCohortRetraining } from './ml-cohort-retraining-trigger';

export type HorizonDecisionMode = 'auto' | 'ai_assist' | 'manual';

export interface CandidateHorizon { value: number; unit: DurationSelectUnit; seconds: number; label: string; key: string; }
export interface HorizonRankItem {
  value: number; unit: DurationSelectUnit; seconds: number; label: string; key: string; direction: Signal;
  modelProbability: number; calibratedProbability: number; score: number;
  regimeFitness: number | null; modelAgreement: number; freshness: number; anomalyPenalty: number | null; driftPenalty: number; uncertaintyPenalty: number;
  status: 'ELIGIBLE' | 'SUB_OPTIMAL' | 'REJECTED'; rejectionReason?: string;
}
export interface HorizonSurfaceMetrics {
  peakUtility: number; runnerUpUtility: number | null; dominanceMargin: number | null; curvature: number | null;
  horizonConfidenceTier: 'HIGH' | 'MEDIUM' | 'BALANCED'; optimalBand: string[];
  regimeVelocity: number | null; isTransitioning: boolean | null; dataQualityScore: number;
}
export interface HorizonDecisionSnapshot {
  symbol: string; mode: HorizonDecisionMode; category?: DurationSelectUnit;
  decision: { direction: Signal; status: 'EXECUTABLE'; horizon: CandidateHorizon; confidence: number; modelProbability: number; calibratedProbability: number; utilityScore: number; reasons: string[]; };
  horizonRanking: HorizonRankItem[]; surface?: HorizonSurfaceMetrics; speedProfile?: unknown; crossAsset?: unknown; driftProfile?: unknown;
  decisionReason: { selectedHorizon: string; confidence: number; modelProbability: number; calibratedProbability: number; modelConsensus: number; modelAgreementCount: number; modelAgreementTotal: number; regimeFitness: number | null; summary: string; };
  marketRegime: string; anomalyScore: number | null; modelSnapshotId: string; timestamp: number;
}

interface HorizonAnalysisRecord { direction: Signal; probabilityUp: number; probabilityDown: number; confidence: number; }

function finite(name: string, value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`AUTHORITATIVE_HORIZON_VALUE_UNAVAILABLE:${name}`);
  return numeric;
}

function candidateFromOption(option: DurationOption, value: number): CandidateHorizon {
  if (!Number.isFinite(value) || value <= 0 || value < option.min || value > option.max) throw new Error('HORIZON_DURATION_OUTSIDE_LIVE_BOUNDS');
  if (option.unit === 'end-time') throw new Error('END_TIME_HORIZON_NOT_SUPPORTED_FOR_AI_EXECUTION');
  const seconds = option.unit === 't' ? value : Number(durationToSeconds(value, option.unit));
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('HORIZON_DURATION_SECONDS_INVALID');
  const name = option.unit === 't' ? 'Tick' : option.unit === 's' ? 'Second' : option.unit === 'm' ? 'Minute' : option.unit === 'h' ? 'Hour' : 'Day';
  return { value, unit: option.unit, seconds, label: `${value} ${name}${value === 1 ? '' : 's'}`, key: `${value}${option.unit}` };
}

function getLiveCandidateHorizons(durationOptions: DurationOption[], horizonMap: Record<string, unknown>): CandidateHorizon[] {
  const result = new Map<string, CandidateHorizon>();
  if (durationOptions && durationOptions.length) {
    for (const option of durationOptions) {
      if (option.unit === 'end-time') continue;
      for (const key of Object.keys(horizonMap)) {
        if (!key.endsWith(option.unit)) continue;
        const value = Number(key.slice(0, -option.unit.length));
        if (!Number.isFinite(value) || value < option.min || value > option.max) continue;
        result.set(key, candidateFromOption(option, value));
      }
    }
  }
  if (!result.size) {
    for (const key of Object.keys(horizonMap)) {
      const match = key.match(/^(\d+)([tsmhd])$/i);
      if (match) {
        const val = Number(match[1]);
        const unit = match[2].toLowerCase() as 't' | 's' | 'm' | 'h' | 'd';
        if (Number.isFinite(val) && val > 0) {
          const seconds = unit === 't' ? val : Number(durationToSeconds(val, unit));
          const name = unit === 't' ? 'Tick' : unit === 's' ? 'Second' : unit === 'm' ? 'Minute' : unit === 'h' ? 'Hour' : 'Day';
          result.set(key, { value: val, unit, seconds, label: `${val} ${name}${val === 1 ? '' : 's'}`, key });
        }
      }
    }
  }
  if (!result.size) throw new Error('AUTHORITATIVE_HORIZON_OPTIONS_UNAVAILABLE');
  return [...result.values()];
}

export function getEligibleCandidateHorizons(durationOptions?: DurationOption[], categoryFilter?: DurationSelectUnit | 'auto'): CandidateHorizon[] {
  if (!durationOptions?.length) throw new Error('AUTHORITATIVE_DURATION_OPTIONS_UNAVAILABLE');
  const filtered = durationOptions.filter((option) => !categoryFilter || categoryFilter === 'auto' || option.unit === categoryFilter);
  if (!filtered.length) throw new Error('AUTHORITATIVE_DURATION_CATEGORY_UNAVAILABLE');
  return filtered.filter((option) => option.unit !== 'end-time').map((option) => candidateFromOption(option, option.min));
}

export function verifyDataQuality(prices: number[]): { qualityScore: number; isAdequate: boolean } {
  if (!Array.isArray(prices) || prices.length < 5) throw new Error('LIVE_TICK_DATA_INSUFFICIENT');
  if (!prices.every((price) => Number.isFinite(price) && price > 0)) throw new Error('LIVE_TICK_DATA_INVALID');
  const deltas = prices.slice(1).map((price, index) => Math.abs(price - prices[index]));
  if (!deltas.length || deltas.every((delta) => delta === 0)) throw new Error('LIVE_TICK_DATA_NON_MOVING');
  const zeroRatio = deltas.filter((delta) => delta === 0).length / deltas.length;
  return { qualityScore: 1 - zeroRatio, isAdequate: zeroRatio < 1 };
}

export function getHorizonEmpiricalReliability(symbol: string, horizonKey: string): number {
  throw new Error(`HORIZON_EMPIRICAL_RELIABILITY_REQUIRES_AUTHORITATIVE_HISTORY:${symbol}:${horizonKey}`);
}

export function recordHorizonOutcome(params: { symbol: string; horizonKey: string; outcome: 'WIN' | 'LOSS'; profit: number; timestamp: number; modelVersion: string; regime: string; predictedProbability: number; }): void {
  if (!params.modelVersion || !params.regime) throw new Error('HORIZON_OUTCOME_METADATA_REQUIRED');
  if (!Number.isFinite(params.profit) || !Number.isFinite(params.timestamp)) throw new Error('HORIZON_OUTCOME_INVALID');
  const symbol = params.symbol;
  recordModelTradeOutcome({ asset: symbol, horizonKey: params.horizonKey, modelVersion: params.modelVersion, regime: params.regime, predictedProbability: params.predictedProbability, observedOutcome: params.outcome, profit: params.profit, timestamp: params.timestamp });
  evaluateAndTriggerCohortRetraining({ assetSymbol: symbol }).catch(() => {});
}

export function calibrateProbability(): never { throw new Error('CALIBRATION_ARTIFACT_REQUIRED'); }
export function computeExpectedPayoff(): never { throw new Error('LIVE_CONTRACT_ECONOMICS_REQUIRED'); }
export function computeRegimeFitness(): never { throw new Error('AUTHORITATIVE_REGIME_FITNESS_REQUIRED'); }

export function computeModelAgreement(evaluations: Array<{ status: string; signal: Signal | null; confidence: number | null }>, targetDirection: Signal) {
  const available = evaluations.filter((evaluation) => evaluation.status === 'AVAILABLE' && evaluation.signal);
  if (!available.length) throw new Error('AUTHORITATIVE_MODEL_AGREEMENT_UNAVAILABLE');
  const matching = available.filter((evaluation) => evaluation.signal === targetDirection).length;
  return { agreement: matching / available.length, consensusCount: matching, totalAvailable: available.length };
}

function resolveRegimeFitness(primaryEnsemble: ProductionEnsembleResult, enabled: boolean): number | null {
  if (!enabled) return null;
  const probabilities = primaryEnsemble.modelBreakdown?.hmm?.regimeProbabilities;
  if (!probabilities || typeof probabilities !== 'object') throw new Error('AUTHORITATIVE_REGIME_PROBABILITIES_UNAVAILABLE');
  const values = Object.values(probabilities).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  if (!values.length) throw new Error('AUTHORITATIVE_REGIME_PROBABILITIES_UNAVAILABLE');
  return Math.max(...values) * 100;
}

function resolveDriftPenalty(primaryEnsemble: ProductionEnsembleResult, availableModelCount: number): number {
  if (!Number.isInteger(availableModelCount) || availableModelCount <= 0) throw new Error('AUTHORITATIVE_MODEL_COUNT_UNAVAILABLE');
  const breached = primaryEnsemble.drift?.driftBreachedModels;
  if (!Array.isArray(breached)) throw new Error('AUTHORITATIVE_DRIFT_PROFILE_UNAVAILABLE');
  return breached.length / availableModelCount;
}

export function evaluateHorizonDecisionSnapshot(params: { symbol: string; mode: HorizonDecisionMode; categoryFilter?: DurationSelectUnit | 'auto'; requestedDuration?: { value: number; unit: DurationSelectUnit }; primaryEnsemble: ProductionEnsembleResult; durationOptions?: DurationOption[]; prices?: number[]; enforceRequestedDuration?: boolean; }): HorizonDecisionSnapshot {
  const { symbol, mode, categoryFilter, requestedDuration, primaryEnsemble, durationOptions, prices, enforceRequestedDuration } = params;
  if (!symbol) throw new Error('SYMBOL_REQUIRED');
  const quality = verifyDataQuality(prices || []);
  const breakdown = primaryEnsemble.modelBreakdown as Record<string, any>;
  const regimeEnabled = breakdown?.hmm?.status === 'AVAILABLE';
  const anomalyEnabled = breakdown?.isolation_forest?.status === 'AVAILABLE';
  const regimeStatusValid = breakdown?.hmm?.status === 'AVAILABLE' || breakdown?.hmm?.status === 'DISABLED';
  const anomalyStatusValid = breakdown?.isolation_forest?.status === 'AVAILABLE' || breakdown?.isolation_forest?.status === 'DISABLED';
  if (!regimeStatusValid) throw new Error('REGIME_MODEL_RUNTIME_STATE_INCONSISTENT');
  if (!anomalyStatusValid) throw new Error('ANOMALY_MODEL_RUNTIME_STATE_INCONSISTENT');
  const anomalyScore = anomalyEnabled ? finite('anomalyScore', primaryEnsemble.anomalyScore) : null;
  if (!primaryEnsemble.strategyGate.accepted) throw new Error('SIGNAL_UNAVAILABLE:STRATEGY_GATE_BLOCKED');
  if (regimeEnabled && !primaryEnsemble.marketRegime) throw new Error('AUTHORITATIVE_REGIME_UNAVAILABLE');

  if (!breakdown?.horizons || typeof breakdown.horizons !== 'object') throw new Error('AUTHORITATIVE_HORIZON_ANALYSIS_UNAVAILABLE');

  const candidates = getLiveCandidateHorizons(durationOptions || [], breakdown.horizons as Record<string, unknown>);
  let chosen: CandidateHorizon;
  if (mode === 'manual' || enforceRequestedDuration) {
    if (!requestedDuration) throw new Error('REQUESTED_HORIZON_REQUIRED');
    const key = `${requestedDuration.value}${requestedDuration.unit}`;
    chosen = candidates.find((item) => item.key === key) || (() => { throw new Error('REQUESTED_HORIZON_NOT_IN_LIVE_ANALYSIS'); })();
  } else {
    const ranked = candidates.map((candidate) => ({ candidate, analysis: breakdown.horizons[candidate.key] as HorizonAnalysisRecord | undefined })).filter((entry) => entry.analysis);
    if (!ranked.length) throw new Error('AUTHORITATIVE_HORIZON_RANKING_UNAVAILABLE');
    chosen = ranked.map((entry) => ({ candidate: entry.candidate, confidence: finite(`${entry.candidate.key}.confidence`, entry.analysis!.confidence) })).sort((a, b) => b.confidence - a.confidence)[0]?.candidate;
    if (!chosen) throw new Error('AUTHORITATIVE_HORIZON_RANKING_UNAVAILABLE');
  }

  const availableModelCount = primaryEnsemble.evaluations.filter((evaluation) => evaluation.status === 'AVAILABLE').length;
  const agreement = computeModelAgreement(primaryEnsemble.evaluations, primaryEnsemble.direction);
  const regimeFitness = resolveRegimeFitness(primaryEnsemble, regimeEnabled);
  const driftPenalty = resolveDriftPenalty(primaryEnsemble, availableModelCount);
  const chosenAnalysis = breakdown.horizons[chosen.key] as HorizonAnalysisRecord | undefined;
  if (!chosenAnalysis) throw new Error(`AUTHORITATIVE_HORIZON_DATA_MISSING:${chosen.key}`);
  const chosenConfidence = finite(`${chosen.key}.confidence`, chosenAnalysis.confidence);
  const chosenProbabilityUp = finite(`${chosen.key}.probabilityUp`, chosenAnalysis.probabilityUp);
  const chosenProbabilityDown = finite(`${chosen.key}.probabilityDown`, chosenAnalysis.probabilityDown);
  const chosenDirection = chosenAnalysis.direction;
  if (!['RISE', 'FALL'].includes(chosenDirection)) throw new Error(`AUTHORITATIVE_HORIZON_DIRECTION_INVALID:${chosen.key}`);
  if (Math.abs((chosenProbabilityUp + chosenProbabilityDown) - 100) > 0.25) throw new Error(`AUTHORITATIVE_HORIZON_PROBABILITIES_INVALID:${chosen.key}`);

  const horizonRanking: HorizonRankItem[] = candidates.map((candidate) => {
    const analysis = breakdown.horizons[candidate.key] as HorizonAnalysisRecord | undefined;
    if (!analysis) throw new Error(`AUTHORITATIVE_HORIZON_DATA_MISSING:${candidate.key}`);
    const confidence = finite(`${candidate.key}.confidence`, analysis.confidence);
    const probabilityUp = finite(`${candidate.key}.probabilityUp`, analysis.probabilityUp);
    const probabilityDown = finite(`${candidate.key}.probabilityDown`, analysis.probabilityDown);
    const direction = analysis.direction;
    if (!['RISE', 'FALL'].includes(direction)) throw new Error(`AUTHORITATIVE_HORIZON_DIRECTION_INVALID:${candidate.key}`);
    if (Math.abs((probabilityUp + probabilityDown) - 100) > 0.25) throw new Error(`AUTHORITATIVE_HORIZON_PROBABILITIES_INVALID:${candidate.key}`);
    const modelAgreement = computeModelAgreement(primaryEnsemble.evaluations, direction).agreement * 100;
    const modelProbability = Math.max(probabilityUp, probabilityDown);
    const score = Math.sqrt(modelProbability * modelAgreement) * Math.sqrt(quality.qualityScore);
    const uncertaintyPenalty = 1 - modelAgreement / 100;
    return {
      value: candidate.value, unit: candidate.unit, seconds: candidate.seconds, label: candidate.label, key: candidate.key,
      direction, modelProbability, calibratedProbability: modelProbability, score, regimeFitness, modelAgreement,
      freshness: quality.qualityScore * 100, anomalyPenalty: anomalyScore, driftPenalty, uncertaintyPenalty, status: 'ELIGIBLE' as const,
    };
  }).sort((a, b) => b.score - a.score);

  const selected = horizonRanking.find((item) => item.key === chosen.key);
  if (!selected) throw new Error('AUTHORITATIVE_HORIZON_SELECTION_UNAVAILABLE');
  const now = Date.now();
  const regimeSummary = regimeEnabled ? primaryEnsemble.marketRegime : 'disabled';
  const summary = `${chosen.label} selected · ${chosenDirection} · Live model probability ${chosenConfidence.toFixed(1)}% · Regime ${regimeSummary}`;
  const modelProbability = Math.max(chosenProbabilityUp, chosenProbabilityDown);
  return {
    symbol,
    mode,
    category: categoryFilter !== 'auto' ? categoryFilter : undefined,
    decision: { direction: chosenDirection, status: 'EXECUTABLE', horizon: chosen, confidence: chosenConfidence, modelProbability, calibratedProbability: modelProbability, utilityScore: selected.score, reasons: [summary] },
    horizonRanking,
    surface: {
      peakUtility: horizonRanking[0].score,
      runnerUpUtility: horizonRanking[1]?.score ?? null,
      dominanceMargin: horizonRanking[1] ? horizonRanking[0].score - horizonRanking[1].score : null,
      curvature: null,
      horizonConfidenceTier: chosenConfidence >= 90 ? 'HIGH' : chosenConfidence >= 75 ? 'MEDIUM' : 'BALANCED',
      optimalBand: [chosen.label], regimeVelocity: null, isTransitioning: null, dataQualityScore: quality.qualityScore,
    },
    decisionReason: { selectedHorizon: chosen.label, confidence: chosenConfidence, modelProbability, calibratedProbability: modelProbability, modelConsensus: Number((agreement.agreement * 100).toFixed(1)), modelAgreementCount: agreement.consensusCount, modelAgreementTotal: agreement.totalAvailable, regimeFitness, summary },
    marketRegime: regimeEnabled ? primaryEnsemble.marketRegime : 'REGIME_MODEL_DISABLED', anomalyScore, modelSnapshotId: `HDE-${symbol}-${chosen.key}-${now}`, timestamp: now,
  };
}
