'use client';

import { cn } from '@/lib/utils';
import type { ClosedPosition } from '@/hooks/use-closed-positions';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';
import { getPositionDurationLabel } from '@/lib/duration-formatter';
import { StrategyBadge } from './positions-table';
import { tradeStrategyStore } from '@/lib/trade-store';

interface ClosedPositionCardProps {
  pos: ClosedPosition;
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

export function ClosedPositionCard({
  pos,
  contractTypeLabels,
}: ClosedPositionCardProps) {
  const { label: dirLabel } = getDirectionDisplay(
    pos.contract_type,
    contractTypeLabels
  );
  const profit = pos.sell_price - pos.buy_price;
  const isProfit = profit >= 0;
  const duration = pos.sell_time - pos.purchase_time;
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

      {/* Duration & Result Badge */}
      <div className="flex items-center justify-between border-b border-slate-800/60 pb-2">
        <span className="text-xs font-mono text-slate-400">
          Elapsed: {formatDuration(duration)} ({getPositionDurationLabel(pos)})
        </span>
        <span
          className={cn(
            'px-2.5 py-0.5 rounded-md text-[10px] font-black tracking-wider uppercase',
            isProfit
              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
              : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
          )}
        >
          {isProfit ? 'WON' : 'LOST'}
        </span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] text-slate-400 font-medium">Net P&amp;L</p>
          <p
            className={cn(
              'text-sm font-black font-mono',
              isProfit ? 'text-emerald-400' : 'text-rose-400'
            )}
          >
            {isProfit ? '+' : ''}${profit.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-slate-400 font-medium">Sell Price</p>
          <p className="text-sm font-bold font-mono text-slate-200">
            ${pos.sell_price.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-slate-400 font-medium">Stake</p>
          <p className="text-xs font-bold font-mono text-slate-300">
            ${pos.buy_price.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-slate-400 font-medium">Payout</p>
          <p className="text-xs font-bold font-mono text-slate-300">
            ${pos.payout.toFixed(2)}
          </p>
        </div>
      </div>
    </div>
  );
}
