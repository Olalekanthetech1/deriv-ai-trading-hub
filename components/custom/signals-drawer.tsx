'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, Clock, Cpu, Layers, Radio, RefreshCw, ShieldCheck, Sliders, Sparkles, Target, TrendingDown, TrendingUp, Volume2, VolumeX, X, Zap } from 'lucide-react';
import type { ActiveSymbol } from '@deriv/core';
import type { DurationPrediction, TradeSignal } from '@/hooks/use-realtime-signals';
import type { SignalConsensus, SignalModeRecommendation } from '@/lib/signal-manager';
import type { MultiModelEvaluationResult } from '@/lib/multi-model-ui-types';
import type { HorizonDecisionSnapshot } from '@/lib/horizon-decision-engine';
import { MultiModelEvaluationCard } from './multi-model-evaluation-card';

interface SignalsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeSymbol: ActiveSymbol | null;
  signals: TradeSignal[];
  consensus: SignalConsensus | null;
  modeRecommendations: SignalModeRecommendation[];
  decisionSnapshot?: HorizonDecisionSnapshot | null;
  soundEnabled: boolean;
  onToggleSound: () => void;
  winStats?: { total: number; winCount: number; accuracy?: string } | null;
  onAutoFillTrade: (signal: TradeSignal) => void;
  onQuickExecute: (signal: TradeSignal) => Promise<void>;
  isBuying?: boolean;
}

function formatExpiry(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  return `${minutes}m ${String(safe % 60).padStart(2, '0')}s`;
}

