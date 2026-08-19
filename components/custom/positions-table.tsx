'use client';

import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';
import { OpenPositionCard } from './open-position-card';
import { ClosedPositionCard } from './closed-position-card';
import { getPositionDurationLabel } from '@/lib/duration-formatter';
import { tradeStrategyStore } from '@/lib/trade-store';
import type { OpenPosition } from '@/hooks/use-open-positions';
import type { ClosedPosition } from '@/hooks/use-closed-positions';
import {
  Search,
  Download,
  TrendingUp,
  TrendingDown,
  Target,
  Wallet,
  Layers,
  CheckCircle2,
  XCircle,
  Cpu,
  UserCheck,
  BarChart3,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

export type PositionFilter = 'open' | 'closed' | 'all' | 'wins' | 'losses';

interface PositionsTableProps {
  openPositions: OpenPosition[];
  closedPositions: ClosedPosition[];
  onSell: (contractId: number, bidPrice: string) => Promise<void>;
  sellingId: number | null;
  sellError: string | null;
  onClearSellError: () => void;
  /** Map from contract_type string to display label. Falls back to raw type. */
  contractTypeLabels?: Record<string, string>;
  /** Merged onto the root wrapper (spacing, max-height, overflow). */
  className?: string;
}

const VALUE_COL_HEADER: Record<PositionFilter, string> = {
  open: 'Current Value',
  closed: 'Sell Price',
  all: 'Value',
  wins: 'Sell Price',
  losses: 'Sell Price',
};

function formatContractType(
  contractType: string,
  labels: Record<string, string>,
  barrier?: string
): string {
  const label = labels[contractType] ?? contractType;
  return barrier !== undefined ? `${label} (${barrier})` : label;
}

export function StrategyBadge({ strategy }: { strategy?: string }) {
  const stratName = strategy || 'Manual';
  const isAuto =
    stratName.toLowerCase().includes('auto') ||
    stratName.toLowerCase().includes('ensemble') ||
    stratName.toLowerCase().includes('horizon') ||
    stratName.toLowerCase().includes('ai');

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-extrabold tracking-tight border shadow-xs',
        isAuto
          ? 'bg-purple-500/15 text-purple-300 border-purple-500/30'
          : 'bg-slate-800 text-slate-300 border-slate-700'
      )}
    >
      {isAuto ? (
        <Cpu className="w-3 h-3 text-purple-400" />
      ) : (
        <UserCheck className="w-3 h-3 text-slate-400" />
      )}
      <span>{stratName}</span>
    </span>
  );
}

