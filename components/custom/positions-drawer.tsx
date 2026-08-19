'use client';

import { useEffect } from 'react';
import { X, Layers, Activity, ShieldCheck } from 'lucide-react';
import { PositionsTable } from './positions-table';
import type { OpenPosition } from '@/hooks/use-open-positions';
import type { ClosedPosition } from '@/hooks/use-closed-positions';

interface PositionsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  openPositions: OpenPosition[];
  closedPositions: ClosedPosition[];
  onSell: (contractId: number, bidPrice: string) => Promise<void>;
  sellingId: number | null;
  sellError: string | null;
  onClearSellError: () => void;
  contractTypeLabels?: Record<string, string>;
}

export function PositionsDrawer({
  isOpen,
  onClose,
  openPositions,
  closedPositions,
  onSell,
  sellingId,
  sellError,
  onClearSellError,
  contractTypeLabels,
}: PositionsDrawerProps) {
  // Listen for Escape key to close full-screen modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-[#060913] text-slate-100 flex flex-col w-screen h-screen overflow-hidden animate-in fade-in duration-200">
      {/* Top Navigation & Status Bar */}
      <div className="sticky top-0 z-20 bg-slate-950/90 border-b border-slate-800/80 backdrop-blur-xl px-4 sm:px-8 py-3.5 flex items-center justify-between">
        {/* Left Title & Status */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base sm:text-lg font-black tracking-tight text-white">
                Positions &amp; Performance Reports
              </h1>
              <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold tracking-wider">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                REAL-TIME WS SYNC
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">
              Full-screen live trade management, analytics summary, and settlement reports
            </p>
          </div>
        </div>

        {/* Right Action & Close Button */}
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl font-mono">
            <Activity className="w-3.5 h-3.5 text-indigo-400" />
            <span>
              {openPositions.length} Open | {closedPositions.length} Closed
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white transition-all shadow-sm"
            title="Close Full Screen View (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main Full-Screen Body */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 max-w-7xl mx-auto w-full space-y-6">
        <PositionsTable
          openPositions={openPositions}
          closedPositions={closedPositions}
          onSell={onSell}
          sellingId={sellingId}
          sellError={sellError}
          onClearSellError={onClearSellError}
          contractTypeLabels={contractTypeLabels}
        />
      </div>

      {/* Bottom Footer Info */}
      <div className="bg-slate-950 border-t border-slate-900 px-4 sm:px-8 py-2.5 text-slate-500 text-[11px] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
          <span>Deriv WebSocket Secure Protocol Stream Active</span>
        </div>
        <div className="font-mono text-[10px] text-slate-600">
          Press ESC to return to trading view
        </div>
      </div>
    </div>
  );
}
