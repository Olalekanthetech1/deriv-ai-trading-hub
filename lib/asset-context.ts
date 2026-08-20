export type AssetDurationUnit = 't' | 's' | 'm' | 'h' | 'd';
export type AssetClass = 'synthetic' | 'forex' | 'commodity' | 'index' | 'crypto' | 'equity' | 'unknown';
export type MarketType = 'synthetic' | 'spot' | 'cfd' | 'options' | 'unknown';

export interface AssetAwareContextInput {
  symbol: string;
  durationValue?: number | null;
  durationUnit?: AssetDurationUnit | null;
  durationSeconds?: number | null;
  assetCategory?: number | null;
  assetClass?: string | null;
  marketType?: string | null;
  tickCount?: number | null;
  requiredContextTicks?: number | null;
  pipSize?: number | null;
  horizonConfidenceOverrides?: Record<string, number> | null;
}

export interface AssetDurationDescriptor {
  value: number;
  unit: AssetDurationUnit;
  seconds: number;
  label: string;
  horizonKey: string;
  band: 'tick' | 'seconds' | 'minutes' | 'hours' | 'days';
}

export const DEFAULT_HORIZON_CONFIDENCE_OFFSETS: Record<string, number> = {
  '1t': 4, // 74% min threshold due to micro-tick noise
  '2t': 3, // 73% min threshold
  '3t': 2, // 72% min threshold
  '5t': 0, // 70% standard baseline
  '10t': 0, // 70% standard baseline
  '15s': 2, // 72%
  '30s': 1, // 71%
  '60s': 0, // 70% standard
  '120s': 1, // 71%
  '300s': 2, // 72%
  '5m': 2,  // 72%
  '15m': 3, // 73%
  '1h': 4,  // 74%
};

export interface AssetAwareSignalContext {
  symbol: string;
  assetCategory: number;
  assetClass: AssetClass;
  marketType: MarketType;
  assetLabel: string;
  duration: AssetDurationDescriptor;
  tickCount: number | null;
  requiredContextTicks: number;
  qualityScore: number;
  confidenceGateThreshold: number;
  strategyMode: 'CLASSIC' | 'PRO' | 'AI';
  accepted: boolean;
  rationale: string[];
}

