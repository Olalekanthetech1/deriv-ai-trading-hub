import { EngineeredTickFeatures, extractTickFeatures, featureObjToArray, TickPoint } from './ml-feature-extractor';
import { buildFeatureSequence } from './ml-feature-dataset';
import { getMlModelDefinition, getPredictiveModelDefinitions, getProductionCandidateDefinitions, type MlModelKey } from './ml-model-registry';
import { mlRuntimeClient } from './ml-runtime-client';
import { evaluateSignalStrategyGate, resolveAssetAwareSignalContext, type AssetAwareSignalContext, type SignalStrategyGate } from './asset-context';
import { resolveProductionModels, resolveAndMaterializeProductionModel } from './production-model-resolver';
import { getMlRuntimeSchemaContract } from './ml-runtime-schema';
import { getMlEnsembleAnalysisRuntimeConfig } from './ops-runtime-config';

export type Signal = 'RISE' | 'FALL';
export type ModelStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'DISABLED';
export type EnsembleModelEvaluation = {
  modelKey: string; modelName: string; modelId: string | null; family: 'tabular' | 'sequential'; status: ModelStatus;
  probabilityUp: number | null; probabilityDown: number | null; signal: Signal | null; confidence: number | null;
  dynamicWeight: number | null; runtimeMode: string; details: string; validation: any;
};
export interface ProductionEnsembleResult {
  symbol: string; direction: Signal; probUp: number; probDown: number; confidence: number; marketRegime: string;
  anomalyScore: number | null; assetContext: AssetAwareSignalContext; strategyGate: SignalStrategyGate; features: EngineeredTickFeatures;
  evaluations: EnsembleModelEvaluation[]; modelBreakdown: Record<string, any>; regime: any; anomaly: any; drift: any; calibration: any; fusion: any; timestamp: number;
}
type AvailableEvaluation = {
  modelKey: MlModelKey; modelName: string; modelId: string | null; family: 'tabular' | 'sequential'; status: 'AVAILABLE';
  probabilityUp: number; probabilityDown: number; signal: Signal; confidence: number; dynamicWeight: number; qualityScore: number;
  championRank: number; subModelsCount: number; driftBreached: boolean; regimeMultiplier: number; regimeReason: string; runtimeMode: string; details: string; validation: any;
};
function finiteProbability(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null; }
function requireValidationWeight(validation: any, qualityScore: number | null | undefined): number {
  if (qualityScore != null && Number.isFinite(qualityScore) && qualityScore > 0) return qualityScore * 100;
  if (!validation || typeof validation !== 'object') throw new Error('MODEL_VALIDATION_METRICS_UNAVAILABLE');
  const accuracy = Number(validation.accuracy ?? validation.overallAccuracy ?? validation.winRate);
  const logLoss = Number(validation.logLoss ?? validation.overallLogLoss);
  const f1 = Number(validation.f1 ?? validation.overallF1);
  if (Number.isFinite(accuracy) && accuracy > 0 && Number.isFinite(logLoss) && logLoss >= 0) { const weight = (accuracy / (1 + logLoss)) * 100; if (Number.isFinite(weight) && weight > 0) return weight; }
  if (Number.isFinite(accuracy) && accuracy > 0) return accuracy > 1 ? accuracy : accuracy * 100;
  if (Number.isFinite(f1) && f1 > 0) return f1 > 1 ? f1 : f1 * 100;
  throw new Error('MODEL_VALIDATION_METRICS_UNAVAILABLE');
}
function applyRegimeRouting(baseWeight: number, modelKey: string, marketRegime: string, accuracyScore: number, brierScore: number): { routedWeight: number; regimeMultiplier: number; regimeReason: string } {
  if (!Number.isFinite(accuracyScore) || !Number.isFinite(brierScore)) throw new Error('MODEL_REGIME_ROUTING_METRICS_UNAVAILABLE');
  let multiplier = 1.0; let reason = 'Standard regime routing'; const regime = String(marketRegime).toUpperCase(); const calibrationReliability = 1 - Math.min(1, brierScore);
  if (regime.includes('TREND_STRONG') || regime.includes('TREND')) { if (accuracyScore >= 0.60) { multiplier = 1.30; reason = 'High-accuracy model routed for TREND_STRONG regime'; } else if (accuracyScore < 0.52) { multiplier = 0.80; reason = 'Low-accuracy model dampened for TREND_STRONG regime'; } }
  else if (regime.includes('CHOP') || regime.includes('NOISE') || regime.includes('RANGE')) { if (calibrationReliability >= 0.70) { multiplier = 1.35; reason = 'Low-Brier model routed for NOISE_CHOP regime'; } else { multiplier = 0.75; reason = 'Higher-Brier model dampened for NOISE_CHOP regime'; } }
  else if (regime.includes('VOLATILITY') || regime.includes('BURST') || regime.includes('EXPANSION')) { if (['xgboost', 'lightgbm', 'catboost'].includes(modelKey)) { multiplier = 1.25; reason = 'Gradient boosted tree routed for VOLATILITY_EXPANSION'; } }
  return { routedWeight: Number((baseWeight * multiplier).toFixed(4)), regimeMultiplier: multiplier, regimeReason: reason };
}

