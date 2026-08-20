import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

import { TickPoint } from '@/lib/ml-feature-extractor';
import { evaluateProductionEnsemble, ProductionEnsembleResult } from '@/lib/production-ensemble';
import { initDbSchema, getDb } from '@/lib/db';
import { ensureMinTicks } from '@/lib/ticks-helper';
import { buildConsensus, createDuration, durationToSeconds } from '@/lib/signal-manager';
import { verifySessionToken } from '../../admin/auth/route';
import { recordObservabilityEvent } from '@/lib/observability';
import { evaluateHorizonDecisionSnapshot, type CandidateHorizon, type HorizonDecisionMode } from '@/lib/horizon-decision-engine';
import { validateHdeCompliance } from '@/lib/hde-compliance-validator';
import { getDerivDurationDiscovery } from '@/lib/deriv-duration-registry';
import { resolveAuthoritativeAssetContext } from '@/lib/authoritative-asset-context';
import { getEligibleProductionHorizons } from '@/lib/production-model-resolver';
import type { DurationOption, DurationSelectUnit } from '@/lib/duration-utils';

export interface DurationPrediction { value: number; unit: 't' | 's' | 'm' | 'h' | 'd'; label: string; direction: 'RISE' | 'FALL'; confidence: number; winRate: string; }
export interface SignalResponseItem {
  id: string; name: string; category: 'AI' | 'TECHNICAL' | 'VOLATILITY' | 'SENTIMENT'; modelKey?: string; modelId?: string | null;
  direction: 'RISE' | 'FALL'; confidence: number; strength: 'Strong Buy' | 'Buy' | 'Strong Sell' | 'Sell';
  recommendedDurationValue: number; recommendedDurationUnit: 't' | 's' | 'm' | 'h' | 'd'; recommendedDurationLabel: string;
  durationMatrix: DurationPrediction[]; targetBarrier?: string; expiresInSeconds: number; maxExpirySeconds: number; expiresAt: number;
  winRate: string; description: string; strategyGateAccepted: boolean; strategyGateThreshold: number;
  strategyGateRiskTier: 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH'; strategyGateReasons: string[]; timestamp: number;
}
interface ExecutionHorizon { value: number; unit: 't' | 's' | 'm' | 'h' | 'd'; seconds: number; label: string; key: string; }
interface AiExecutionPlan {
  executionPlanId: string; requestedHorizon: ExecutionHorizon; selectedHorizon: ExecutionHorizon; predictionHorizon: ExecutionHorizon;
  horizonAligned: boolean; strategyGateAccepted: boolean; modelKeys: string[]; modelIds: string[]; decisionSnapshotId: string;
}

function normalizeDuration(value: unknown, unit: unknown): ExecutionHorizon {
  const numericValue = Number(value);
  if (!Number.isSafeInteger(numericValue) || numericValue <= 0) throw new Error('REQUESTED_DURATION_REQUIRED');
  const unitStr = String(unit || '').toLowerCase();
  const normalizedUnit: ExecutionHorizon['unit'] = unitStr === 's' || unitStr === 'sec' ? 's' : unitStr === 'm' || unitStr === 'min' ? 'm' : unitStr === 'h' || unitStr === 'hour' || unitStr === 'hr' ? 'h' : unitStr === 'd' || unitStr === 'day' ? 'd' : unitStr === 't' ? 't' : (() => { throw new Error('REQUESTED_DURATION_UNIT_REQUIRED'); })();
  const seconds = durationToSeconds(numericValue, normalizedUnit);
  const unitName = normalizedUnit === 't' ? 'Tick' : normalizedUnit === 's' ? 'Second' : normalizedUnit === 'm' ? 'Minute' : normalizedUnit === 'h' ? 'Hour' : 'Day';
  return { value: numericValue, unit: normalizedUnit, seconds, label: `${numericValue} ${unitName}${numericValue === 1 ? '' : 's'}`, key: `${numericValue}${normalizedUnit}` };
}

function horizonFromDecision(horizon: CandidateHorizon): ExecutionHorizon {
  if (horizon.unit === 'end-time') throw new Error('END_TIME_HORIZON_NOT_SUPPORTED_FOR_AI_EXECUTION');
  const seconds = horizon.unit === 't' ? horizon.value : durationToSeconds(horizon.value, horizon.unit as 't' | 's' | 'm' | 'h' | 'd');
  return { value: horizon.value, unit: horizon.unit as ExecutionHorizon['unit'], seconds, label: horizon.label, key: horizon.key };
}
function sameHorizon(a: ExecutionHorizon, b: ExecutionHorizon): boolean { return a.value === b.value && a.unit === b.unit; }

