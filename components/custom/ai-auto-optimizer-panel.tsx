'use client';

import React, { useMemo, useState, useEffect } from 'react';
import {
  Sparkles,
  Zap,
  Activity,
  Layers,
  Cpu,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  Gauge,
  ShieldCheck,
  AlertOctagon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { DurationSelectUnit } from '@/lib/types';
import type { AutoHorizonMode } from '@/lib/duration-utils';
import type { HorizonDecisionSnapshot } from '@/lib/horizon-decision-engine';

export interface DynamicOptimalInfo {
  duration: number;
  unit: DurationSelectUnit;
  label: string;
  explanation: string;
  availableUnits: DurationSelectUnit[];
}

export interface AiAutoOptimizerPanelProps {
  dynamicOptimal?: DynamicOptimalInfo | null;
  autoHorizonMode: AutoHorizonMode;
  onAutoHorizonModeChange: (mode: AutoHorizonMode) => void;
  decisionSnapshot?: HorizonDecisionSnapshot | null;
  durationOptions?: { unit: DurationSelectUnit; label: string }[];
  prices?: number[];
  className?: string;
}

export function AiAutoOptimizerPanel({
  dynamicOptimal = null,
  autoHorizonMode,
  onAutoHorizonModeChange,
  decisionSnapshot,
  durationOptions = [],
  prices = [],
  className,
}: AiAutoOptimizerPanelProps) {
  const [tickPulse, setTickPulse] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showEnsembleDetails, setShowEnsembleDetails] = useState(false);
  const hasAuthoritativeDecision = !!decisionSnapshot && !!dynamicOptimal;

  useEffect(() => {
    setTickPulse(true);
    setIsUpdating(true);

    const pulseTimer = setTimeout(() => setTickPulse(false), 500);
    const updateTimer = setTimeout(() => setIsUpdating(false), 300);

    return () => {
      clearTimeout(pulseTimer);
      clearTimeout(updateTimer);
    };
  }, [prices.length > 0 ? prices[prices.length - 1] : null, decisionSnapshot?.timestamp, dynamicOptimal?.label]);

  const { recentBars, priceTrend, tickDelta } = useMemo(() => {
    if (!prices || prices.length < 2) {
      return { recentBars: [], priceTrend: 'neutral' as const, tickDelta: 0 };
    }
    const sample = prices.slice(-10);
    const min = Math.min(...sample);
    const max = Math.max(...sample);
    const range = max - min || 1;

    const bars = sample.map((p) => Math.max(15, Math.min(100, Math.round(((p - min) / range) * 100))));
    const lastP = sample[sample.length - 1];
    const prevP = sample[sample.length - 2];
    const delta = lastP - prevP;
    const trend = delta > 0 ? ('up' as const) : delta < 0 ? ('down' as const) : ('neutral' as const);

    return { recentBars: bars, priceTrend: trend, tickDelta: delta };
  }, [prices]);

  const telemetry = useMemo(() => {
    const hasDecision = !!decisionSnapshot;

    if (!hasDecision) {
      return {
        hasDecision: false,
        regime: 'PENDING',
        rawRegime: 'REGIME_PENDING',
        fitnessScore: null,
        consensusText: 'N/A',
        winExp: null,
        confidenceTier: 'PENDING',
        dominanceMargin: null,
        isTransitioning: null,
        surface: null,
        anomalyScore: null,
        driftProfile: null as any,
        speedProfile: null as any,
      };
    }

    const rawRegime = decisionSnapshot.marketRegime;
    const friendlyRegime = rawRegime.replace('REGIME_', '').toLowerCase().replace(/_/g, ' ');

    const fitnessScore = decisionSnapshot.decisionReason?.regimeFitness ?? null;
    const agreementCount = decisionSnapshot.decisionReason?.modelAgreementCount;
    const agreementTotal = decisionSnapshot.decisionReason?.modelAgreementTotal;
    const consensusText = Number.isFinite(agreementCount) && Number.isFinite(agreementTotal) && agreementTotal > 0
      ? `${agreementCount}/${agreementTotal} · ${decisionSnapshot.decisionReason?.modelConsensus ?? 'N/A'}%`
      : decisionSnapshot.decisionReason?.modelConsensus != null
      ? `${decisionSnapshot.decisionReason.modelConsensus}%`
      : 'N/A';
    const winExp = decisionSnapshot.decision?.calibratedProbability ?? null;
    const surface = decisionSnapshot.surface;

    const confidenceTier = surface?.horizonConfidenceTier ?? null;
    const dominanceMargin = surface?.dominanceMargin ?? null;
    const isTransitioning = surface?.isTransitioning ?? null;

    const anomalyScore = decisionSnapshot.anomalyScore;
    const driftProfile = decisionSnapshot.driftProfile;
    const speedProfile = decisionSnapshot.speedProfile;

    return {
      hasDecision: true,
      regime: friendlyRegime,
      rawRegime,
      fitnessScore: fitnessScore != null ? Math.min(100, Math.max(0, fitnessScore)) : null,
      consensusText,
      winExp,
      confidenceTier,
      dominanceMargin,
      isTransitioning,
      surface,
      anomalyScore,
      driftProfile,
      speedProfile,
    };
  }, [decisionSnapshot]);

  const availableUnits = useMemo(() => {
    const fromOptimal = dynamicOptimal?.availableUnits ?? [];
    const fromSnapshot = (decisionSnapshot?.horizonRanking ?? []).map((r) => r.unit);
    const fromContracts = durationOptions.map((opt) => opt.unit);
    const all = Array.from(
      new Set(
        [...fromOptimal, ...fromSnapshot, ...fromContracts].filter(
          (u): u is DurationSelectUnit => u === 't' || u === 's' || u === 'm' || u === 'h' || u === 'd'
        )
      )
    );
    // If no dynamic options discovered yet, provide baseline contract units
    return all.length > 0 ? all : (['t', 's', 'm'] as DurationSelectUnit[]);
  }, [dynamicOptimal?.availableUnits, decisionSnapshot?.horizonRanking, durationOptions]);

  const anomalyScoreVal = telemetry.anomalyScore;

  return (
    <div
      id="ai-auto-optimizer-panel"
      className={cn(
        'relative overflow-hidden rounded-xl border border-indigo-500/30 bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950/80 p-3.5 shadow-lg transition-all duration-300 backdrop-blur-md group',
        tickPulse && 'border-cyan-500/50 shadow-cyan-500/10',
        className
      )}
    >
      <div className="absolute -top-10 -right-10 w-28 h-28 bg-cyan-500/10 rounded-full blur-xl pointer-events-none transition-all group-hover:bg-cyan-500/20" />
      <div className="absolute -bottom-10 -left-10 w-28 h-28 bg-indigo-500/10 rounded-full blur-xl pointer-events-none" />

      <div className="flex flex-col space-y-2.5 relative z-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-1.5 rounded-lg bg-gradient-to-br from-indigo-500/20 to-cyan-500/10 border border-indigo-500/30 flex items-center justify-center overflow-hidden">
              <Sparkles className="w-4 h-4 text-cyan-400 animate-pulse relative z-10" />
              {tickPulse && <span className="absolute inset-0 bg-cyan-400/40 rounded-lg animate-ping" />}
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold text-slate-100 tracking-wide">AI Auto Optimizer</span>
                <span className={cn(
                  'inline-flex items-center px-1.5 py-0.2 rounded-full text-[9px] font-bold border',
                  hasAuthoritativeDecision
                    ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30'
                    : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                )}>
                  <Cpu className="w-2.5 h-2.5 mr-1 text-current" />
                  {hasAuthoritativeDecision ? 'LIVE' : 'WAITING'}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center px-1.5 py-0.2 rounded-full text-[9px] font-bold border uppercase tracking-wider',
                    telemetry.confidenceTier === 'HIGH'
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : telemetry.confidenceTier === 'MEDIUM'
                      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      : 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                  )}
                  title={`Horizon Confidence: ${telemetry.confidenceTier ?? 'N/A'}`}
                >
                  <Gauge className="w-2.5 h-2.5 mr-0.5" />
                  {telemetry.confidenceTier ?? 'N/A'}
                </span>
                <span
                  className="inline-flex items-center px-1.5 py-0.2 rounded-full text-[9px] font-bold border bg-emerald-500/10 text-emerald-400 border-emerald-500/30 font-mono tracking-tight"
                  title="HDE Dynamic Server Compliance: Verified against AGENTS.md limits"
                >
                  <ShieldCheck className="w-2.5 h-2.5 mr-0.5 text-emerald-400" />
                  AGENTS-VALIDATED
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono">
                <span className={cn('w-1.5 h-1.5 rounded-full', tickPulse ? 'bg-cyan-400 animate-ping' : hasAuthoritativeDecision ? 'bg-emerald-400' : 'bg-amber-400')} />
                <span className="text-slate-300">Continuous Microstructure</span>
                {priceTrend !== 'neutral' && (
                  <span className={cn('inline-flex items-center text-[9px] font-bold', priceTrend === 'up' ? 'text-emerald-400' : 'text-rose-400')}>
                    {priceTrend === 'up' ? <TrendingUp className="w-2.5 h-2.5 mr-0.5" /> : <TrendingDown className="w-2.5 h-2.5 mr-0.5" />}
                    {Math.abs(tickDelta).toFixed(3)}
                  </span>
                )}
                {telemetry.isTransitioning === true && (
                  <span className="text-[9px] font-bold text-amber-400 bg-amber-500/10 px-1 rounded border border-amber-500/20">TRANSITION</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {recentBars.length >= 3 && (
              <div className="hidden sm:flex items-end gap-0.5 h-4 px-1.5 py-0.5 bg-slate-950/70 rounded border border-slate-800/80">
                {recentBars.map((pct, idx) => (
                  <div
                    key={idx}
                    className={cn('w-1 rounded-full transition-all duration-300', idx === recentBars.length - 1 ? priceTrend === 'up' ? 'bg-emerald-400' : priceTrend === 'down' ? 'bg-rose-400' : 'bg-cyan-400' : 'bg-slate-700')}
                    style={{ height: `${pct}%` }}
                  />
                ))}
              </div>
            )}

            {hasAuthoritativeDecision && dynamicOptimal && (
              <Badge
                id="optimal-target-badge"
                variant="outline"
                className={cn(
                  'text-[11px] font-mono px-2.5 py-1 border flex items-center gap-1.5 shadow-sm transition-all duration-300 font-bold',
                  isUpdating || tickPulse
                    ? 'border-cyan-400/60 text-cyan-300 bg-cyan-500/20 scale-105 ring-2 ring-cyan-500/20'
                    : 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20'
                )}
              >
                <Zap className={cn('w-3.5 h-3.5 text-amber-400 fill-amber-400', (isUpdating || tickPulse) && 'animate-bounce')} />
                <span>{dynamicOptimal.label}</span>
                <RefreshCw className={cn('w-2.5 h-2.5 text-slate-400 ml-0.5', isUpdating && 'animate-spin')} />
              </Badge>
            )}
          </div>
        </div>

        {availableUnits.length > 1 && (
          <div className="flex items-center justify-between gap-1 pt-0.5">
            <div className="flex items-center gap-1 bg-black/50 p-1 rounded-lg border border-white/10 text-[10px] flex-1">
              <span className="text-slate-400 text-[9px] px-1.5 font-bold uppercase tracking-wider shrink-0">Horizon:</span>
              <button id="horizon-auto-button" type="button" onClick={() => onAutoHorizonModeChange('auto')} className={cn('flex-1 py-1 px-2 rounded-md font-medium transition-all text-center flex items-center justify-center gap-1 text-[11px]', autoHorizonMode === 'auto' ? 'bg-indigo-600 text-white font-bold shadow-sm shadow-indigo-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5')}>
                <Sparkles className="w-3 h-3 text-cyan-300" /><span>Auto</span>
              </button>
              {availableUnits.includes('t') && <button id="horizon-ticks-button" type="button" onClick={() => onAutoHorizonModeChange('t')} className={cn('flex-1 py-1 px-2 rounded-md font-medium transition-all text-center text-[11px]', autoHorizonMode === 't' ? 'bg-indigo-600 text-white font-bold shadow-sm shadow-indigo-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5')}>Ticks</button>}
              {availableUnits.includes('s') && <button id="horizon-seconds-button" type="button" onClick={() => onAutoHorizonModeChange('s')} className={cn('flex-1 py-1 px-2 rounded-md font-medium transition-all text-center text-[11px]', autoHorizonMode === 's' ? 'bg-indigo-600 text-white font-bold shadow-sm shadow-indigo-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5')}>Seconds</button>}
              {availableUnits.includes('m') && <button id="horizon-minutes-button" type="button" onClick={() => onAutoHorizonModeChange('m')} className={cn('flex-1 py-1 px-2 rounded-md font-medium transition-all text-center text-[11px]', autoHorizonMode === 'm' ? 'bg-indigo-600 text-white font-bold shadow-sm shadow-indigo-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5')}>Minutes</button>}
            </div>

            <button
              id="horizon-ensemble-toggle-button"
              type="button"
              onClick={() => setShowEnsembleDetails(!showEnsembleDetails)}
              className="text-[10px] font-medium text-slate-400 hover:text-cyan-400 flex items-center gap-1 px-2 py-1.5 rounded-lg bg-black/40 hover:bg-black/60 border border-white/10 transition-all shrink-0"
              title="Toggle Multi-Horizon Ensemble details"
            >
              <Layers className="w-3 h-3 text-cyan-400" />
              <span className="hidden xs:inline">Surface</span>
              {showEnsembleDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          </div>
        )}

        <div className="text-[11px] text-slate-300 leading-relaxed bg-black/40 p-2.5 rounded-lg border border-white/10 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 shadow-inner">
          {!telemetry.hasDecision ? (
            <div className="flex flex-col items-center gap-1 py-0.5 text-amber-400 font-medium w-full justify-center text-center">
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
              <span>AI Decision Pending</span>
              <span className="text-[9px] text-slate-500 font-normal">No optimizer horizon is available until an AI decision is ready.</span>
            </div>
          ) : (
            <>
              <span className="font-semibold text-slate-100 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                {dynamicOptimal?.label ?? 'Authoritative horizon'} selected
              </span>
              <span className="text-slate-600">·</span>
              <div className="flex items-center gap-1 text-slate-400">
                <span>Regime ({telemetry.regime.toUpperCase()}) fitness</span>
                <span className="text-cyan-300 font-bold font-mono">{telemetry.fitnessScore != null ? `${telemetry.fitnessScore}%` : 'N/A'}</span>
                <div className="w-10 h-1.5 bg-slate-800 rounded-full overflow-hidden inline-block align-middle ml-0.5">
                  <div className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-500" style={{ width: telemetry.fitnessScore != null ? `${telemetry.fitnessScore}%` : '0%' }} />
                </div>
              </div>
              <span className="text-slate-600">·</span>
              <div className="flex items-center gap-1 text-slate-400">
                <span>Model agreement</span>
                <span className="text-slate-200 font-bold font-mono">{telemetry.consensusText}</span>
              </div>
              <span className="text-slate-600">·</span>
              <div className="flex items-center gap-1 text-slate-400">
                <span>Calibrated Win Probability</span>
                <span className="text-emerald-400 font-bold font-mono bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">{telemetry.winExp !== null ? `${telemetry.winExp.toFixed(1)}%` : 'N/A'}</span>
              </div>
            </>
          )}
        </div>

        {showEnsembleDetails && (
          <div className="p-3 bg-black/60 rounded-lg border border-white/10 space-y-2 text-xs text-slate-300 animate-in fade-in slide-in-from-top-1 duration-200">
            <div className="flex items-center justify-between border-b border-white/10 pb-1.5">
              <span className="font-bold text-slate-200 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5 text-cyan-400" />Horizon Utility Surface Rankings</span>
              <span className="text-[10px] text-slate-400 font-mono">{decisionSnapshot ? `Confidence: ${telemetry.confidenceTier ?? 'N/A'}` : 'Waiting for server decision'}</span>
            </div>

            {decisionSnapshot?.horizonRanking && decisionSnapshot.horizonRanking.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 pt-1">
                {decisionSnapshot.horizonRanking.slice(0, 8).map((item, idx) => (
                  <div key={item.key || idx} className={cn('p-2 rounded-lg border text-center transition-all', idx === 0 ? 'bg-indigo-950/50 border-indigo-500/50 shadow-xs ring-1 ring-indigo-500/30' : 'bg-slate-900/60 border-slate-800 hover:border-slate-700')}>
                    <div className="flex items-center justify-between text-[10px] text-slate-400"><span className="font-bold text-indigo-400">{idx === 0 ? '🏆 CHAMPION' : `#${idx + 1}`}</span><span className="font-mono">{item.unit.toUpperCase()}</span></div>
                    <div className="font-bold text-slate-100 mt-1">{item.label}</div>
                    <div className="flex items-center justify-between text-[9px] text-slate-400 mt-1 font-mono"><span>Exp: {item.calibratedProbability}%</span><span className="text-emerald-400 font-bold">U: {(item.score * 100).toFixed(1)}</span></div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-4 text-slate-400 gap-1.5">
                <RefreshCw className="w-5 h-5 text-indigo-400 animate-spin" />
                <span className="font-medium text-[11px]">No active surface rankings available</span>
                <span className="text-[9px] text-slate-500">Waiting for authoritative server decision...</span>
              </div>
            )}

            {decisionSnapshot && (
              <div className="mt-3.5 pt-3 border-t border-white/10 space-y-3.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-200 flex items-center gap-1.5"><Gauge className="w-3.5 h-3.5 text-cyan-400" />Microstructure Drift &amp; Anomaly Forensic Analytics</span>
                  <span className="text-[10px] text-slate-400 font-mono">Authoritative AI Decision: {decisionSnapshot.modelSnapshotId.split('-').slice(0, 2).join('-')}</span>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="p-3 rounded-lg border border-white/5 bg-black/40 space-y-2">
                    <div className="flex items-center justify-between"><span className="text-[10px] uppercase font-bold text-slate-500">Anomaly Score</span><span className={cn('text-[10px] font-extrabold px-1.5 py-0.2 rounded font-mono', anomalyScoreVal != null && anomalyScoreVal >= 0.70 ? 'bg-rose-500/15 text-rose-400' : anomalyScoreVal != null && anomalyScoreVal >= 0.40 ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/15 text-emerald-400')}>{anomalyScoreVal == null ? 'UNAVAILABLE' : anomalyScoreVal >= 0.70 ? 'CRITICAL' : anomalyScoreVal >= 0.40 ? 'ELEVATED' : 'STABLE'}</span></div>
                    <div className="flex items-baseline justify-between"><span className="text-xl font-black text-slate-200">{anomalyScoreVal != null ? `${(anomalyScoreVal * 100).toFixed(1)}%` : 'N/A'}</span><span className="text-[9px] text-slate-500 font-mono">Z-score proxy</span></div>
                    <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden"><div className={cn('h-full transition-all duration-500', anomalyScoreVal == null ? 'bg-slate-500' : anomalyScoreVal >= 0.70 ? 'bg-rose-500' : anomalyScoreVal >= 0.40 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: anomalyScoreVal != null ? `${anomalyScoreVal * 100}%` : '0%' }} /></div>
                  </div>

                  <div className="p-3 rounded-lg border border-white/5 bg-black/40 space-y-2">
                    <div className="flex items-center justify-between"><span className="text-[10px] uppercase font-bold text-slate-500">Micro-Volatility</span><span className="text-[10px] font-mono text-cyan-400">Vol Ratio: {telemetry.speedProfile?.microVariance != null ? `${(Math.sqrt(telemetry.speedProfile.microVariance) / 0.001).toFixed(2)}x` : 'N/A'}</span></div>
                    <div className="flex flex-col gap-0.5">
                      <div className="flex justify-between text-[10px]"><span className="text-slate-400">Tick Velocity:</span><span className="font-mono font-bold text-slate-300">{telemetry.speedProfile?.tickVelocity != null ? telemetry.speedProfile.tickVelocity.toFixed(4) : 'N/A'}</span></div>
                      <div className="flex justify-between text-[10px]"><span className="text-slate-400">Directional Streak:</span><span className="font-mono font-bold text-slate-300">{telemetry.speedProfile?.directionalPersistence != null ? `${(telemetry.speedProfile.directionalPersistence * 100).toFixed(1)}%` : 'N/A'}</span></div>
                      <div className="flex justify-between text-[10px]"><span className="text-slate-400">Kaufman ER:</span><span className="font-mono font-bold text-slate-300">{telemetry.speedProfile?.efficiencyRatio != null ? telemetry.speedProfile.efficiencyRatio.toFixed(3) : 'N/A'}</span></div>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg border border-white/5 bg-black/40 space-y-2">
                    <div className="flex items-center justify-between"><span className="text-[10px] uppercase font-bold text-slate-500">Statistical Drift</span><span className={cn('text-[10px] font-extrabold px-1.5 py-0.2 rounded font-mono', telemetry.driftProfile?.driftState === 'DRIFT_SEVERE' ? 'bg-rose-500/15 text-rose-400' : telemetry.driftProfile?.driftState === 'DRIFT_ELEVATED' ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/15 text-emerald-400')}>{telemetry.driftProfile?.driftState ? telemetry.driftProfile.driftState.replace('DRIFT_', '') : 'UNAVAILABLE'}</span></div>
                    <div className="flex flex-col gap-0.5">
                      <div className="flex justify-between text-[10px]"><span className="text-slate-400">Safeguard Action:</span><span className={cn('font-bold font-mono text-[9px]', telemetry.driftProfile?.recommendedAction === 'RESTRICT_EXECUTION_ADVISORY' ? 'text-rose-400' : telemetry.driftProfile?.recommendedAction === 'TIGHTEN_RISK' ? 'text-amber-400' : 'text-emerald-400')}>{telemetry.driftProfile?.recommendedAction ? telemetry.driftProfile.recommendedAction.replace(/_/g, ' ') : 'UNAVAILABLE'}</span></div>
                      <div className="flex justify-between text-[10px]"><span className="text-slate-400">Calibration Gap:</span><span className="font-mono font-bold text-slate-300">{telemetry.driftProfile?.overallMetrics?.calibrationGap != null ? `${(telemetry.driftProfile.overallMetrics.calibrationGap * 100).toFixed(1)}%` : 'N/A'}</span></div>
                      <div className="flex justify-between text-[10px]"><span className="text-slate-400">Brier Error Score:</span><span className="font-mono font-bold text-slate-300">{telemetry.driftProfile?.overallMetrics?.brierScore != null ? telemetry.driftProfile.overallMetrics.brierScore.toFixed(4) : 'N/A'}</span></div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
