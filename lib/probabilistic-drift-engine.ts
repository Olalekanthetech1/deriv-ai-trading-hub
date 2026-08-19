/**
 * Probabilistic Calibration & Statistical Drift Engine.
 * All metrics are computed only from supplied realized outcomes.
 */

export type DriftState = 'DRIFT_NONE' | 'DRIFT_WATCH' | 'DRIFT_ELEVATED' | 'DRIFT_SEVERE';

export interface ModelOutcomeRecord {
  asset: string;
  horizonKey: string;
  modelVersion: string;
  regime: string;
  predictedProbability: number;
  observedOutcome: 'WIN' | 'LOSS';
  profit: number;
  timestamp: number;
}

export interface CalibrationMetrics {
  sampleSize: number;
  meanPredictedProb: number;
  realizedWinRate: number;
  calibrationGap: number;
  brierScore: number;
  logLoss: number;
  standardError: number;
  statisticalSignificance: number;
  isStatisticallySignificant: boolean;
}

export interface DriftDiagnosticProfile {
  asset: string;
  modelVersion: string;
  driftState: DriftState;
  driftPersistenceCycles: number;
  overallMetrics: CalibrationMetrics;
  regimeSpecificGap?: number;
  horizonSpecificGap?: number;
  boundedUncertaintyPenalty: number;
  boundedDriftPenalty: number;
  recommendedAction: 'NORMAL_OPERATION' | 'INCREASE_UNCERTAINTY' | 'TIGHTEN_RISK' | 'RESTRICT_EXECUTION_ADVISORY';
  diagnosticSummary: string;
  timestamp: number;
}

const globalOutcomeHistory: ModelOutcomeRecord[] = [];
const assetDriftStateTracker = new Map<string, {
  driftState: DriftState;
  consecutiveDriftCycles: number;
  lastUpdated: number;
}>();

export function recordModelTradeOutcome(record: ModelOutcomeRecord): void {
  if (!record.asset || !record.horizonKey || !record.modelVersion || !record.regime) throw new Error('DRIFT_OUTCOME_METADATA_REQUIRED');
  if (!Number.isFinite(record.predictedProbability) || record.predictedProbability < 0 || record.predictedProbability > 1) throw new Error('DRIFT_PREDICTED_PROBABILITY_INVALID');
  if (!Number.isFinite(record.profit) || !Number.isFinite(record.timestamp)) throw new Error('DRIFT_OUTCOME_NUMERIC_DATA_INVALID');
  globalOutcomeHistory.unshift(record);
  if (globalOutcomeHistory.length > 500) globalOutcomeHistory.pop();
}

export function calculateCalibrationMetrics(records: ModelOutcomeRecord[]): CalibrationMetrics {
  const N = records.length;
  if (N === 0) throw new Error('DRIFT_CALIBRATION_DATA_UNAVAILABLE');

  let sumPred = 0;
  let wins = 0;
  let sumBrier = 0;
  let sumLogLoss = 0;

  for (const record of records) {
    const p = Number(record.predictedProbability);
    if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('DRIFT_PREDICTED_PROBABILITY_INVALID');
    const y = record.observedOutcome === 'WIN' ? 1 : 0;
    sumPred += p;
    if (y === 1) wins++;
    sumBrier += Math.pow(p - y, 2);
    const logLossComp = -(y * Math.log(Math.max(Number.EPSILON, p)) + (1 - y) * Math.log(Math.max(Number.EPSILON, 1 - p)));
    if (!Number.isFinite(logLossComp)) throw new Error('DRIFT_LOG_LOSS_INVALID');
    sumLogLoss += logLossComp;
  }

  const meanPred = sumPred / N;
  const realizedRate = wins / N;
  const calibrationGap = meanPred - realizedRate;
  const brierScore = sumBrier / N;
  const logLoss = sumLogLoss / N;
  const standardError = Math.sqrt((realizedRate * (1 - realizedRate)) / N);
  const zScore = standardError > 0 ? Math.abs(calibrationGap) / standardError : 0;
  const samplePower = Math.min(1.0, Math.max(0.0, (N - 5) / 20));
  const zSig = Math.min(1.0, Math.max(0.0, (zScore - 1.0) / 1.5));
  const statisticalSignificance = Number((samplePower * zSig).toFixed(3));

  return {
    sampleSize: N,
    meanPredictedProb: Number(meanPred.toFixed(3)),
    realizedWinRate: Number(realizedRate.toFixed(3)),
    calibrationGap: Number(calibrationGap.toFixed(3)),
    brierScore: Number(brierScore.toFixed(4)),
    logLoss: Number(logLoss.toFixed(3)),
    standardError: Number(standardError.toFixed(4)),
    statisticalSignificance,
    isStatisticallySignificant: statisticalSignificance >= 0.60 && N >= 12,
  };
}