function buildServerDurationOptions(discovery: Awaited<ReturnType<typeof getDerivDurationDiscovery>>): DurationOption[] {
  if (!discovery.ranges.length) throw new Error('AUTHORITATIVE_DURATION_DISCOVERY_UNAVAILABLE');
  return discovery.ranges.map((range) => ({
    unit: range.unit,
    label: range.unit === 't' ? 'Ticks' : range.unit === 's' ? 'Seconds' : range.unit === 'm' ? 'Minutes' : 'Hours',
    min: range.min,
    max: range.max,
  }));
}

function assertFreshLiveTicks(ticks: TickPoint[]): void {
  if (ticks.length < 5) throw new Error('LIVE_TICK_DATA_INSUFFICIENT');
  const validTicks = ticks.filter((tick): tick is TickPoint & { timestamp: number } => Number.isFinite(tick.timestamp));
  if (validTicks.length < 5) throw new Error('LIVE_TICK_TIMESTAMP_DATA_UNAVAILABLE');
  const sorted = validTicks.slice().sort((a, b) => a.timestamp - b.timestamp);
  const intervals = sorted.slice(1).map((tick, index) => tick.timestamp - sorted[index].timestamp).filter((value) => Number.isFinite(value) && value > 0);
  if (!intervals.length) throw new Error('LIVE_TICK_CADENCE_UNAVAILABLE');
  const ordered = intervals.slice().sort((a, b) => a - b);
  const medianInterval = ordered[Math.floor(ordered.length / 2)];
  const latestAge = Date.now() - sorted[sorted.length - 1].timestamp;
  const maxAllowedAge = Math.max(medianInterval * 4, 6000);
  if (!Number.isFinite(latestAge) || latestAge < -2000 || latestAge > maxAllowedAge) throw new Error('LIVE_TICK_DATA_STALE');
}

function buildSignalItems(ensemble: ProductionEnsembleResult, duration: ExecutionHorizon, now: number): SignalResponseItem[] {
  if (!ensemble.strategyGate.accepted) throw new Error('SIGNAL_UNAVAILABLE:STRATEGY_GATE_BLOCKED');
  const signals = ensemble.evaluations
    .filter((evaluation) => evaluation.status === 'AVAILABLE' && evaluation.probabilityUp !== null && evaluation.probabilityDown !== null && evaluation.signal !== null && evaluation.confidence !== null && evaluation.modelId)
    .map((evaluation) => {
      const direction = evaluation.signal as 'RISE' | 'FALL';
      const confidence = Number(evaluation.confidence);
      const strength: SignalResponseItem['strength'] = direction === 'RISE' ? (confidence >= 90 ? 'Strong Buy' : 'Buy') : (confidence >= 90 ? 'Strong Sell' : 'Sell');
      const expiry = now + duration.seconds * 1000;
      return {
        id: `sig-${evaluation.modelKey}-${ensemble.symbol}`,
        name: evaluation.modelName,
        category: 'AI' as const,
        modelKey: evaluation.modelKey,
        modelId: evaluation.modelId,
        direction,
        confidence,
        strength,
        recommendedDurationValue: duration.value,
        recommendedDurationUnit: duration.unit,
        recommendedDurationLabel: duration.label,
        durationMatrix: [{ value: duration.value, unit: duration.unit, label: duration.label, direction, confidence, winRate: 'Native model probability' }],
        expiresInSeconds: duration.seconds,
        maxExpirySeconds: duration.seconds,
        expiresAt: expiry,
        winRate: 'Native model probability',
        description: `${evaluation.details} · Live strategy gate accepted (${ensemble.strategyGate.confidenceGateThreshold}%)`,
        strategyGateAccepted: true,
        strategyGateThreshold: ensemble.strategyGate.confidenceGateThreshold,
        strategyGateRiskTier: ensemble.strategyGate.riskTier,
        strategyGateReasons: ensemble.strategyGate.reasons,
        timestamp: now,
      };
    });
  if (!signals.length) throw new Error('SIGNAL_UNAVAILABLE:LIVE_MODEL_OUTPUTS_UNAVAILABLE');
  return signals;
}

