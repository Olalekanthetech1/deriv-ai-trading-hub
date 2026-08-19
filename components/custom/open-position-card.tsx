'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { OpenPosition } from '@/hooks/use-open-positions';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';
import { getPositionDurationLabel } from '@/lib/duration-formatter';
import { StrategyBadge } from './positions-table';
import { tradeStrategyStore } from '@/lib/trade-store';

interface OpenPositionCardProps {
  pos: OpenPosition;
  isSelling: boolean;
  onSell: (contractId: number, bidPrice: string) => Promise<void>;
  contractTypeLabels: Record<string, string>;
}

function getDirectionDisplay(
  contractType: string,
  labels: Record<string, string>
): { label: string } {
  const label = labels[contractType] ?? contractType;
  return { label };
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function usePositionTimer(pos: OpenPosition) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const start = pos.date_start;
  const expiry = pos.date_expiry;
  const total = expiry - start;
  const elapsed = now - start;
  const remaining = expiry - now;
  const progress = total > 0 ? Math.min(100, Math.max(0, (elapsed / total) * 100)) : 0;
  const isExpired = remaining <= 0;

  return { elapsed, remaining, progress, isExpired };
}

export function OpenPositionCard({
  pos,
  isSelling,
  onSell,
  contractTypeLabels,
}: OpenPositionCardProps) {
  const { label: dirLabel } = getDirectionDisplay(pos.contract_type, contractTypeLabels);
  const profit = parseFloat(pos.profit);
  const isProfit = profit >= 0;
  const bidPrice = parseFloat(pos.bid_price);
  const buyPrice = parseFloat(pos.buy_price);
  const payout = parseFloat(pos.payout);
  const { elapsed, progress } = usePositionTimer(pos);
  const strat = tradeStrategyStore.getContractStrategy(pos.contract_id);

  return (
    <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-4 space-y-3.5 shadow-lg backdrop-blur-md">
      {/* Row 1: Symbol + Direction + Strategy Badge */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200 text-xs font-bold border border-slate-700">
            {getSymbolDisplayName(pos.underlying_symbol)}
          </span>
          <span className="text-xs font-semibold text-slate-300">
            {dirLabel}
          </span>
        </div>
        <StrategyBadge strategy={strat} />
      </div>

      {/* Row 2: Timer + Progress bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs font-mono text-slate-400">
          <span>Elapsed: {formatDuration(elapsed)}</span>
          <span className="text-emerald-400 font-semibold">{getPositionDurationLabel(pos)}</span>
        </div>
        <div className="h-2 rounded-full bg-slate-950/80 overflow-hidden border border-slate-800">
          <div
            className="h-full rounded-full bg-emerald-400 transition-all duration-1000 shadow-sm shadow-emerald-500/50"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3 pt-1 border-t border-slate-800/60">
        <div>
          <p className="text-[11px] text-slate-400 font-medium">Current P&amp;L</p>
          <p className={cn('text-sm font-black font-mono', isProfit ? 'text-emerald-400' : 'text-rose-400')}>
            {isProfit ? '+' : ''}${profit.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-slate-400 font-medium">Bid Value</p>
          <p className="text-sm font-bold font-mono text-slate-200">${bidPrice.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-[11px] text-slate-400 font-medium">Stake</p>
          <p className="text-xs font-bold font-mono text-slate-300">${buyPrice.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-[11px] text-slate-400 font-medium">Potential Payout</p>
          <p className="text-xs font-bold font-mono text-slate-300">${payout.toFixed(2)}</p>
        </div>
      </div>

      {/* Sell Action */}
      <Button
        size="sm"
        variant="outline"
        disabled={isSelling || pos.is_valid_to_sell !== 1}
        onClick={() => onSell(pos.contract_id, pos.bid_price)}
        className="w-full h-8 text-xs font-bold border-amber-500/30 text-amber-400 hover:bg-amber-500/10 rounded-xl"
      >
        {isSelling ? 'Selling Position...' : 'Sell Position Live'}
      </Button>
    </div>
  );
}