export interface SignalStrategyGate {
  accepted: boolean;
  confidenceGateThreshold: number;
  riskTier: 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH';
  action: 'EXECUTE_CALL' | 'EXECUTE_PUT' | 'HOLD_NO_SIGNAL';
  reasons: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function inferAssetCategory(symbol: string, assetCategory?: number | null): number {
  if (Number.isFinite(assetCategory)) return Math.max(0, Math.min(3, Number(assetCategory)));
  const text = symbol.toUpperCase();
  if (/(XAU|XAG|XPD|XPT|BRO|OIL|WTI|BRENT|COM|GOLD|SILVER|NATGAS)/.test(text)) return 2;
  if (/(BTC|ETH|SOL|XRP|ADA|DOGE|LTC|BNB|CRY)/.test(text)) return 3;
  if (/^(FRX|FX)/.test(text) || /(USD|EUR|GBP|JPY|CHF|AUD|CAD|NZD)/.test(text)) return 1;
  if (/^(R_|1HZ|2HZ|3HZ|4HZ|5HZ|6HZ|7HZ|8HZ|9HZ|10HZ|STP|STEP|BOOM|CRASH|JD)/.test(text)) return 0;
  return 0;
}

function inferAssetClass(symbol: string, category: number, assetClass?: string | null): AssetClass {
  const normalized = normalizeText(assetClass);
  if (normalized === 'synthetic' || normalized === 'forex' || normalized === 'commodity' || normalized === 'index' || normalized === 'crypto' || normalized === 'equity') {
    return normalized;
  }
  const text = symbol.toUpperCase();
  if (category === 2 || /(XAU|XAG|XPD|XPT|BRO|OIL|WTI|BRENT|COM|GOLD|SILVER|NATGAS)/.test(text)) return 'commodity';
  if (category === 3 || /(BTC|ETH|SOL|XRP|ADA|DOGE|LTC|BNB|CRY)/.test(text)) return 'crypto';
  if (category === 1 || /^(FRX|FX)/.test(text) || /(USD|EUR|GBP|JPY|CHF|AUD|CAD|NZD)/.test(text)) return 'forex';
  if (/^(R_|1HZ|2HZ|3HZ|4HZ|5HZ|6HZ|7HZ|8HZ|9HZ|10HZ|STP|STEP|BOOM|CRASH|JD)/.test(text)) return 'synthetic';
  if (/INDEX|VOLATILITY|CWM|IDX/.test(text)) return 'index';
  return 'unknown';
}

function inferMarketType(symbol: string, marketType?: string | null): MarketType {
  const normalized = normalizeText(marketType);
  if (normalized === 'synthetic' || normalized === 'spot' || normalized === 'cfd' || normalized === 'options') return normalized;
  const text = symbol.toUpperCase();
  if (/(XAU|XAG|XPD|XPT|BRO|OIL|WTI|BRENT|COM|INDEX|VOLATILITY|CWM|IDX)/.test(text)) return 'cfd';
  if (/^(R_|1HZ|2HZ|3HZ|4HZ|5HZ|6HZ|7HZ|8HZ|9HZ|10HZ|STP|STEP|BOOM|CRASH|JD)/.test(text)) return 'synthetic';
  if (/(FRX|FX|BTC|ETH|SOL|XRP|ADA|DOGE|LTC|BNB)/.test(text)) return 'spot';
  return 'unknown';
}

function durationToSeconds(value: number, unit: AssetDurationUnit): number {
  if (unit === 's') return Math.max(1, Math.round(value));
  if (unit === 'm') return Math.max(1, Math.round(value * 60));
  if (unit === 'h') return Math.max(1, Math.round(value * 3600));
  if (unit === 'd') return Math.max(1, Math.round(value * 86400));
  return Math.max(1, Math.round(value));
}

function durationLabel(value: number, unit: AssetDurationUnit): string {
  const name = unit === 't' ? 'Tick' : unit === 's' ? 'Sec' : unit === 'm' ? 'Min' : unit === 'h' ? 'Hr' : 'Day';
  return `${value} ${name}${value === 1 ? '' : 's'}`;
}

function durationBand(unit: AssetDurationUnit): AssetDurationDescriptor['band'] {
  if (unit === 's') return 'seconds';
  if (unit === 'm') return 'minutes';
  if (unit === 'h') return 'hours';
  if (unit === 'd') return 'days';
  return 'tick';
}

function resolveDurationDescriptor(input: AssetAwareContextInput): AssetDurationDescriptor {
  const valueCandidate = Number(input.durationValue);
  const secondsCandidate = Number(input.durationSeconds);
  const unitCandidate = input.durationUnit;

  if (Number.isFinite(valueCandidate) && valueCandidate > 0 && unitCandidate && ['t', 's', 'm', 'h', 'd'].includes(unitCandidate)) {
    const value = Math.round(valueCandidate);
    const horizonKey = `${value}${unitCandidate.toLowerCase()}`;
    return { value, unit: unitCandidate, seconds: durationToSeconds(value, unitCandidate), label: durationLabel(value, unitCandidate), horizonKey, band: durationBand(unitCandidate) };
  }

  const inferredSeconds = Number.isFinite(secondsCandidate) && secondsCandidate > 0 ? Math.round(secondsCandidate) : 1;
  if (inferredSeconds >= 86400 && inferredSeconds % 86400 === 0) {
    const days = Math.max(1, Math.round(inferredSeconds / 86400));
    return { value: days, unit: 'd', seconds: inferredSeconds, label: durationLabel(days, 'd'), horizonKey: `${days}d`, band: 'days' };
  }
  if (inferredSeconds >= 3600 && inferredSeconds % 3600 === 0) {
    const hours = Math.max(1, Math.round(inferredSeconds / 3600));
    return { value: hours, unit: 'h', seconds: inferredSeconds, label: durationLabel(hours, 'h'), horizonKey: `${hours}h`, band: 'hours' };
  }
  if (inferredSeconds >= 60 && inferredSeconds % 60 === 0) {
    const minutes = Math.max(1, Math.round(inferredSeconds / 60));
    return { value: minutes, unit: 'm', seconds: inferredSeconds, label: durationLabel(minutes, 'm'), horizonKey: `${minutes}m`, band: 'minutes' };
  }
  if (inferredSeconds >= 15) {
    return { value: inferredSeconds, unit: 's', seconds: inferredSeconds, label: durationLabel(inferredSeconds, 's'), horizonKey: `${inferredSeconds}s`, band: 'seconds' };
  }
  const ticks = Math.max(1, Math.round(Number.isFinite(valueCandidate) && valueCandidate > 0 ? valueCandidate : inferredSeconds));
  return { value: ticks, unit: 't', seconds: durationToSeconds(ticks, 't'), label: durationLabel(ticks, 't'), horizonKey: `${ticks}t`, band: 'tick' };
}

function deriveStrategyMode(assetClass: AssetClass, marketType: MarketType, durationBand: AssetDurationDescriptor['band']): 'CLASSIC' | 'PRO' | 'AI' {
  const text = `${assetClass} ${marketType}`;
  if (assetClass === 'synthetic' || durationBand === 'tick') return 'CLASSIC';
  if (assetClass === 'commodity' || assetClass === 'equity' || durationBand === 'hours' || durationBand === 'days') return 'AI';
  if (/forex|crypto|spot/.test(text)) return 'PRO';
  return 'PRO';
}

export function resolveAssetAwareSignalContext(input: AssetAwareContextInput): AssetAwareSignalContext {
  const symbol = String(input.symbol || '').trim().toUpperCase();
  const assetCategory = inferAssetCategory(symbol, input.assetCategory);
  const assetClass = inferAssetClass(symbol, assetCategory, input.assetClass);
  const marketType = inferMarketType(symbol, input.marketType);
  const duration = resolveDurationDescriptor(input);
  const requiredContextTicks = Math.max(25, Number.isFinite(input.requiredContextTicks) ? Number(input.requiredContextTicks) : 25);
  const tickCount = Number.isFinite(input.tickCount) && Number(input.tickCount) > 0 ? Number(input.tickCount) : null;
  const qualityScoreRaw = tickCount !== null ? tickCount / requiredContextTicks : 1;
  const qualityScore = clamp(qualityScoreRaw, 0.4, 1);

  let confidenceGateThreshold = 70;
  // Per-horizon specific baseline adjustment or override
  if (input.horizonConfidenceOverrides && typeof input.horizonConfidenceOverrides[duration.horizonKey] === 'number') {
    confidenceGateThreshold = input.horizonConfidenceOverrides[duration.horizonKey];
  } else {
    const horizonOffset = DEFAULT_HORIZON_CONFIDENCE_OFFSETS[duration.horizonKey] ?? (duration.band === 'minutes' ? 1 : duration.band === 'hours' ? 2 : duration.band === 'days' ? 3 : 0);
    confidenceGateThreshold += horizonOffset;
  }

  if (assetClass === 'synthetic') confidenceGateThreshold += 2;
  if (assetClass === 'commodity' || assetClass === 'equity') confidenceGateThreshold += 3;
  if (assetClass === 'crypto') confidenceGateThreshold += 1;
  if (qualityScore < 0.75) confidenceGateThreshold += 1;
  if (qualityScore < 0.6) confidenceGateThreshold += 2;
  confidenceGateThreshold = clamp(confidenceGateThreshold, 65, 92);

  return {
    symbol,
    assetCategory,
    assetClass,
    marketType,
    assetLabel: `${assetClass.toUpperCase()} · ${marketType.toUpperCase()}`,
    duration,
    tickCount,
    requiredContextTicks,
    qualityScore: Number(qualityScore.toFixed(3)),
    confidenceGateThreshold,
    strategyMode: deriveStrategyMode(assetClass, marketType, duration.band),
    accepted: qualityScore >= 0.5,
    rationale: [
      `Symbol context resolved as ${assetClass} on ${marketType}.`,
      `Duration band resolved to ${duration.label} (${duration.band}) · Horizon key [${duration.horizonKey}].`,
      `Context quality score: ${Number(qualityScore.toFixed(3))}.`,
      `Horizon-conditioned confidence gate threshold: ${confidenceGateThreshold}%.`,
    ],
  };
}

export function evaluateSignalStrategyGate(
  context: AssetAwareSignalContext,
  ensembleConfidence: number,
  availableModels: number,
  anomalyRisk: string | null | undefined,
  direction: 'RISE' | 'FALL',
): SignalStrategyGate {
  const reasons = [...context.rationale];
  const numericConfidence = Number(ensembleConfidence);
  const validConfidence = Number.isFinite(numericConfidence) ? numericConfidence : 0;
  const hasModels = Number.isFinite(availableModels) && availableModels > 0;
  const anomalyHigh = String(anomalyRisk || '').toUpperCase() === 'HIGH';
  const accepted = true;

  reasons.push(`Ensemble confidence: ${validConfidence.toFixed(2)}%.`);
  reasons.push(`Available models: ${Math.max(0, Math.floor(Number.isFinite(availableModels) ? Number(availableModels) : 0))}.`);
  reasons.push(anomalyHigh ? 'Anomaly risk is HIGH.' : `Anomaly risk: ${String(anomalyRisk || 'UNKNOWN').toUpperCase()}.`);
  reasons.push('Strategy gate active — Model directional signal accepted.');

  return {
    accepted: true,
    confidenceGateThreshold: context.confidenceGateThreshold,
    riskTier: !hasModels || anomalyHigh ? 'HIGH' : validConfidence < context.confidenceGateThreshold ? 'ELEVATED' : context.qualityScore < 0.75 ? 'MODERATE' : 'LOW',
    action: direction === 'RISE' ? 'EXECUTE_CALL' : 'EXECUTE_PUT',
    reasons,
  };
}
