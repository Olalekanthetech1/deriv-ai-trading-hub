export type SignalDirection = 'RISE' | 'FALL';
export type SignalMode = 'CLASSIC' | 'PRO' | 'AI';

export interface SignalDuration { value: number; unit: 't' | 's' | 'm' | 'h' | 'd'; label: string; seconds: number; }
export interface SignalModeRecommendation { mode: SignalMode; direction: SignalDirection; confidence: number; duration: SignalDuration; sourceSignalId: string; rationale: string; }
export interface SignalConsensus {
  direction: SignalDirection;
  confidence: number;
  agreement: number;
  totalEngines: number;
  recommendedDuration: SignalDuration;
  expiresAt: number;
  expiresInSeconds: number;
  status: 'ACTIVE' | 'EXPIRING' | 'EXPIRED';
  modeRecommendations: SignalModeRecommendation[];
}

export function durationToSeconds(value: number, unit: 't' | 's' | 'm' | 'h' | 'd'): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('DURATION_INVALID');
  if (unit === 's') return value;
  if (unit === 'm') return value * 60;
  if (unit === 'h') return value * 3600;
  if (unit === 'd') return value * 86400;
  return value;
}

export function createDuration(value: number, unit: 't' | 's' | 'm' | 'h' | 'd', label: string): SignalDuration {
  if (!label.trim()) throw new Error('DURATION_LABEL_REQUIRED');
  return { value, unit, label, seconds: durationToSeconds(value, unit) };
}

export function getSignalStatus(expiresAt: number, now = Date.now()): SignalConsensus['status'] {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return 'EXPIRED';
  const remaining = expiresAt - now;
  if (remaining <= 10_000) return 'EXPIRING';
  return 'ACTIVE';
}

export function buildConsensus(signals: Array<{
  id: string; direction: SignalDirection; confidence: number;
  recommendedDurationValue: number; recommendedDurationUnit: 't' | 's' | 'm' | 'h' | 'd'; recommendedDurationLabel: string;
}>, now = Date.now()): SignalConsensus {
  if (!signals.length) throw new Error('SIGNAL_UNAVAILABLE:NO_NATIVE_MODEL_SIGNALS');
  if (signals.some((signal) => !Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 100)) {
    throw new Error('SIGNAL_UNAVAILABLE:INVALID_MODEL_CONFIDENCE');
  }

  const rise = signals.filter((s) => s.direction === 'RISE');
  const fall = signals.filter((s) => s.direction === 'FALL');
  const winner = rise.length >= fall.length ? 'RISE' : 'FALL';
  const aligned = winner === 'RISE' ? rise : fall;
  const agreement = aligned.length / signals.length;
  const confidence = aligned.reduce((sum, signal) => sum + signal.confidence, 0) / aligned.length;

  const durationVotes = new Map<string, { count: number; confidence: number; sample: (typeof signals)[number] }>();
  for (const signal of aligned) {
    const key = `${signal.recommendedDurationValue}${signal.recommendedDurationUnit}`;
    const existing = durationVotes.get(key);
    if (existing) {
      existing.count += 1;
      existing.confidence += signal.confidence;
    } else {
      durationVotes.set(key, { count: 1, confidence: signal.confidence, sample: signal });
    }
  }

  const durationWinner = [...durationVotes.values()].sort((a, b) => b.count - a.count || b.confidence - a.confidence)[0];
  if (!durationWinner) throw new Error('SIGNAL_UNAVAILABLE:NO_DURATION_CONSENSUS');

  const duration = createDuration(
    durationWinner.sample.recommendedDurationValue,
    durationWinner.sample.recommendedDurationUnit,
    durationWinner.sample.recommendedDurationLabel,
  );
  const expiresAt = now + duration.seconds * 1000;

  return {
    direction: winner,
    confidence: Number(confidence.toFixed(1)),
    agreement: Number((agreement * 100).toFixed(1)),
    totalEngines: signals.length,
    recommendedDuration: duration,
    expiresAt,
    expiresInSeconds: duration.seconds,
    status: getSignalStatus(expiresAt, now),
    modeRecommendations: [],
  };
}

export function buildModeRecommendations(signals: Array<{
  id: string; direction: SignalDirection; confidence: number;
  recommendedDurationValue: number; recommendedDurationUnit: 't' | 's' | 'm' | 'h' | 'd'; recommendedDurationLabel: string;
}>): SignalModeRecommendation[] {
  const byPart = (part: string) => signals.find((s) => s.id.includes(`sig-${part}-`));
  const xgb = byPart('xgb'); const trend = byPart('trend'); const vol = byPart('vol'); const sent = byPart('sent');
  const make = (mode: SignalMode, signal: typeof xgb, rationale: string): SignalModeRecommendation | null => signal ? {
    mode,
    direction: signal.direction,
    confidence: signal.confidence,
    duration: createDuration(signal.recommendedDurationValue, signal.recommendedDurationUnit, signal.recommendedDurationLabel),
    sourceSignalId: signal.id,
    rationale,
  } : null;
  return [
    make('CLASSIC', sent ?? trend, 'Tick direction and short-horizon flow recommendation.'),
    make('PRO', trend ?? vol, 'Regime, velocity and multi-horizon recommendation.'),
    make('AI', xgb ?? vol, 'Machine-learning recommendation from the native prediction layer.'),
  ].filter((item): item is SignalModeRecommendation => Boolean(item));
}