export function PositionsTable({
  openPositions,
  closedPositions,
  onSell,
  sellingId,
  sellError,
  onClearSellError,
  contractTypeLabels = {},
  className,
}: PositionsTableProps) {
  const [filter, setFilter] = useState<PositionFilter>('open');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAttribution, setShowAttribution] = useState(true);

  useEffect(() => {
    if (sellError) {
      toast.error('Sell Failed', { description: sellError });
      onClearSellError();
    }
  }, [sellError, onClearSellError]);

  // Executive Stats Calculation
  const stats = useMemo(() => {
    const wins = closedPositions.filter((p) => p.sell_price > p.buy_price);
    const losses = closedPositions.filter((p) => p.sell_price <= p.buy_price);
    const realizedPnL = closedPositions.reduce(
      (sum, p) => sum + (p.sell_price - p.buy_price),
      0
    );
    const totalClosedStake = closedPositions.reduce((sum, p) => sum + p.buy_price, 0);
    const totalOpenStake = openPositions.reduce(
      (sum, p) => sum + (parseFloat(p.buy_price) || 0),
      0
    );
    const floatingPnL = openPositions.reduce(
      (sum, p) => sum + (parseFloat(p.profit) || 0),
      0
    );
    const winRate =
      closedPositions.length > 0 ? (wins.length / closedPositions.length) * 100 : 0;

    return {
      winsCount: wins.length,
      lossesCount: losses.length,
      realizedPnL,
      totalVolume: totalClosedStake + totalOpenStake,
      floatingPnL,
      winRate: winRate.toFixed(1),
    };
  }, [openPositions, closedPositions]);

  // Strategy Attribution Breakdown Calculation
  const strategyAttribution = useMemo(() => {
    let aiWins = 0,
      aiLosses = 0,
      aiPnL = 0,
      aiVolume = 0;
    let manualWins = 0,
      manualLosses = 0,
      manualPnL = 0,
      manualVolume = 0;

    closedPositions.forEach((p) => {
      const strat = tradeStrategyStore.getContractStrategy(p.contract_id);
      const isAuto =
        strat.toLowerCase().includes('auto') ||
        strat.toLowerCase().includes('ensemble') ||
        strat.toLowerCase().includes('horizon') ||
        strat.toLowerCase().includes('ai');
      const profit = p.sell_price - p.buy_price;
      const isWin = profit > 0;

      if (isAuto) {
        if (isWin) aiWins++;
        else aiLosses++;
        aiPnL += profit;
        aiVolume += p.buy_price;
      } else {
        if (isWin) manualWins++;
        else manualLosses++;
        manualPnL += profit;
        manualVolume += p.buy_price;
      }
    });

    const aiTotal = aiWins + aiLosses;
    const manualTotal = manualWins + manualLosses;
    const aiWinRate = aiTotal > 0 ? (aiWins / aiTotal) * 100 : 0;
    const manualWinRate = manualTotal > 0 ? (manualWins / manualTotal) * 100 : 0;

    return {
      ai: {
        total: aiTotal,
        wins: aiWins,
        losses: aiLosses,
        winRate: aiWinRate.toFixed(1),
        pnl: aiPnL,
        volume: aiVolume,
      },
      manual: {
        total: manualTotal,
        wins: manualWins,
        losses: manualLosses,
        winRate: manualWinRate.toFixed(1),
        pnl: manualPnL,
        volume: manualVolume,
      },
    };
  }, [closedPositions]);

  // Search & Filtering
  const filteredOpen = useMemo(() => {
    if (filter === 'closed' || filter === 'wins' || filter === 'losses') return [];
    return openPositions.filter((p) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const strat = tradeStrategyStore.getContractStrategy(p.contract_id).toLowerCase();
      return (
        p.contract_id.toString().includes(q) ||
        p.underlying_symbol.toLowerCase().includes(q) ||
        getSymbolDisplayName(p.underlying_symbol).toLowerCase().includes(q) ||
        p.contract_type.toLowerCase().includes(q) ||
        strat.includes(q)
      );
    });
  }, [openPositions, filter, searchQuery]);

  const filteredClosed = useMemo(() => {
    if (filter === 'open') return [];
    return closedPositions.filter((p) => {
      const isWin = p.sell_price > p.buy_price;
      if (filter === 'wins' && !isWin) return false;
      if (filter === 'losses' && isWin) return false;

      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const strat = tradeStrategyStore.getContractStrategy(p.contract_id).toLowerCase();
      return (
        p.contract_id.toString().includes(q) ||
        p.underlying_symbol.toLowerCase().includes(q) ||
        getSymbolDisplayName(p.underlying_symbol).toLowerCase().includes(q) ||
        p.contract_type.toLowerCase().includes(q) ||
        strat.includes(q)
      );
    });
  }, [closedPositions, filter, searchQuery]);

  const handleExportCSV = () => {
    if (closedPositions.length === 0) {
      toast.info('No closed positions to export');
      return;
    }
    const headers = [
      'Contract ID',
      'Symbol',
      'Symbol Name',
      'Type',
      'Strategy Source',
      'Buy Price ($)',
      'Sell Price ($)',
      'Payout ($)',
      'Net Profit ($)',
      'Status',
      'Purchase Time',
      'Sell Time',
    ];

    const rows = closedPositions.map((p) => {
      const profit = p.sell_price - p.buy_price;
      const isWin = profit > 0;
      const strat = tradeStrategyStore.getContractStrategy(p.contract_id);
      return [
        p.contract_id,
        p.underlying_symbol,
        `"${getSymbolDisplayName(p.underlying_symbol)}"`,
        p.contract_type,
        `"${strat}"`,
        p.buy_price.toFixed(2),
        p.sell_price.toFixed(2),
        p.payout.toFixed(2),
        profit.toFixed(2),
        isWin ? 'WON' : 'LOST',
        new Date(p.purchase_time * 1000).toISOString(),
        new Date(p.sell_time * 1000).toISOString(),
      ];
    });

    const csvContent = [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Deriv_Trade_Report_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Trade Report exported to CSV');
  };

  return (
    <div className={cn('space-y-5', className)}>
      {/* Top Analytics Summary Metrics Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Metric 1: Realized PnL */}
        <div className="rounded-2xl bg-slate-900/80 border border-slate-800/80 p-3.5 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-1">
            <span>Realized P&amp;L</span>
            {stats.realizedPnL >= 0 ? (
              <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <TrendingDown className="w-3.5 h-3.5 text-rose-400" />
            )}
          </div>
          <div
            className={cn(
              'text-lg font-black tracking-tight font-mono',
              stats.realizedPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'
            )}
          >
            {stats.realizedPnL >= 0 ? '+' : ''}${stats.realizedPnL.toFixed(2)}
          </div>
          <div className="text-[10px] text-slate-500 font-medium mt-0.5">
            {closedPositions.length} settled trade{closedPositions.length === 1 ? '' : 's'}
          </div>
        </div>

        {/* Metric 2: Win Rate */}
        <div className="rounded-2xl bg-slate-900/80 border border-slate-800/80 p-3.5 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-1">
            <span>Win Accuracy</span>
            <Target className="w-3.5 h-3.5 text-indigo-400" />
          </div>
          <div className="text-lg font-black tracking-tight font-mono text-indigo-300">
            {stats.winRate}%
          </div>
          <div className="flex items-center gap-1.5 text-[10px] font-semibold mt-0.5">
            <span className="text-emerald-400">{stats.winsCount} W</span>
            <span className="text-slate-600">|</span>
            <span className="text-rose-400">{stats.lossesCount} L</span>
          </div>
        </div>

        {/* Metric 3: Total Traded Volume */}
        <div className="rounded-2xl bg-slate-900/80 border border-slate-800/80 p-3.5 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-1">
            <span>Total Volume</span>
            <Wallet className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="text-lg font-black tracking-tight font-mono text-purple-300">
            ${stats.totalVolume.toFixed(2)}
          </div>
          <div className="text-[10px] text-slate-500 font-medium mt-0.5">
            Staked capital
          </div>
        </div>

        {/* Metric 4: Floating Open PnL */}
        <div className="rounded-2xl bg-slate-900/80 border border-slate-800/80 p-3.5 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-1">
            <span>Floating Open P&amp;L</span>
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
          </div>
          <div
            className={cn(
              'text-lg font-black tracking-tight font-mono',
              stats.floatingPnL >= 0 ? 'text-cyan-300' : 'text-amber-400'
            )}
          >
            {stats.floatingPnL >= 0 ? '+' : ''}${stats.floatingPnL.toFixed(2)}
          </div>
          <div className="text-[10px] text-slate-500 font-medium mt-0.5">
            {openPositions.length} active position{openPositions.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      {/* Performance Attribution Breakdown Panel */}
      <div className="rounded-2xl border border-purple-500/20 bg-gradient-to-br from-slate-900/90 via-purple-950/20 to-slate-900/90 p-4 shadow-xl backdrop-blur-md space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-300">
              <BarChart3 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                Strategy Attribution Performance
                <Sparkles className="w-3 h-3 text-purple-400" />
              </h3>
              <p className="text-[11px] text-slate-400">
                Comparative Win Rate &amp; PnL breakdown: AI Auto-Trader vs. Manual Trade
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowAttribution(!showAttribution)}
            className="text-xs text-slate-400 hover:text-white p-1 rounded-lg bg-slate-800/60 border border-slate-700/60"
          >
            {showAttribution ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>
        </div>

        {showAttribution && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-800/80">
            {/* Card 1: AI Auto Trader Strategy */}
            <div className="rounded-xl bg-purple-950/30 border border-purple-500/30 p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-purple-300">
                  <Cpu className="w-3.5 h-3.5 text-purple-400" />
                  AI Auto-Trader Strategy
                </span>
                <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/40 text-[10px] font-extrabold font-mono">
                  {strategyAttribution.ai.winRate}% Win Rate
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 pt-1 font-mono">
                <div>
                  <span className="text-[10px] text-slate-400 block">Net P&amp;L</span>
                  <span
                    className={cn(
                      'text-sm font-black',
                      strategyAttribution.ai.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    )}
                  >
                    {strategyAttribution.ai.pnl >= 0 ? '+' : ''}$
                    {strategyAttribution.ai.pnl.toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">Executed</span>
                  <span className="text-xs font-bold text-slate-200">
                    {strategyAttribution.ai.total} Trades
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">Record</span>
                  <span className="text-xs font-semibold text-slate-300">
                    <span className="text-emerald-400">{strategyAttribution.ai.wins}W</span> /{' '}
                    <span className="text-rose-400">{strategyAttribution.ai.losses}L</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Card 2: Manual Trade Strategy */}
            <div className="rounded-xl bg-slate-950/40 border border-slate-800 p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-300">
                  <UserCheck className="w-3.5 h-3.5 text-indigo-400" />
                  Manual Trade Execution
                </span>
                <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700 text-[10px] font-extrabold font-mono">
                  {strategyAttribution.manual.winRate}% Win Rate
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 pt-1 font-mono">
                <div>
                  <span className="text-[10px] text-slate-400 block">Net P&amp;L</span>
                  <span
                    className={cn(
                      'text-sm font-black',
                      strategyAttribution.manual.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    )}
                  >
                    {strategyAttribution.manual.pnl >= 0 ? '+' : ''}$
                    {strategyAttribution.manual.pnl.toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">Executed</span>
                  <span className="text-xs font-bold text-slate-200">
                    {strategyAttribution.manual.total} Trades
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">Record</span>
                  <span className="text-xs font-semibold text-slate-300">
                    <span className="text-emerald-400">{strategyAttribution.manual.wins}W</span> /{' '}
                    <span className="text-rose-400">{strategyAttribution.manual.losses}L</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Control Bar: Filter Pills + Search Input + CSV Export */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-slate-900/60 p-2.5 rounded-2xl border border-slate-800/60">
        {/* Filter Pills */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 no-scrollbar">
          <button
            type="button"
            onClick={() => setFilter('open')}
            className={cn(
              'px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5',
              filter === 'open'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            )}
          >
            Open
            <span className="px-1.5 py-0.2 rounded-full bg-slate-950/40 text-[10px]">
              {openPositions.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilter('closed')}
            className={cn(
              'px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5',
              filter === 'closed'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            )}
          >
            Closed
            <span className="px-1.5 py-0.2 rounded-full bg-slate-950/40 text-[10px]">
              {closedPositions.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilter('all')}
            className={cn(
              'px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5',
              filter === 'all'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            )}
          >
            All
            <span className="px-1.5 py-0.2 rounded-full bg-slate-950/40 text-[10px]">
              {openPositions.length + closedPositions.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilter('wins')}
            className={cn(
              'px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5',
              filter === 'wins'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/30'
                : 'text-emerald-400/80 hover:text-emerald-300 hover:bg-emerald-500/10'
            )}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Wins ({stats.winsCount})
          </button>

          <button
            type="button"
            onClick={() => setFilter('losses')}
            className={cn(
              'px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5',
              filter === 'losses'
                ? 'bg-rose-600 text-white shadow-md shadow-rose-600/30'
                : 'text-rose-400/80 hover:text-rose-300 hover:bg-rose-500/10'
            )}
          >
            <XCircle className="w-3.5 h-3.5" />
            Losses ({stats.lossesCount})
          </button>
        </div>

        {/* Right Controls: Search & CSV Export */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:w-48">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              type="text"
              placeholder="Search symbol/source/ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 h-8 text-xs bg-slate-950/80 border-slate-800 text-slate-200 placeholder:text-slate-500 rounded-xl"
            />
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleExportCSV}
            className="h-8 px-2.5 text-xs font-semibold border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-200 gap-1.5 rounded-xl whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5 text-indigo-400" />
            <span className="hidden sm:inline">Export CSV</span>
          </Button>
        </div>
      </div>

      {/* Desktop: Full Analytical Table */}
      <div className="hidden lg:block rounded-2xl border border-slate-800/80 bg-slate-900/40 overflow-hidden shadow-xl">
        <Table>
          <TableHeader className="bg-slate-900/90 border-b border-slate-800">
            <TableRow className="hover:bg-transparent border-slate-800">
              <TableHead className="text-slate-400 text-xs font-bold uppercase tracking-wider">
                Type &amp; Symbol
              </TableHead>
              <TableHead className="text-slate-400 text-xs font-bold uppercase tracking-wider">
                Contract ID
              </TableHead>
              <TableHead className="text-slate-400 text-xs font-bold uppercase tracking-wider">
                Strategy Source
              </TableHead>
              <TableHead className="text-slate-400 text-xs font-bold uppercase tracking-wider">
                Duration
              </TableHead>
              <TableHead className="text-slate-400 text-xs font-bold uppercase tracking-wider text-right">
                Stake
              </TableHead>
              <TableHead className="text-slate-400 text-xs font-bold uppercase tracking-wider text-right">
                {VALUE_COL_HEADER[filter]}
              </TableHead>
              <TableHead className="text-slate-400 text-xs font-bold uppercase tracking-wider text-right">
                P&amp;L
              </TableHead>
              <TableHead className="text-slate-400 text-xs font-bold uppercase tracking-wider text-right">
                Action / Status
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredOpen.map((pos) => (
              <OpenPositionRow
                key={`open-${pos.contract_id}`}
                pos={pos}
                isSelling={sellingId === pos.contract_id}
                onSell={onSell}
                contractTypeLabels={contractTypeLabels}
              />
            ))}
            {filteredClosed.map((pos) => (
              <ClosedPositionRow
                key={`closed-${pos.contract_id}`}
                pos={pos}
                contractTypeLabels={contractTypeLabels}
              />
            ))}
            {filteredOpen.length === 0 && filteredClosed.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-center text-sm text-slate-500 py-12"
                >
                  No trade positions found for this query or filter.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Mobile: Full Width Card List */}
      <div className="lg:hidden flex flex-col gap-3">
        {filteredOpen.map((pos) => (
          <OpenPositionCard
            key={`open-card-${pos.contract_id}`}
            pos={pos}
            isSelling={sellingId === pos.contract_id}
            onSell={onSell}
            contractTypeLabels={contractTypeLabels}
          />
        ))}
        {filteredClosed.map((pos) => (
          <ClosedPositionCard
            key={`closed-card-${pos.contract_id}`}
            pos={pos}
            contractTypeLabels={contractTypeLabels}
          />
        ))}
        {filteredOpen.length === 0 && filteredClosed.length === 0 && (
          <div className="text-center text-sm text-slate-500 py-12 bg-slate-900/30 rounded-2xl border border-slate-800/50">
            No trade positions found for this query or filter.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Desktop Table Rows ───────────────────────────────────────────────────

function OpenPositionRow({
  pos,
  isSelling,
  onSell,
  contractTypeLabels,
}: {
  pos: OpenPosition;
  isSelling: boolean;
  onSell: (contractId: number, bidPrice: string) => Promise<void>;
  contractTypeLabels: Record<string, string>;
}) {
  const profit = parseFloat(pos.profit);
  const isProfit = profit >= 0;
  const strat = tradeStrategyStore.getContractStrategy(pos.contract_id);

  return (
    <TableRow className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
      <TableCell className="py-3 font-medium">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200 text-xs font-bold border border-slate-700">
            {getSymbolDisplayName(pos.underlying_symbol)}
          </span>
          <span className="text-xs text-slate-300 font-semibold">
            {formatContractType(pos.contract_type, contractTypeLabels, pos.barrier)}
          </span>
        </div>
      </TableCell>
      <TableCell className="py-3 text-xs font-mono text-slate-400">
        #{pos.contract_id}
      </TableCell>
      <TableCell className="py-3">
        <StrategyBadge strategy={strat} />
      </TableCell>
      <TableCell className="py-3">
        <span className="inline-flex px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-xs font-semibold">
          {getPositionDurationLabel(pos)}
        </span>
      </TableCell>
      <TableCell className="py-3 text-right font-mono text-xs font-bold text-slate-200">
        ${parseFloat(pos.buy_price).toFixed(2)}
      </TableCell>
      <TableCell className="py-3 text-right font-mono text-xs font-bold text-slate-200">
        ${parseFloat(pos.bid_price).toFixed(2)}
      </TableCell>
      <ProfitCell
        profit={profit}
        profitPct={pos.profit_percentage}
        currency=""
        isProfit={isProfit}
      />
      <TableCell className="py-3 text-right">
        <Button
          size="sm"
          variant="outline"
          disabled={isSelling || pos.is_valid_to_sell !== 1}
          onClick={() => onSell(pos.contract_id, pos.bid_price)}
          className="h-7 text-xs border-amber-500/30 text-amber-400 hover:bg-amber-500/10 rounded-lg"
        >
          {isSelling ? 'Selling...' : 'Sell Live'}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function ClosedPositionRow({
  pos,
  contractTypeLabels,
}: {
  pos: ClosedPosition;
  contractTypeLabels: Record<string, string>;
}) {
  const profit = pos.sell_price - pos.buy_price;
  const profitPct = pos.buy_price > 0 ? (profit / pos.buy_price) * 100 : 0;
  const isProfit = profit >= 0;
  const strat = tradeStrategyStore.getContractStrategy(pos.contract_id);

  return (
    <TableRow className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
      <TableCell className="py-3 font-medium">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200 text-xs font-bold border border-slate-700">
            {getSymbolDisplayName(pos.underlying_symbol)}
          </span>
          <span className="text-xs text-slate-300 font-semibold">
            {formatContractType(pos.contract_type, contractTypeLabels)}
          </span>
        </div>
      </TableCell>
      <TableCell className="py-3 text-xs font-mono text-slate-400">
        #{pos.contract_id}
      </TableCell>
      <TableCell className="py-3">
        <StrategyBadge strategy={strat} />
      </TableCell>
      <TableCell className="py-3">
        <span className="inline-flex px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 text-xs font-semibold">
          {getPositionDurationLabel(pos)}
        </span>
      </TableCell>
      <TableCell className="py-3 text-right font-mono text-xs font-bold text-slate-200">
        ${pos.buy_price.toFixed(2)}
      </TableCell>
      <TableCell className="py-3 text-right font-mono text-xs font-bold text-slate-200">
        ${pos.sell_price.toFixed(2)}
      </TableCell>
      <ProfitCell
        profit={profit}
        profitPct={profitPct}
        currency=""
        isProfit={isProfit}
      />
      <TableCell className="py-3 text-right">
        <span
          className={cn(
            'inline-flex px-2 py-0.5 rounded-md text-[11px] font-bold tracking-tight',
            isProfit
              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
              : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
          )}
        >
          {isProfit ? 'WON' : 'LOST'}
        </span>
      </TableCell>
    </TableRow>
  );
}

function ProfitCell({
  profit,
  profitPct,
  currency,
  isProfit,
}: {
  profit: number;
  profitPct: number;
  currency: string;
  isProfit: boolean;
}) {
  return (
    <TableCell
      className={cn(
        'py-3 text-right font-mono font-bold text-xs',
        isProfit ? 'text-emerald-400' : 'text-rose-400'
      )}
    >
      {isProfit ? '+' : ''}${profit.toFixed(2)}
      {currency ? ` ${currency}` : ''}
      <span className="text-[10px] font-normal ml-1 opacity-80">
        ({isProfit ? '+' : ''}
        {profitPct.toFixed(1)}%)
      </span>
    </TableCell>
  );
}
