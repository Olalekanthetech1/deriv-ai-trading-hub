'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ActiveSymbol, Tick } from '@deriv/core';
import type { SignalConsensus, SignalModeRecommendation } from '@/lib/signal-manager';
import type { HorizonDecisionSnapshot } from '@/lib/horizon-decision-engine';
import type { AutoHorizonMode, DurationOption } from '@/lib/duration-utils';

export interface DurationPrediction { value: number; unit: 't' | 's' | 'm' | 'h' | 'd'; label: string; direction: 'RISE' | 'FALL'; confidence: number; winRate: string; }
export interface TradeSignal {
  id: string;
  name: string;
  category: 'AI' | 'TECHNICAL' | 'VOLATILITY' | 'SENTIMENT';
  direction: 'RISE' | 'FALL';
  confidence: number;
  strength: 'Strong Buy' | 'Buy' | 'Strong Sell' | 'Sell';
  recommendedDurationValue: number;
  recommendedDurationUnit: 't' | 's' | 'm' | 'h' | 'd';
  recommendedDurationLabel: string;
  durationMatrix?: DurationPrediction[];
  targetBarrier?: string;
  expiresInSeconds: number;
  maxExpirySeconds: number;
  expiresAt: number;
  winRate: string;
  description: string;
  timestamp: number;
}
interface SignalWinStats { total: number; winCount: number; accuracy?: string; }
interface SignalApiResponse {
  success: boolean;
  error?: string;
  signals?: TradeSignal[];
  winStats?: SignalWinStats;
  consensus?: SignalConsensus;
  modeRecommendations?: SignalModeRecommendation[];
  decisionSnapshot?: HorizonDecisionSnapshot;
}

const MODEL_RETRY_COOLDOWN_MS = 15_000;

export function useRealtimeSignals(
  activeSymbol: ActiveSymbol | null,
  currentTick: Tick | null,
  prices: number[],
  durationValue?: number,
  durationUnit?: string,
  autoHorizonMode?: AutoHorizonMode,
  durationOptions?: DurationOption[],
  isAutoDuration?: boolean,
) {
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [consensus, setConsensus] = useState<SignalConsensus | null>(null);
  const [modeRecommendations, setModeRecommendations] = useState<SignalModeRecommendation[]>([]);
  const [serverDecisionSnapshot, setServerDecisionSnapshot] = useState<HorizonDecisionSnapshot | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [winStats, setWinStats] = useState<SignalWinStats | null>(null);
  const lastTickQuoteRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const predictionInFlightRef = useRef(false);
  const modelRetryAfterRef = useRef(0);

  const decisionSnapshot = serverDecisionSnapshot;

  const playAlertSound = useCallback(() => {
    if (!soundEnabled || typeof window === 'undefined') return;
    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') audioCtxRef.current = new AudioContextClass();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch {
      // Audio is optional UI behavior; it never affects analysis correctness.
    }
  }, [soundEnabled]);

  useEffect(() => {
    if (!activeSymbol || !currentTick?.quote || !currentTick.epoch || prices.length < 5) return;
    if (!Number.isFinite(durationValue) || Number(durationValue) <= 0 || !durationUnit) return;
    if (lastTickQuoteRef.current === currentTick.quote) return;
    const liveTick = currentTick;
    lastTickQuoteRef.current = liveTick.quote;

    const now = Date.now();
    if (now < modelRetryAfterRef.current || predictionInFlightRef.current) return;

    const symbolKey = activeSymbol.underlying_symbol;
    const pipSize = activeSymbol.pip_size;
    if (!Number.isFinite(pipSize)) return;

    let isSubscribed = true;
    predictionInFlightRef.current = true;

    async function fetchSignals() {
      try {
        const res = await fetch('/api/signals/predict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: symbolKey,
            currentTick: { price: Number(liveTick.quote), timestamp: Number(liveTick.epoch) * 1000 },
            pipSize,
            durationValue,
            durationUnit,
            autoHorizonMode,
            isAutoDuration,
            mode: isAutoDuration ? 'auto' : autoHorizonMode && autoHorizonMode !== 'auto' ? 'ai_assist' : 'manual',
          }),
        });
        const data = (await res.json().catch(() => ({}))) as SignalApiResponse;

        if (!res.ok || !data.success || data?.error) {
          modelRetryAfterRef.current = Date.now() + MODEL_RETRY_COOLDOWN_MS;
          if (isSubscribed) {
            setSignals([]);
            setConsensus(null);
            setModeRecommendations([]);
            setServerDecisionSnapshot(null);
          }
          return;
        }

        if (!isSubscribed || !Array.isArray(data.signals) || !data.consensus || data.signals.length === 0) return;
        if (!['RISE', 'FALL'].includes(data.consensus.direction)) return;

        modelRetryAfterRef.current = 0;
        if (data.winStats) setWinStats(data.winStats);
        if (data.consensus) setConsensus(data.consensus);
        if (Array.isArray(data.modeRecommendations)) setModeRecommendations(data.modeRecommendations);
        if (data.decisionSnapshot) setServerDecisionSnapshot(data.decisionSnapshot);

        const responseNow = Date.now();
        setSignals((prev) => data.signals!.map((next) => {
          const existing = prev.find((s) => s.id === next.id);
          if (existing && existing.expiresAt > responseNow) return existing;
          return next;
        }));

        if (data.consensus.confidence >= 90 && data.consensus.agreement >= 75) playAlertSound();
      } catch (err) {
        console.warn('[Realtime Signal Fetch Warning]:', err);
      } finally {
        predictionInFlightRef.current = false;
      }
    }

    void fetchSignals();
    return () => { isSubscribed = false; };
  }, [activeSymbol, currentTick, prices, durationValue, durationUnit, autoHorizonMode, isAutoDuration, playAlertSound]);

  useEffect(() => {
    if (!signals.length) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setSignals((prev) => prev.map((signal) => ({ ...signal, expiresInSeconds: Math.max(0, Math.ceil((signal.expiresAt - now) / 1000)) })));
      setConsensus((prev) => prev ? { ...prev, expiresInSeconds: Math.max(0, Math.ceil((prev.expiresAt - now) / 1000)), status: prev.expiresAt <= now ? 'EXPIRED' : prev.expiresAt - now <= 10_000 ? 'EXPIRING' : 'ACTIVE' } : prev);
    }, 250);
    return () => window.clearInterval(interval);
  }, [signals.length]);

  const highConfidenceCount = useMemo(() => signals.filter((s) => s.confidence >= 85).length, [signals]);
  const toggleSound = useCallback(() => setSoundEnabled((prev) => !prev), []);

  return { signals, consensus, modeRecommendations, decisionSnapshot, highConfidenceCount, soundEnabled, toggleSound, winStats };
}