export function SignalsDrawer({ isOpen, onClose, activeSymbol, signals, consensus, modeRecommendations, decisionSnapshot, soundEnabled, onToggleSound, winStats, onAutoFillTrade, onQuickExecute, isBuying = false }: SignalsDrawerProps) {
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'signals' | 'multimodel' | 'hde'>('signals');
  const [selectedDurationFilter, setSelectedDurationFilter] = useState('ALL');
  const [ensembleData, setEnsembleData] = useState<MultiModelEvaluationResult | null>(null);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [ensembleError, setEnsembleError] = useState<string | null>(null);

  const executableConsensus = consensus && (consensus.direction === 'RISE' || consensus.direction === 'FALL') ? consensus : null;
  const consensusDuration = useMemo(() => executableConsensus?.recommendedDuration ?? null, [executableConsensus]);

  const fetchEnsembleData = async () => {
    setIsEvaluating(true);
    setEnsembleError(null);
    try {
      const symbol = activeSymbol?.underlying_symbol;
      if (!symbol) throw new Error('LIVE_ANALYSIS_ASSET_UNAVAILABLE');
      if (!consensusDuration) throw new Error('LIVE_ANALYSIS_DURATION_UNAVAILABLE');
      const durationValue = consensusDuration.value;
      const durationUnit = consensusDuration.unit;
      const durationSecs = consensusDuration.seconds;
      if (!Number.isFinite(durationValue) || durationValue <= 0 || !Number.isFinite(durationSecs) || durationSecs <= 0) throw new Error('LIVE_ANALYSIS_DURATION_INVALID');
      const response = await fetch('/api/ml/predict', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ symbol, durationSecs, durationValue, durationUnit }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success !== true || !data?.multiModelEnsemble) throw new Error(typeof data?.error === 'string' ? data.error : `Multi-Model evaluation request failed (${response.status})`);
      setEnsembleData(data.multiModelEnsemble as MultiModelEvaluationResult);
    } catch (error) {
      setEnsembleError(error instanceof Error ? error.message : 'LIVE_MULTI_MODEL_ANALYSIS_UNAVAILABLE');
      setEnsembleData(null);
    } finally {
      setIsEvaluating(false);
    }
  };

  useEffect(() => { if (isOpen && activeTab === 'multimodel') void fetchEnsembleData(); }, [isOpen, activeTab, activeSymbol, consensusDuration]);
  if (!isOpen) return null;

  const durationOptions = useMemo(() => {
    const unique = new Map<string, { id: string; label: string }>();
    for (const signal of signals) {
      unique.set(`${signal.recommendedDurationValue}${signal.recommendedDurationUnit}`, { id: `${signal.recommendedDurationValue}${signal.recommendedDurationUnit}`, label: signal.recommendedDurationLabel });
      for (const duration of signal.durationMatrix ?? []) unique.set(`${duration.value}${duration.unit}`, { id: `${duration.value}${duration.unit}`, label: duration.label });
    }
    return [{ id: 'ALL', label: 'All Live Durations' }, ...Array.from(unique.values()).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))];
  }, [signals]);

  const visibleSignals = selectedDurationFilter === 'ALL' ? signals : signals.filter((signal) => {
    const unit = selectedDurationFilter.replace(/[0-9]/g, '');
    const value = Number(selectedDurationFilter.replace(/[^0-9]/g, ''));
    return signal.recommendedDurationValue === value && signal.recommendedDurationUnit === unit;
  });

  const handleQuickExecute = async (signal: TradeSignal) => {
    setExecutingId(signal.id);
    try { await onQuickExecute(signal); } finally { setExecutingId(null); }
  };

  const handleSelectDurationPrediction = (signal: TradeSignal, duration: DurationPrediction) => {
    onAutoFillTrade({ ...signal, direction: duration.direction, confidence: duration.confidence, recommendedDurationValue: duration.value, recommendedDurationUnit: duration.unit, recommendedDurationLabel: duration.label, winRate: duration.winRate });
  };

  if (activeTab === 'signals' && signals.length === 0) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="relative w-full max-w-lg rounded-3xl border border-white/10 bg-[#0a0f1d] p-6 shadow-2xl">
        <button type="button" aria-label="Close signals" onClick={onClose} className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-gray-400"><X className="h-4 w-4" /></button>
        <Radio className="mx-auto h-8 w-8 animate-pulse text-cyan-400" />
        <p className="mt-3 text-center text-sm font-medium text-gray-300">Live signal analysis unavailable until the next verified model output.</p>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-md sm:items-center sm:p-4">
      <button aria-label="Close signals" className="absolute inset-0" onClick={onClose} />
      <div className="relative z-10 max-h-[88vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-3xl border border-white/10 bg-[#0a0f1d] p-5 shadow-2xl sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <div className="flex items-center gap-2.5"><Radio className="h-5 w-5 text-cyan-400" /><div><div className="flex items-center gap-2"><h2 className="text-base font-bold text-white">Real-Time Trading Radar</h2><span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] font-extrabold text-cyan-300">LIVE</span></div><p className="text-[11px] text-gray-400">Unified AI signal manager &amp; multi-model radar</p></div></div>
          <div className="flex items-center gap-2"><button type="button" onClick={onToggleSound} className="rounded-xl border border-white/10 bg-white/5 p-2 text-gray-300">{soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}</button><button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-gray-400"><X className="h-4 w-4" /></button></div>
        </div>

        <div className="flex items-center justify-between rounded-2xl border border-indigo-500/20 bg-indigo-950/40 p-3"><div className="flex items-center gap-3"><ShieldCheck className="h-5 w-5 text-indigo-400" /><div><div className="text-xs font-semibold text-indigo-200">Verified Trade Outcomes</div><div className="text-[11px] text-gray-400">{winStats ? `${winStats.winCount} Wins / ${winStats.total} Resolved Contracts` : 'Live trade statistics unavailable'}</div></div></div><div className="text-right text-base font-black text-emerald-400">{winStats?.accuracy ?? 'UNAVAILABLE'}</div></div>

        {executableConsensus && <div className={`space-y-3 rounded-2xl border p-4 ${executableConsensus.direction === 'RISE' ? 'border-emerald-500/30 bg-emerald-950/20' : 'border-rose-500/30 bg-rose-950/20'}`}>
          <div className="flex items-center justify-between"><div><div className="text-[10px] font-black uppercase tracking-wider text-gray-400">AI Consensus Recommendation</div><div className={`mt-0.5 text-xl font-black ${executableConsensus.direction === 'RISE' ? 'text-emerald-300' : 'text-rose-300'}`}>{executableConsensus.direction} {executableConsensus.direction === 'RISE' ? '↑' : '↓'}</div></div><div className="text-right"><div className="text-lg font-black text-cyan-300">{executableConsensus.confidence}%</div><div className="text-[9px] text-gray-400">confidence</div></div></div>
          <div className="grid grid-cols-3 gap-2 rounded-xl border border-white/5 bg-black/30 p-2 text-center"><div><div className="text-[9px] text-gray-500">CONSENSUS</div><div className="font-bold text-white">{executableConsensus.agreement}% Agree</div></div><div><div className="text-[9px] text-gray-500">DURATION</div><div className="font-bold text-white">{executableConsensus.recommendedDuration.label}</div></div><div><div className="text-[9px] text-gray-500">EXPIRY</div><div className="font-mono font-bold text-cyan-300">{formatExpiry(executableConsensus.expiresInSeconds)}</div></div></div>
        </div>}

        {modeRecommendations.length > 0 && <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3"><div className="text-[10px] font-black uppercase tracking-wider text-gray-400">Mode Recommendations</div><div className="grid grid-cols-3 gap-2">{modeRecommendations.map((rec) => <button key={rec.mode} type="button" onClick={() => { const source = signals.find((s) => s.id === rec.sourceSignalId); if (source) onAutoFillTrade(source); }} className="rounded-xl border border-white/10 bg-black/30 p-2 text-left"><div className="text-[9px] font-bold text-gray-500">{rec.mode}</div><div className={`text-sm font-black ${rec.direction === 'RISE' ? 'text-emerald-300' : 'text-rose-300'}`}>{rec.direction}</div><div className="text-[10px] font-bold text-cyan-300">{rec.confidence}% · {rec.duration.label}</div></button>)}</div></div>}

        <div className="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 p-2.5 text-xs"><span>Asset: <strong className="text-white">{activeSymbol?.underlying_symbol_name}</strong></span><span className="flex items-center gap-1 font-semibold text-cyan-400"><Activity className="h-3.5 w-3.5" /> Tick Engine Active</span></div>

        <div className="grid grid-cols-3 gap-1.5 rounded-2xl border border-slate-800 bg-slate-950 p-1"><button type="button" onClick={() => setActiveTab('signals')} className={`rounded-xl py-2 text-[11px] font-bold ${activeTab === 'signals' ? 'border border-cyan-500/40 bg-cyan-500/20 text-cyan-300' : 'text-slate-400'}`}><Radio className="mr-1 inline h-3.5 w-3.5" /> AI Signals</button><button type="button" onClick={() => setActiveTab('hde')} className={`rounded-xl py-2 text-[11px] font-bold ${activeTab === 'hde' ? 'border border-emerald-500/40 bg-emerald-500/20 text-emerald-300' : 'text-slate-400'}`}><Sparkles className="mr-1 inline h-3.5 w-3.5" /> Horizon Engine</button><button type="button" onClick={() => setActiveTab('multimodel')} className={`rounded-xl py-2 text-[11px] font-bold ${activeTab === 'multimodel' ? 'border border-purple-500/40 bg-purple-500/20 text-purple-300' : 'text-slate-400'}`}><Cpu className="mr-1 inline h-3.5 w-3.5" /> Multi-Model</button></div>

        {activeTab === 'hde' && decisionSnapshot ? <div className="space-y-3"><div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/20 p-3.5"><div className="flex items-center justify-between"><span className="text-xs font-bold uppercase tracking-wider text-white">HDE Optimal Decision</span><span className="rounded border border-emerald-500/40 bg-emerald-500/20 px-2 py-0.5 text-[10px] font-black text-emerald-300">{decisionSnapshot.decision.status}</span></div><div className="mt-2 flex items-center justify-between"><div><div className="text-xl font-black text-white">{decisionSnapshot.decision.horizon.label}</div><div className="text-[11px] text-gray-400">{decisionSnapshot.decisionReason.summary}</div></div><div className={`text-right text-base font-black ${decisionSnapshot.decision.direction === 'RISE' ? 'text-emerald-400' : 'text-rose-400'}`}>{decisionSnapshot.decision.direction}<div className="text-[10px] font-mono text-cyan-300">{decisionSnapshot.decision.modelProbability}% Model Probability</div></div></div></div><div className="space-y-1.5"><div className="flex items-center justify-between px-1 text-[10px] font-black uppercase tracking-wider text-gray-400"><span>Live Horizon Rankings</span><span className="text-cyan-400">Model Output + Consensus</span></div>{decisionSnapshot.horizonRanking.map((item, idx) => <div key={item.key} className="flex items-center justify-between rounded-xl border border-white/5 bg-black/30 p-2.5 text-xs"><div className="flex items-center gap-2"><span className="text-[10px] font-bold text-gray-500">#{idx + 1}</span><span className="font-bold text-white">{item.label}</span><span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${item.direction === 'RISE' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>{item.direction}</span></div><div className="flex items-center gap-3 text-right"><div><div className="text-[9px] text-gray-400">REGIME / CONS</div><div className="font-mono text-[10px] text-gray-200">{item.regimeFitness === null ? 'DISABLED' : item.regimeFitness.toFixed(1)} / {item.modelAgreement.toFixed(1)}</div></div><div><div className="text-[9px] text-gray-400">MODEL PROB</div><div className="font-bold text-cyan-300">{item.modelProbability.toFixed(1)}%</div></div><div><div className="text-[9px] text-gray-400">SCORE</div><div className="font-black text-emerald-400 font-mono">{item.score.toFixed(3)}</div></div></div></div>)}</div></div> : activeTab === 'hde' ? <div className="rounded-2xl border border-white/5 bg-white/5 p-8 text-center"><Sparkles className="mx-auto h-8 w-8 animate-pulse text-emerald-400" /><p className="mt-2 text-sm font-medium text-gray-300">Horizon analysis unavailable.</p></div> : activeTab === 'multimodel' ? <div className="space-y-3"><div className="flex items-center justify-between"><span className="text-xs text-slate-400">Live Model Engines</span><button type="button" onClick={() => void fetchEnsembleData()} disabled={isEvaluating} className="flex items-center gap-1 text-[11px] font-bold text-cyan-400 disabled:opacity-50"><RefreshCw className={isEvaluating ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} /> Refresh</button></div>{ensembleError ? <div className="rounded-2xl border border-rose-500/30 bg-rose-950/30 p-4 text-xs text-rose-200"><div className="font-bold">Multi-Model analysis unavailable</div><div className="mt-1 break-words text-rose-300/80">{ensembleError}</div></div> : <MultiModelEvaluationCard ensemble={ensembleData} />}</div> : <>
          <div className="flex gap-1.5 overflow-x-auto pb-1"><span className="mr-1 flex shrink-0 items-center gap-1 text-[10px] font-bold uppercase text-gray-400"><Layers className="h-3 w-3 text-cyan-400" /> Duration:</span>{durationOptions.map((option) => <button key={option.id} type="button" onClick={() => setSelectedDurationFilter(option.id)} className={`whitespace-nowrap rounded-xl border px-2.5 py-1 text-xs font-semibold ${selectedDurationFilter === option.id ? 'border-cyan-500/50 bg-cyan-500/20 text-cyan-300' : 'border-white/5 bg-white/5 text-gray-400'}`}>{option.label}</button>)}</div>
          <div className="space-y-3">{visibleSignals.map((signal) => { const isRise = signal.direction === 'RISE'; const isExecuting = executingId === signal.id; const isHighConfidence = signal.confidence >= 88; return <div key={signal.id} className={`space-y-3 rounded-2xl border p-3.5 ${isHighConfidence ? 'border-cyan-500/40 bg-[#10192b]' : 'border-white/10 bg-[#101625]'}`}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="flex flex-wrap items-center gap-1.5"><span className="text-xs font-bold text-white">{signal.name}</span></div><p className="line-clamp-1 text-[11px] text-gray-400">{signal.description}</p></div><div className={`flex items-center gap-1 rounded-xl border px-2.5 py-1 text-xs font-black ${isRise ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-300' : 'border-rose-500/40 bg-rose-500/20 text-rose-300'}`}>{isRise ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />} {signal.direction}</div></div><div className="text-[10px] font-mono font-bold text-cyan-300">{signal.confidence}% Model</div>{signal.durationMatrix?.length ? <div className="space-y-1"><div className="text-[10px] font-extrabold uppercase text-gray-400">Predicted Horizon Matrix</div><div className="grid grid-cols-4 gap-1.5">{signal.durationMatrix.map((duration) => <button key={`${duration.value}${duration.unit}`} type="button" onClick={() => handleSelectDurationPrediction(signal, duration)} className="rounded-xl border border-white/5 bg-black/30 p-1.5 text-center"><div className="text-[10px] font-bold">{duration.label}</div><div className={`flex items-center justify-center gap-0.5 text-[10px] font-black ${duration.direction === 'RISE' ? 'text-emerald-400' : 'text-rose-400'}`}>{duration.direction} {duration.confidence}%</div></button>)}</div></div> : null}<div className="grid grid-cols-3 gap-2 rounded-xl border border-white/5 bg-black/40 p-2 text-[11px]"><div><div className="text-[9px] text-gray-400">REC. DURATION</div><div className="font-bold text-white">{signal.recommendedDurationLabel}</div></div><div><div className="text-[9px] text-gray-400">TARGET</div><div className="font-mono font-bold text-white">{signal.targetBarrier}</div></div><div className="text-right"><div className="text-[9px] text-gray-400">EXPIRY</div><div className="font-mono font-bold text-cyan-400">{formatExpiry(signal.expiresInSeconds)}</div></div></div><div className="text-[10px] text-gray-500">Signal is live model output; model probability is not historical win rate.</div><div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => onAutoFillTrade(signal)} className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-xs font-bold text-white"><Sliders className="h-3.5 w-3.5 text-cyan-400" /> Auto-Fill Form</button><button type="button" disabled={isBuying || isExecuting || signal.expiresInSeconds <= 0} onClick={() => void handleQuickExecute(signal)} className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-extrabold text-white ${isRise ? 'border-emerald-400/30 bg-emerald-600' : 'border-rose-400/30 bg-rose-600'}`}>{isExecuting ? <Radio className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} {isExecuting ? 'Placing Trade...' : `Execute ${signal.direction}`}</button></div></div>; })}</div>
        </>}
      </div>
    </div>
  );
}
