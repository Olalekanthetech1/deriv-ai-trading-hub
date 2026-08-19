'use client';

import { useMemo, useState } from 'react';
import { ArrowUpDown, Radio, TrendingUp, Sparkles, FileText, Layers } from 'lucide-react';
import { AppTradingMode, ModeSelectionModal } from './mode-selection-modal';
import { SignalsDrawer } from './signals-drawer';
import type { ActiveSymbol } from '@deriv/core';
import type { TradeSignal } from '@/hooks/use-realtime-signals';
import type { HorizonDecisionSnapshot } from '@/lib/horizon-decision-engine';
import { buildConsensus, buildModeRecommendations } from '@/lib/signal-manager';

interface ModeNavBarProps {
  activeMode: AppTradingMode;
  onSelectMode: (mode: AppTradingMode) => void;
  activeSymbol: ActiveSymbol | null;
  onOpenPositions?: () => void;
  activePositionsCount?: number;
  signals?: TradeSignal[];
  decisionSnapshot?: HorizonDecisionSnapshot | null;
  highConfidenceCount?: number;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
  winStats?: { total: number; winCount: number; accuracy?: string } | null;
  onAutoFillTrade?: (signal: TradeSignal) => void;
  onQuickExecute?: (signal: TradeSignal) => Promise<void>;
  isBuying?: boolean;
}

export function ModeNavBar({ activeMode, onSelectMode, activeSymbol, onOpenPositions, activePositionsCount = 0, signals = [], decisionSnapshot = null, highConfidenceCount = 0, soundEnabled = true, onToggleSound = () => {}, winStats, onAutoFillTrade = () => {}, onQuickExecute = async () => {}, isBuying = false }: ModeNavBarProps) {
  const [isModeModalOpen, setIsModeModalOpen] = useState(false);
  const [isSignalsOpen, setIsSignalsOpen] = useState(false);

  const consensus = useMemo(() => {
    if (!signals || !signals.length) return null;
    try {
      return buildConsensus(signals, Date.now());
    } catch (err) {
      console.warn('[ModeNavBar] Failed to compute consensus:', err);
      return null;
    }
  }, [signals]);

  const modeRecommendations = useMemo(() => {
    if (!signals || !signals.length) return [];
    try {
      return buildModeRecommendations(signals);
    } catch (err) {
      console.warn('[ModeNavBar] Failed to compute mode recommendations:', err);
      return [];
    }
  }, [signals]);

  const getActiveModeInfo = () => {
    switch (activeMode) {
      case 'pro': return { label: 'Pro mode', icon: <TrendingUp className="w-5 h-5 text-cyan-300" />, glowClass: 'bg-cyan-950/80 border-cyan-400/80 text-cyan-200 shadow-cyan-500/30' };
      case 'ai': return { label: 'AI Trader', icon: <Sparkles className="w-5 h-5 text-purple-300" />, glowClass: 'bg-purple-950/80 border-purple-400/80 text-purple-200 shadow-purple-500/30' };
      default: return { label: 'Classic mode', icon: <ArrowUpDown className="w-5 h-5 text-emerald-300" />, glowClass: 'bg-emerald-950/80 border-emerald-500/80 text-emerald-200 shadow-emerald-500/30' };
    }
  };
  const modeInfo = getActiveModeInfo();

  return (
    <>
      <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-40 w-[95%] max-w-lg"><div className="rounded-2xl bg-[#0d121d]/90 border border-white/10 p-1.5 shadow-2xl backdrop-blur-xl flex items-center justify-between">
        <button type="button" onClick={() => onSelectMode('classic')} className={`flex-1 flex flex-col items-center justify-center py-1.5 px-1 rounded-xl transition-all ${activeMode === 'classic' ? 'text-white' : 'text-gray-400 hover:text-gray-200'}`}><Layers className="w-4 h-4 mb-0.5" /><span className="text-[10px] font-medium tracking-tight">Trades</span></button>
        <button type="button" onClick={() => setIsSignalsOpen(true)} className="flex-1 flex flex-col items-center justify-center py-1.5 px-1 rounded-xl text-gray-400 hover:text-gray-200 transition-all relative group"><div className="relative flex items-center justify-center">{highConfidenceCount > 0 && <><span className="absolute -inset-1.5 rounded-full bg-cyan-400/40 animate-ping opacity-75" /><span className="absolute -inset-1 rounded-full bg-cyan-500/20 animate-pulse" /></> }<Radio className={`w-4 h-4 mb-0.5 relative z-10 transition-colors ${highConfidenceCount > 0 ? 'text-cyan-400' : 'group-hover:text-cyan-300'}`} />{highConfidenceCount > 0 && <span className="absolute -top-1.5 -right-3.5 z-20 px-1.5 py-0.5 rounded-full bg-cyan-400 text-slate-950 text-[9px] font-black leading-none shadow-lg shadow-cyan-500/50 flex items-center justify-center min-w-[16px] animate-bounce">{highConfidenceCount}</span>}</div><span className={`text-[10px] font-medium tracking-tight ${highConfidenceCount > 0 ? 'text-cyan-300 font-semibold' : ''}`}>Signals</span></button>
        <button type="button" onClick={() => setIsModeModalOpen(true)} className={`relative px-4 py-2 rounded-xl border flex items-center gap-2 font-bold text-xs shadow-lg transition-all transform active:scale-95 ${modeInfo.glowClass}`}><div className="absolute inset-0 rounded-xl bg-white/5 animate-pulse pointer-events-none" />{modeInfo.icon}<span className="leading-none">{modeInfo.label}</span></button>
        <button type="button" onClick={onOpenPositions} className="flex-1 flex flex-col items-center justify-center py-1.5 px-1 rounded-xl text-gray-400 hover:text-gray-200 transition-all relative group"><div className="relative flex items-center justify-center">{activePositionsCount > 0 && <><span className="absolute -inset-1.5 rounded-full bg-emerald-400/40 animate-ping opacity-75" /><span className="absolute -inset-1 rounded-full bg-emerald-500/20 animate-pulse" /></> }<FileText className={`w-4 h-4 mb-0.5 relative z-10 transition-colors ${activePositionsCount > 0 ? 'text-emerald-400' : 'group-hover:text-emerald-300'}`} />{activePositionsCount > 0 && <span className="absolute -top-1.5 -right-3.5 z-20 px-1.5 py-0.5 rounded-full bg-emerald-400 text-slate-950 text-[9px] font-black leading-none shadow-lg shadow-emerald-500/50 flex items-center justify-center min-w-[16px] animate-bounce">{activePositionsCount}</span>}</div><span className={`text-[10px] font-medium tracking-tight ${activePositionsCount > 0 ? 'text-emerald-300 font-semibold' : ''}`}>Positions</span></button>
      </div></div>

      <ModeSelectionModal isOpen={isModeModalOpen} onClose={() => setIsModeModalOpen(false)} activeMode={activeMode} onSelectMode={onSelectMode} />
      <SignalsDrawer isOpen={isSignalsOpen} onClose={() => setIsSignalsOpen(false)} activeSymbol={activeSymbol} signals={signals} consensus={consensus} modeRecommendations={modeRecommendations} decisionSnapshot={decisionSnapshot} soundEnabled={soundEnabled} onToggleSound={onToggleSound} winStats={winStats} onAutoFillTrade={onAutoFillTrade} onQuickExecute={onQuickExecute} isBuying={isBuying} />
    </>
  );
}