function buildModeRecommendations(signals: SignalResponseItem[]) {
  const ranked = [...signals].sort((a, b) => b.confidence - a.confidence);
  const tabular = ranked.find((signal) => /XGBoost|LightGBM|CatBoost/i.test(signal.name));
  const sequential = ranked.find((signal) => /TCN|LSTM|Transformer/i.test(signal.name));
  const recommendations = [] as Array<{ mode: 'CLASSIC' | 'PRO' | 'AI'; direction: 'RISE' | 'FALL'; confidence: number; duration: ReturnType<typeof createDuration>; sourceSignalId: string; rationale: string }>;
  if (tabular) recommendations.push({ mode: 'CLASSIC', direction: tabular.direction, confidence: tabular.confidence, duration: createDuration(tabular.recommendedDurationValue, tabular.recommendedDurationUnit, tabular.recommendedDurationLabel), sourceSignalId: tabular.id, rationale: 'Live promoted tabular/native model output.' });
  if (sequential) recommendations.push({ mode: 'PRO', direction: sequential.direction, confidence: sequential.confidence, duration: createDuration(sequential.recommendedDurationValue, sequential.recommendedDurationUnit, sequential.recommendedDurationLabel), sourceSignalId: sequential.id, rationale: 'Live promoted sequential/native model output.' });
  const primary = ranked[0];
  if (primary) recommendations.push({ mode: 'AI', direction: primary.direction, confidence: primary.confidence, duration: createDuration(primary.recommendedDurationValue, primary.recommendedDurationUnit, primary.recommendedDurationLabel), sourceSignalId: primary.id, rationale: 'Live native production ensemble output.' });
  return recommendations;
}