export function evaluateStatisticalDrift(params: { asset: string; horizonKey?: string; regime?: string; modelVersion?: string; }): DriftDiagnosticProfile {
  const { asset, horizonKey, regime } = params;
  if (!asset) throw new Error('DRIFT_ASSET_REQUIRED');

  const now = Date.now();
  const assetRecords = globalOutcomeHistory.filter((record) => record.asset === asset).slice(0, 50);
  const overallMetrics = calculateCalibrationMetrics(assetRecords);

  const versions = [...new Set(assetRecords.map((record) => record.modelVersion).filter(Boolean))];
  const modelVersion = params.modelVersion?.trim() || (versions.length === 1 ? versions[0] : undefined);
  if (!modelVersion) throw new Error('DRIFT_MODEL_VERSION_UNAVAILABLE');

  let regimeGap: number | undefined;
  if (regime) {
    const regimeRecords = assetRecords.filter((record) => record.regime === regime);
    if (regimeRecords.length > 0) regimeGap = calculateCalibrationMetrics(regimeRecords).calibrationGap;
  }

  let horizonGap: number | undefined;
  if (horizonKey) {
    const horizonRecords = assetRecords.filter((record) => record.horizonKey === horizonKey);
    if (horizonRecords.length > 0) horizonGap = calculateCalibrationMetrics(horizonRecords).calibrationGap;
  }

  const stateEntry = assetDriftStateTracker.get(asset) || {
    driftState: 'DRIFT_NONE',
    consecutiveDriftCycles: 0,
    lastUpdated: now,
  };

  const gap = Math.abs(overallMetrics.calibrationGap);
  const sig = overallMetrics.statisticalSignificance;
  const N = overallMetrics.sampleSize;

  let candidateState: DriftState = 'DRIFT_NONE';
  if (N >= 20 && gap >= 0.14 && sig >= 0.75) candidateState = 'DRIFT_SEVERE';
  else if (N >= 12 && gap >= 0.08 && sig >= 0.50) candidateState = 'DRIFT_ELEVATED';
  else if (N >= 6 && gap >= 0.05) candidateState = 'DRIFT_WATCH';

  let activeState = stateEntry.driftState;
  let cycles = stateEntry.consecutiveDriftCycles;

  if (candidateState === activeState) {
    cycles = Math.min(20, cycles + 1);
  } else if (candidateState === 'DRIFT_SEVERE' || candidateState === 'DRIFT_ELEVATED' || candidateState === 'DRIFT_WATCH') {
    activeState = candidateState;
    cycles = 1;
  } else if (cycles <= 1) {
    activeState = candidateState;
    cycles = 1;
  } else {
    cycles--;
  }

  assetDriftStateTracker.set(asset, { driftState: activeState, consecutiveDriftCycles: cycles, lastUpdated: now });

  const persistenceFactor = cycles / 5;
  const rawUncertainty = (gap * 0.40 * sig * Math.min(1, persistenceFactor)) +
    (Math.max(0, overallMetrics.brierScore - overallMetrics.sampleSize / Math.max(1, overallMetrics.sampleSize) * 0.15) * 0.30);
  const boundedUncertaintyPenalty = Math.max(0, Math.min(0.25, Number(rawUncertainty.toFixed(4))));
  const rawDriftPen = activeState === 'DRIFT_SEVERE' ? 0.18 : activeState === 'DRIFT_ELEVATED' ? 0.09 : activeState === 'DRIFT_WATCH' ? 0.03 : 0;
  const boundedDriftPenalty = Math.max(0, Math.min(0.20, Number((rawDriftPen * sig).toFixed(4))));

  const recommendedAction: DriftDiagnosticProfile['recommendedAction'] = activeState === 'DRIFT_SEVERE'
    ? 'RESTRICT_EXECUTION_ADVISORY'
    : activeState === 'DRIFT_ELEVATED'
      ? 'TIGHTEN_RISK'
      : activeState === 'DRIFT_WATCH'
        ? 'INCREASE_UNCERTAINTY'
        : 'NORMAL_OPERATION';

  return {
    asset,
    modelVersion,
    driftState: activeState,
    driftPersistenceCycles: cycles,
    overallMetrics,
    regimeSpecificGap: regimeGap,
    horizonSpecificGap: horizonGap,
    boundedUncertaintyPenalty,
    boundedDriftPenalty,
    recommendedAction,
    diagnosticSummary: `${asset} ${modelVersion} drift=${activeState}; calibrationGap=${overallMetrics.calibrationGap}; brier=${overallMetrics.brierScore}; samples=${N}.`,
    timestamp: now,
  };
}
