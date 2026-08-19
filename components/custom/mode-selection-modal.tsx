'use client';

import { TrendingUp, ArrowUpDown, Sparkles } from 'lucide-react';

export type AppTradingMode = 'classic' | 'pro' | 'ai';

interface ModeSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeMode: AppTradingMode;
  onSelectMode: (mode: AppTradingMode) => void;
}

export function ModeSelectionModal({
  isOpen,
  onClose,
  activeMode,
  onSelectMode,
}: ModeSelectionModalProps) {
  if (!isOpen) return null;

  return (
    <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-50 w-full max-w-sm px-2 animate-in fade-in slide-in-from-bottom-3 duration-200">
      {/* Backdrop for click outside */}
      <div className="fixed inset-0 -z-10 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Floating 3-Mode Picker Bar (Matching Video / Screenshot) */}
      <div className="rounded-2xl bg-[#0d121d]/95 border border-white/20 p-2 shadow-2xl backdrop-blur-xl flex items-center justify-between gap-2">
        {/* Classic Mode Pill */}
        <button
          type="button"
          onClick={() => {
            onSelectMode('classic');
            onClose();
          }}
          className={`flex-1 flex flex-col items-center justify-center p-2.5 rounded-xl border transition-all duration-150 ${
            activeMode === 'classic'
              ? 'bg-gradient-to-b from-emerald-950/80 to-slate-900 border-emerald-500 text-white shadow-lg shadow-emerald-950/60 ring-1 ring-emerald-400/50'
              : 'bg-card/60 border-white/10 text-gray-300 hover:bg-white/10 hover:text-white'
          }`}
        >
          <div className="w-7 h-7 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-1">
            <ArrowUpDown className="w-4 h-4" />
          </div>
          <span className="text-[11px] font-bold tracking-tight leading-tight">
            Classic mode
          </span>
        </button>

        {/* Pro Mode Pill */}
        <button
          type="button"
          onClick={() => {
            onSelectMode('pro');
            onClose();
          }}
          className={`flex-1 flex flex-col items-center justify-center p-2.5 rounded-xl border transition-all duration-150 ${
            activeMode === 'pro'
              ? 'bg-gradient-to-b from-cyan-950/80 to-slate-900 border-cyan-400 text-white shadow-lg shadow-cyan-950/60 ring-1 ring-cyan-300/50'
              : 'bg-card/60 border-white/10 text-gray-300 hover:bg-white/10 hover:text-white'
          }`}
        >
          <div className="w-7 h-7 rounded-lg bg-cyan-500/20 border border-cyan-400/30 flex items-center justify-center text-cyan-300 mb-1">
            <TrendingUp className="w-4 h-4" />
          </div>
          <span className="text-[11px] font-bold tracking-tight leading-tight">
            Pro mode
          </span>
        </button>

        {/* AI Trader Pill */}
        <button
          type="button"
          onClick={() => {
            onSelectMode('ai');
            onClose();
          }}
          className={`flex-1 flex flex-col items-center justify-center p-2.5 rounded-xl border transition-all duration-150 ${
            activeMode === 'ai'
              ? 'bg-gradient-to-b from-purple-950/80 to-slate-900 border-purple-400 text-white shadow-lg shadow-purple-950/60 ring-1 ring-purple-300/50'
              : 'bg-card/60 border-white/10 text-gray-300 hover:bg-white/10 hover:text-white'
          }`}
        >
          <div className="w-7 h-7 rounded-lg bg-purple-500/20 border border-purple-400/30 flex items-center justify-center text-purple-300 mb-1">
            <Sparkles className="w-4 h-4" />
          </div>
          <span className="text-[11px] font-bold tracking-tight leading-tight">
            AI Trader
          </span>
        </button>
      </div>
    </div>
  );
}