function isAdminDiagnosticAuthorized(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function POST(req: NextRequest) {
  const incomingCorrelationId = req.headers.get('x-correlation-id')?.trim();
  const correlationId = incomingCorrelationId && incomingCorrelationId.length <= 128 ? incomingCorrelationId : randomUUID();
  const diagnostic = req.headers.get('x-admin-diagnostic') === 'true';
  const responseHeaders = { 'Cache-Control': 'no-store', 'x-correlation-id': correlationId };

  if (diagnostic && !isAdminDiagnosticAuthorized(req)) return NextResponse.json({ success: false, diagnostic: true, correlationId, error: 'Admin authorization is required for diagnostic signal verification.' }, { status: 401, headers: responseHeaders });

  try {
    await initDbSchema();
    const body = await req.json().catch(() => { throw new Error('REQUEST_BODY_INVALID'); });
    const symbol = typeof body?.symbol === 'string' && body.symbol.trim() ? body.symbol.trim().toUpperCase() : (() => { throw new Error('SYMBOL_REQUIRED'); })();
    const requestedHorizon = normalizeDuration(body?.durationValue, body?.durationUnit);
    const modeValue = String(body?.mode || '').trim();
    const mode: HorizonDecisionMode = modeValue === 'auto' ? 'auto' : modeValue === 'ai_assist' ? 'ai_assist' : modeValue === 'manual' ? 'manual' : (() => { throw new Error('ANALYSIS_MODE_REQUIRED'); })();

    const sql = getDb();
    if (!sql) throw new Error('ANALYSIS_DATABASE_UNAVAILABLE');
    const authoritativeAssetContext = await resolveAuthoritativeAssetContext(symbol);
    const assetClass = authoritativeAssetContext.assetClass;
    const marketType = authoritativeAssetContext.marketType;
    const assetCategoryNum = authoritativeAssetContext.assetCategory;

    const discovery = await getDerivDurationDiscovery(symbol);
    const durationOptions = buildServerDurationOptions(discovery);
    const tickList = await ensureMinTicks(symbol, 100, true);
    if (tickList.length < 25) throw new Error('LIVE_TICK_DATA_INSUFFICIENT');
    assertFreshLiveTicks(tickList);

    const evaluateAtHorizon = async (horizon: ExecutionHorizon): Promise<ProductionEnsembleResult> => evaluateProductionEnsemble(tickList, {
      symbol,
      durationSecs: horizon.seconds,
      durationValue: horizon.value,
      durationUnit: horizon.unit,
      assetCategory: assetCategoryNum,
      assetClass,
      marketType,
      requiredContextTicks: tickList.length,
    });

    const eligibleHorizons = await getEligibleProductionHorizons(symbol);
    if (!eligibleHorizons.length) throw new Error(`NO_VALIDATED_PRODUCTION_MODELS:${symbol}:ANY`);

    const initialEvaluationHorizon = (mode === 'manual' || eligibleHorizons.some((h) => sameHorizon(h, requestedHorizon)))
      ? requestedHorizon
      : (() => {
          const autoMode = body?.autoHorizonMode as DurationSelectUnit | 'auto' | undefined;
          const filtered = (autoMode && autoMode !== 'auto')
            ? eligibleHorizons.filter((h) => h.unit === autoMode)
            : eligibleHorizons;
          const chosen = filtered[0] || eligibleHorizons[0];
          return normalizeDuration(chosen.value, chosen.unit);
        })();

    const selectionEnsemble = await evaluateAtHorizon(initialEvaluationHorizon);
    const initialDecisionSnapshot = evaluateHorizonDecisionSnapshot({
      symbol,
      mode,
      categoryFilter: body?.autoHorizonMode as DurationSelectUnit | 'auto' | undefined,
      requestedDuration: { value: requestedHorizon.value, unit: requestedHorizon.unit },
      primaryEnsemble: selectionEnsemble,
      durationOptions,
      prices: tickList.map((tick) => tick.price),
    });

    const selectedHorizon = mode === 'manual' ? requestedHorizon : horizonFromDecision(initialDecisionSnapshot.decision.horizon);
    const predictionEnsemble = sameHorizon(initialEvaluationHorizon, selectedHorizon) ? selectionEnsemble : await evaluateAtHorizon(selectedHorizon);
    if (!predictionEnsemble.strategyGate.accepted) throw new Error('SIGNAL_UNAVAILABLE:STRATEGY_GATE_BLOCKED_SELECTED_HORIZON');

    const decisionSnapshot = evaluateHorizonDecisionSnapshot({
      symbol,
      mode,
      categoryFilter: selectedHorizon.unit,
      requestedDuration: { value: selectedHorizon.value, unit: selectedHorizon.unit },
      primaryEnsemble: predictionEnsemble,
      durationOptions,
      prices: tickList.map((tick) => tick.price),
      enforceRequestedDuration: true,
    });
    const finalHorizon = horizonFromDecision(decisionSnapshot.decision.horizon);
    if (!sameHorizon(selectedHorizon, finalHorizon)) {
      console.error(`[HORIZON_ALIGNMENT_FAILED] selectedHorizon=${selectedHorizon.value}${selectedHorizon.unit} finalHorizon=${finalHorizon.value}${finalHorizon.unit}`);
      throw new Error(`HORIZON_ALIGNMENT_FAILED:selected=${selectedHorizon.value}${selectedHorizon.unit}_final=${finalHorizon.value}${finalHorizon.unit}`);
    }

    const complianceCheck = await validateHdeCompliance({ symbol, horizon: { value: finalHorizon.value, unit: finalHorizon.unit }, features: predictionEnsemble.features, mode });
    if (!complianceCheck.valid) throw new Error(`HDE_COMPLIANCE_ERROR:${complianceCheck.rejectionReason}`);

    const executionPlan: AiExecutionPlan = {
      executionPlanId: randomUUID(),
      requestedHorizon,
      selectedHorizon,
      predictionHorizon: finalHorizon,
      horizonAligned: true,
      strategyGateAccepted: true,
      modelKeys: predictionEnsemble.evaluations.filter((evaluation) => evaluation.status === 'AVAILABLE' && evaluation.modelId).map((evaluation) => evaluation.modelKey),
      modelIds: predictionEnsemble.evaluations.filter((evaluation) => evaluation.status === 'AVAILABLE' && evaluation.modelId).map((evaluation) => evaluation.modelId as string),
      decisionSnapshotId: decisionSnapshot.modelSnapshotId,
    };
    if (!executionPlan.modelIds.length) throw new Error('PRODUCTION_MODEL_ID_UNAVAILABLE');

    const now = Date.now();
    const generatedSignals = buildSignalItems(predictionEnsemble, finalHorizon, now);
    const modeRecommendations = buildModeRecommendations(generatedSignals);
    const consensus = { ...buildConsensus(generatedSignals, now), modeRecommendations };

    const statsRes = await sql`
      SELECT COUNT(*)::int AS total,
             COUNT(CASE WHEN status IN ('WON', 'WIN') THEN 1 END)::int AS wins
      FROM execution_trades
      WHERE status IN ('WON', 'LOST', 'WIN', 'LOSS')
    `;
    if (!statsRes?.length) throw new Error('LIVE_TRADE_STATS_UNAVAILABLE');
    const totalVerified = Number(statsRes[0].total);
    const winCount = Number(statsRes[0].wins);
    if (!Number.isInteger(totalVerified) || !Number.isInteger(winCount) || totalVerified < 0 || winCount < 0 || winCount > totalVerified) throw new Error('LIVE_TRADE_STATS_INVALID');
    const winStats = { total: totalVerified, winCount, accuracy: totalVerified > 0 ? `${((winCount / totalVerified) * 100).toFixed(1)}%` : undefined };

    await recordObservabilityEvent({
      category: 'trading', severity: 'info', service: 'signal-prediction', eventType: 'signal_prediction_completed',
      message: `${symbol} ${predictionEnsemble.direction} · ${predictionEnsemble.confidence.toFixed(1)}% confidence · ${executionPlan.selectedHorizon.label}.`,
      correlationId, symbol, modelId: executionPlan.modelIds[0],
      metadata: { diagnostic, direction: predictionEnsemble.direction, finalDecision: predictionEnsemble.direction, confidence: predictionEnsemble.confidence, probabilityUp: predictionEnsemble.probUp, probabilityDown: predictionEnsemble.probDown, strategyGateAccepted: true, strategyGateThreshold: predictionEnsemble.strategyGate.confidenceGateThreshold, riskTier: predictionEnsemble.strategyGate.riskTier, strategyGateReasons: predictionEnsemble.strategyGate.reasons, marketRegime: predictionEnsemble.marketRegime, anomalyScore: predictionEnsemble.anomalyScore, executionPlan, requestedDuration: executionPlan.requestedHorizon, selectedDuration: executionPlan.selectedHorizon, predictionDuration: executionPlan.predictionHorizon, modelCount: predictionEnsemble.evaluations.length, availableModelCount: predictionEnsemble.evaluations.filter((evaluation) => evaluation.status === 'AVAILABLE').length, modelBreakdown: predictionEnsemble.modelBreakdown, featureCount: Object.keys(predictionEnsemble.features ?? {}).length },
    });

    return NextResponse.json({
      success: true,
      diagnostic,
      correlationId,
      assetContext: predictionEnsemble.assetContext,
      strategyGate: predictionEnsemble.strategyGate,
      executionPlan,
      prediction: { signal: predictionEnsemble.direction === 'RISE' ? 'CALL' : 'PUT', confidence: predictionEnsemble.confidence, probabilityUp: predictionEnsemble.probUp, probabilityDown: predictionEnsemble.probDown, symbol, features: predictionEnsemble.features, timestamp: now, modelVersion: executionPlan.modelIds[0] },
      signals: generatedSignals,
      winStats,
      consensus,
      modeRecommendations,
      confidence: predictionEnsemble.confidence,
      marketRegime: predictionEnsemble.marketRegime,
      anomalyScore: predictionEnsemble.anomalyScore,
      modelBreakdown: predictionEnsemble.modelBreakdown,
      multiModelEnsemble: predictionEnsemble,
      decisionSnapshot,
      horizonSelectionSnapshot: initialDecisionSnapshot,
    }, { headers: responseHeaders });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'SIGNAL_ANALYSIS_FAILED';
    const errorModelBreakdown = err instanceof Error && 'modelBreakdown' in err ? (err as any).modelBreakdown : undefined;
    await recordObservabilityEvent({ category: 'trading', severity: 'error', service: 'signal-prediction', eventType: 'signal_prediction_failed', message: `Signal prediction failed for request ${correlationId}.`, correlationId, metadata: { diagnostic, errorCode: message.slice(0, 300), modelBreakdown: errorModelBreakdown } });
    console.error(`[Signal Prediction Error] correlationId=${correlationId}:`, err);
    return NextResponse.json({ success: false, diagnostic, correlationId, error: message, modelBreakdown: diagnostic ? errorModelBreakdown : undefined }, { status: 503, headers: responseHeaders });
  }
}
