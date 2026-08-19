/**
 * Browser-safe contract for the Multi-Model Layer UI.
 *
 * Missing native-runtime evidence is represented explicitly as null instead
 * of being replaced with fabricated numeric values.
 */

export type MultiModelSignal = 'RISE' | 'FALL';

export interface MultiModelAssetContextView {
  symbol: string;
  assetCategory: number;
  assetClass: string;
  marketType: string;
  assetLabel: string;
  duration: {
    value: number;
    unit: 't' | 's' | 'm' | 'h' | 'd';
    seconds: number;
    label: string;
    band: 'tick' | 'seconds' | 'minutes' | 'hours' | 'days';
  };
  tickCount: number | null;
  requiredContextTicks: number;
  qualityScore: number;
  confidenceGateThreshold: number;
  strategyMode: 'CLASSIC' | 'PRO' | 'AI';
  accepted: boolean;
  rationale: string[];
}

export interface MultiModelStrategyGateView {
  accepted: boolean;
  confidenceGateThreshold: number;
  riskTier: 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH';
  action: 'EXECUTE_CALL' | 'EXECUTE_PUT' | 'HOLD_NO_SIGNAL';
  reasons: string[];
}

export interface MultiModelEvaluationView {
  modelKey: string;
  modelName: string;
  family: 'tabular' | 'sequential' | string;
  runtimeMode?: string;
  probabilityUp: number | null;
  probabilityDown: number | null;
  signal: MultiModelSignal | null;
  vote?: MultiModelSignal | null;
  confidence: number | null;
  dynamicWeight?: number | null;
  weight?: number | null;
  details?: string;
}

export interface MultiModelRegimeView {
  primaryRegime?: string;
  regimeName?: string;
  regimeState?: number | null;
  probabilities?: Record<string, number>;
  tradingGuidance?: string;
}

export interface MultiModelAnomalyView {
  anomalyScore?: number | null;
  spikeSeverity?: string;
  isAbnormal?: boolean;
  confidenceAdjustmentFactor?: number | null;
  actionNote?: string;
}

export interface MultiModelFusionView {
  directionScore?: number | null;
  direction?: MultiModelSignal | null;
  regimeState?: string | null;
  anomalyRisk?: 'LOW' | 'MODERATE' | 'HIGH' | 'UNKNOWN' | string;
  finalCompositeScore?: number | null;
  confidenceGateThreshold?: number | null;
  gatePassed?: boolean | null;
  action?: 'EXECUTE_CALL' | 'EXECUTE_PUT' | 'HOLD_NO_SIGNAL' | string | null;
}

export interface MultiModelCalibrationView {
  rawProbability?: number | null;
  calibratedProbability?: number | null;
  plattScaledProbability?: number | null;
  isotonicProbability?: number | null;
  expectedCalibrationError?: number | null;
  calibrationMethod?: string;
  method?: string;
  confidenceReductionPct?: number | null;
  calibrationBins?: Array<{
    binRange: string;
    rawAvg: number;
    calibratedAvg: number;
    accuracy: number;
    sampleCount: number;
  }>;
}

export interface MultiModelEvaluationResult {
  symbol: string;
  direction: MultiModelSignal;
  probUp: number;
  probDown: number;
  confidence: number;
  marketRegime?: string;
  anomalyScore?: number | null;
  assetContext?: MultiModelAssetContextView;
  strategyGate?: MultiModelStrategyGateView;
  modelBreakdown?: Record<string, any>;
  evaluations: MultiModelEvaluationView[];
  regime?: MultiModelRegimeView;
  anomaly?: MultiModelAnomalyView;
  drift?: {
    modelWeights?: Record<string, number>;
    recentAccuracies?: Record<string, number | null>;
    driftStatus?: string;
    topPerformingModel?: string | null;
  };
  fusion?: MultiModelFusionView;
  calibration?: MultiModelCalibrationView;
  features?: unknown;
  timestamp?: number;
}