export async function evaluateProductionEnsemble(ticks: TickPoint[], options: { symbol?: string; durationSecs?: number; assetCategory?: number; durationValue?: number; durationUnit?: 't' | 's' | 'm' | 'h' | 'd'; assetClass?: string; marketType?: string; requiredContextTicks?: number; } = {}): Promise<ProductionEnsembleResult> {
  const symbol = options.symbol?.trim();
  if (!symbol) throw new Error('SYMBOL_REQUIRED');
  const durationSecs = options.durationSecs;
  if (!Number.isFinite(durationSecs) || Number(durationSecs) <= 0) throw new Error('DURATION_REQUIRED');
  const durationValue = Number(options.durationValue); const durationUnit = options.durationUnit;
  if (!Number.isSafeInteger(durationValue) || durationValue <= 0 || !durationUnit) throw new Error('DURATION_METADATA_REQUIRED');
  if (!Number.isFinite(options.assetCategory)) throw new Error('ASSET_CATEGORY_REQUIRED');
  if (!options.assetClass || !options.marketType) throw new Error('ASSET_CONTEXT_REQUIRED');
  if (!Number.isInteger(options.requiredContextTicks) || Number(options.requiredContextTicks) <= 0) throw new Error('ANALYSIS_CONTEXT_TICKS_REQUIRED');
  if (!Array.isArray(ticks) || ticks.length < Number(options.requiredContextTicks)) throw new Error('LIVE_TICK_CONTEXT_INSUFFICIENT');

  const ensembleConfig = await getMlEnsembleAnalysisRuntimeConfig();
  if (ensembleConfig.source !== 'database') throw new Error('ML_ENSEMBLE_RUNTIME_CONFIG_UNAVAILABLE');

  const assetCategory = Number(options.assetCategory);
  const features = extractTickFeatures(ticks, { symbol, contractDurationSecs: Number(durationSecs), assetCategoryNum: assetCategory });
  const featureVector = featureObjToArray(features);
  const featureSequence = await buildFeatureSequence(ticks, { symbol, durationSecs: Number(durationSecs), assetCategory });
  const assetContext = resolveAssetAwareSignalContext({ symbol, durationValue, durationUnit, durationSeconds: Number(durationSecs), assetCategory, assetClass: options.assetClass, marketType: options.marketType, tickCount: ticks.length, requiredContextTicks: Number(options.requiredContextTicks) });

  const predictiveModels = getPredictiveModelDefinitions(); const decisionModels = getProductionCandidateDefinitions();
  const productionModels = await resolveProductionModels(symbol, durationValue, durationUnit);
  const productionModelKeys = decisionModels.map((definition) => definition.key).filter((key) => Boolean(productionModels[key]));
  const productionPredictiveModelKeys = productionModelKeys.filter((key) => predictiveModels.some((definition) => definition.key === key));
  if (!productionPredictiveModelKeys.length) throw new Error('NO_VALIDATED_TRAINED_MODELS_AVAILABLE');
  if (ensembleConfig.enableRegimeModel && !productionModelKeys.includes('hmm')) throw new Error('AUTHORITATIVE_REGIME_MODEL_UNAVAILABLE');
  if (ensembleConfig.enableAnomalyModel && !productionModelKeys.includes('isolation_forest')) throw new Error('AUTHORITATIVE_ANOMALY_MODEL_UNAVAILABLE');

  const activeEnsembleKeys = productionModelKeys.filter((key) => {
    if (key === 'hmm') return ensembleConfig.enableRegimeModel;
    if (key === 'isolation_forest') return ensembleConfig.enableAnomalyModel;
    if (['tcn', 'lstm', 'transformer'].includes(key)) return ensembleConfig.enableDeepSequentialModels;
    return true;
  });
  const materialized = await Promise.all(activeEnsembleKeys.map(async (key) => { const model = productionModels[key]; if (!model) throw new Error(`PRODUCTION_MODEL_NOT_RESOLVED:${key}`); const artifact = await resolveAndMaterializeProductionModel(model); return [key, { ...model, artifactPath: artifact.path, artifactSha256: artifact.sha256, artifactByteSize: artifact.byteSize }] as const; }));
  const governedProductionModels = Object.fromEntries(materialized);

  for (const model of Object.values(governedProductionModels) as any[]) {
    const horizonMetrics = model?.validation?.horizonMetrics;
    if (model?.isMultiHorizon && (!horizonMetrics || typeof horizonMetrics !== 'object' || Object.keys(horizonMetrics).length === 0)) throw new Error(`AUTHORITATIVE_HORIZON_METRICS_UNAVAILABLE:${model.modelId}`);
    if (model?.isMultiHorizon && !Object.prototype.hasOwnProperty.call(horizonMetrics, `${durationValue}${durationUnit}`)) throw new Error(`AUTHORITATIVE_HORIZON_METRIC_MISSING:${model.modelId}:${durationValue}${durationUnit}`);
  }

  const schemaContract = await getMlRuntimeSchemaContract({ durationValue, durationUnit });
  const remote = await mlRuntimeClient.sendCommand('predict_ensemble', { symbol, durationSecs: Number(durationSecs), durationValue, durationUnit, assetCategory, featureVector, featureSequence, modelTypes: activeEnsembleKeys, productionModels: governedProductionModels, schemaContract });
  if (!remote?.success || !remote.models) throw new Error('NATIVE_ML_ENSEMBLE_UNAVAILABLE');

  const hmm = ensembleConfig.enableRegimeModel ? remote.models.hmm : null;
  const iso = ensembleConfig.enableAnomalyModel ? remote.models.isolation_forest : null;
  if (ensembleConfig.enableRegimeModel) {
    if (hmm?.success !== true) throw new Error(`AUTHORITATIVE_REGIME_MODEL_UNAVAILABLE:${String(hmm?.error || 'UNKNOWN')}`);
    if (!String(hmm.primaryRegime || '').trim()) throw new Error('AUTHORITATIVE_REGIME_UNAVAILABLE');
  }
  if (ensembleConfig.enableAnomalyModel && iso?.success !== true) throw new Error(`AUTHORITATIVE_ANOMALY_MODEL_UNAVAILABLE:${String(iso?.error || 'UNKNOWN')}`);

  const marketRegime = ensembleConfig.enableRegimeModel ? String(hmm.primaryRegime).trim() : 'REGIME_MODEL_DISABLED';

  const evaluations = predictiveModels.map((definition) => {
    const result = remote.models[definition.key]; const governedModel = governedProductionModels[definition.key]; const selectedForProduction = Boolean(governedModel);
    const up = result?.success ? finiteProbability(result.probabilityUp) : null; const down = result?.success ? finiteProbability(result.probabilityDown) : null;
    const valid = selectedForProduction && up !== null && down !== null && Math.abs((up + down) - 100) < 0.25;
    const validationMetrics = result?.validation || governedModel?.validation || null; const baseWeight = valid ? requireValidationWeight(validationMetrics, governedModel?.qualityScore) : null;
    const routing = valid && baseWeight !== null ? applyRegimeRouting(baseWeight, definition.key, marketRegime, Number(governedModel?.accuracyScore), Number(governedModel?.brierScore)) : null;
    const dynamicWeight = routing?.routedWeight ?? null; if (valid && dynamicWeight === null) throw new Error(`MODEL_WEIGHT_UNAVAILABLE:${definition.key}`);
    return { modelKey: definition.key, modelName: definition.displayName, family: definition.family as 'tabular' | 'sequential', modelId: governedModel?.modelId || null, status: valid ? ('AVAILABLE' as const) : ('UNAVAILABLE' as const), probabilityUp: valid ? up : null, probabilityDown: valid ? down : null, signal: valid ? (up! >= down! ? ('RISE' as const) : ('FALL' as const)) : null, confidence: valid ? Math.max(up!, down!) : null, dynamicWeight, qualityScore: governedModel?.qualityScore ?? null, championRank: governedModel?.championRank ?? null, subModelsCount: governedModel?.subModels?.length ?? 0, driftBreached: governedModel?.driftBreached ?? false, regimeMultiplier: routing?.regimeMultiplier ?? null, regimeReason: routing?.regimeReason ?? (valid ? 'REGIME_MODEL_DISABLED' : 'MODEL_UNAVAILABLE'), runtimeMode: valid ? 'Native Python trained production artifact' : 'Unavailable — no promoted production artifact', details: valid ? `${String(result.engine || 'Native Python trained model')} · ${assetContext.assetLabel} · Q-Score: ${governedModel?.qualityScore} · Rank #${governedModel?.championRank} · ${assetContext.duration.label}` : String(result?.error || (!selectedForProduction ? 'MODEL_NOT_PROMOTED' : 'MODEL_UNAVAILABLE')), validation: validationMetrics };
  });

  const available = evaluations.filter((evaluation): evaluation is typeof evaluation & AvailableEvaluation => evaluation.status === 'AVAILABLE' && evaluation.probabilityUp !== null && evaluation.probabilityDown !== null && evaluation.dynamicWeight !== null && evaluation.signal !== null && evaluation.modelId !== null && evaluation.qualityScore !== null && evaluation.regimeMultiplier !== null) as AvailableEvaluation[];
  if (!available.length) { const error = new Error('SIGNAL_UNAVAILABLE:VALIDATED_TRAINED_MODELS'); (error as any).modelBreakdown = Object.fromEntries(evaluations.map((evaluation) => [evaluation.modelKey, evaluation])); throw error; }
  const totalWeight = available.reduce((sum, evaluation) => sum + evaluation.dynamicWeight, 0); if (!Number.isFinite(totalWeight) || totalWeight <= 0) throw new Error('MODEL_WEIGHTS_INVALID');
  const probUp = available.reduce((sum, evaluation) => sum + evaluation.probabilityUp * evaluation.dynamicWeight, 0) / totalWeight; const probDown = 100 - probUp; const direction: Signal = probUp >= probDown ? 'RISE' : 'FALL'; const confidence = Math.max(probUp, probDown);
  const isoScore = ensembleConfig.enableAnomalyModel ? finiteProbability(Number(iso.anomalyScore) * 100) : null;
  if (ensembleConfig.enableAnomalyModel && isoScore === null) throw new Error('AUTHORITATIVE_ANOMALY_SCORE_UNAVAILABLE');
  const anomalyRisk = ensembleConfig.enableAnomalyModel ? (Number(iso.anomalyScore) >= 0.7 ? 'HIGH' : Number(iso.anomalyScore) >= 0.4 ? 'MODERATE' : 'LOW') : null;
  const strategyGate = evaluateSignalStrategyGate(assetContext, confidence, available.length, anomalyRisk, direction);

  const modelBreakdown: Record<string, any> = Object.fromEntries(evaluations.map((evaluation) => [evaluation.modelKey, { modelName: evaluation.modelName, runtimeMode: evaluation.runtimeMode, status: evaluation.status, vote: evaluation.signal, confidence: evaluation.confidence, probabilityUp: evaluation.probabilityUp, probabilityDown: evaluation.probabilityDown, weight: evaluation.dynamicWeight, qualityScore: evaluation.qualityScore, championRank: evaluation.championRank, subModelsCount: evaluation.subModelsCount, driftBreached: evaluation.driftBreached, regimeMultiplier: evaluation.regimeMultiplier, regimeReason: evaluation.regimeReason, details: evaluation.details, validation: evaluation.validation }]));
  modelBreakdown.hmm = ensembleConfig.enableRegimeModel
    ? { modelName: getMlModelDefinition('hmm')?.displayName, status: 'AVAILABLE', primaryRegime: hmm.primaryRegime, regimeState: hmm.regimeState, regimeProbabilities: hmm.regimeProbabilities, details: `${hmm.engine || 'Native trained GaussianHMM'} · ${assetContext.assetLabel}` }
    : { modelName: getMlModelDefinition('hmm')?.displayName, status: 'DISABLED', primaryRegime: null, regimeState: null, regimeProbabilities: null, details: 'Regime model disabled by persisted runtime configuration.' };
  modelBreakdown.isolation_forest = ensembleConfig.enableAnomalyModel
    ? { modelName: getMlModelDefinition('isolation_forest')?.displayName, status: 'AVAILABLE', anomalyScore: iso.anomalyScore, isAnomaly: Boolean(iso.isAnomaly), details: `${iso.engine || 'Native trained IsolationForest'} · ${assetContext.assetLabel}` }
    : { modelName: getMlModelDefinition('isolation_forest')?.displayName, status: 'DISABLED', anomalyScore: null, isAnomaly: null, details: 'Anomaly model disabled by persisted runtime configuration.' };
  const remoteHorizons = remote.models.horizons;
  if (!remoteHorizons || typeof remoteHorizons !== 'object') throw new Error('AUTHORITATIVE_HORIZON_ANALYSIS_UNAVAILABLE');
  modelBreakdown.horizons = remoteHorizons;

  const normalizedWeights = Object.fromEntries(available.map((evaluation) => [evaluation.modelKey, Number((evaluation.dynamicWeight / totalWeight).toFixed(6))]));
  const topPerformingModel = available.slice().sort((a, b) => b.dynamicWeight - a.dynamicWeight)[0]?.modelKey; if (!topPerformingModel) throw new Error('TOP_MODEL_UNAVAILABLE');

  return {
    symbol, direction, probUp: Number(probUp.toFixed(2)), probDown: Number(probDown.toFixed(2)), confidence: Number(confidence.toFixed(2)), marketRegime, anomalyScore: isoScore, assetContext, strategyGate, features, evaluations, modelBreakdown,
    regime: hmm,
    anomaly: iso,
    drift: { modelWeights: normalizedWeights, recentAccuracies: Object.fromEntries(available.map((evaluation) => [evaluation.modelKey, evaluation.validation?.accuracy ?? null])), championQualityScores: Object.fromEntries(available.map((evaluation) => [evaluation.modelKey, evaluation.qualityScore])), regimeRoutingMultipliers: Object.fromEntries(available.map((evaluation) => [evaluation.modelKey, evaluation.regimeMultiplier])), driftBreachedModels: available.filter((evaluation) => evaluation.driftBreached).map((evaluation) => evaluation.modelKey), driftStatus: `Dynamic quality scoring with authoritative regime routing active (${marketRegime})`, topPerformingModel },
    calibration: { modelProbability: direction === 'RISE' ? probUp : probDown, method: 'NATIVE_MODEL_OUTPUT', artifactBacked: false },
    fusion: { directionScore: Number(confidence.toFixed(2)), direction, regimeState: marketRegime, anomalyRisk, finalCompositeScore: Number(confidence.toFixed(2)), confidenceGateThreshold: strategyGate.confidenceGateThreshold, gatePassed: strategyGate.accepted, action: strategyGate.accepted ? (direction === 'RISE' ? 'EXECUTE_CALL' : 'EXECUTE_PUT') : 'SIGNAL_UNAVAILABLE' },
    timestamp: Date.now(),
  };
}
