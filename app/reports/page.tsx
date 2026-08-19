'use client';

export const dynamic = 'force-dynamic';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useRiseFallTrading } from '../../hooks/use-rise-fall-trading';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { useLogoSrc } from '@/components/custom/logo-src-provider';
import { Header } from '@/components/custom/header';
import { ThemeToggle } from '@/components/custom/theme-toggle';
import { Footer } from '@/components/custom/footer';
import Link from 'next/link';
import { PositionsTable } from '@/components/custom/positions-table';
import { MarketCategorySelector } from '@/components/admin/market-category-selector';
import { Download, ArrowLeft, TrendingUp, TrendingDown, DollarSign, Award, Percent, BarChart3, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

const RISE_FALL_CONTRACT_LABELS: Record<string, string> = {
  CALL: 'Rise',
  PUT: 'Fall',
  CALLE: 'Rise (Equal)',
  PUTE: 'Fall (Equal)',
};

function getCategoryForSymbol(symbolName: string): string {
  const code = symbolName || '';
  if (code.startsWith('R_') || code.endsWith('V')) return 'synthetic';
  if (code.startsWith('JD')) return 'jump';
  if (code.startsWith('FRX')) return 'forex';
  if (code.includes('XAU') || code.startsWith('CWM')) return 'commodities';
  return 'synthetic';
}

export default function ReportsPage() {
  const logoSrc = useLogoSrc();
  const router = useRouter();
  const { ws, isConnected, isExhausted, auth } = useDerivWSContext();
  const { authState, accounts, activeAccount, login, signUp, logout, switchAccount } = auth;
  const trading = useRiseFallTrading({ ws, isConnected, isExhausted, isAuthenticated: !!auth.wsUrl, onAuthWSFailed: logout });

  const [selectedSymbolFilter, setSelectedSymbolFilter] = useState<string>('ALL');

  useEffect(() => {
    if (authState === 'unauthenticated' || authState === 'error') {
      router.replace('/');
    }
  }, [authState, router]);

  // All trades filtered to Rise/Fall
  const allOpen = useMemo(() => {
    return trading.openPositions.filter(p => Object.keys(RISE_FALL_CONTRACT_LABELS).includes(p.contract_type));
  }, [trading.openPositions]);

  const allClosed = useMemo(() => {
    return trading.closedPositions.filter(p => Object.keys(RISE_FALL_CONTRACT_LABELS).includes(p.contract_type));
  }, [trading.closedPositions]);

  // Symbol / Category Filter logic
  const filteredOpen = useMemo(() => {
    if (selectedSymbolFilter === 'ALL' || !selectedSymbolFilter) return allOpen;
    const cat = ['synthetic', 'jump', 'forex', 'commodities'].includes(selectedSymbolFilter) ? selectedSymbolFilter : null;
    if (cat) {
      return allOpen.filter(p => getCategoryForSymbol(p.underlying_symbol) === cat);
    }
    return allOpen.filter(p => p.underlying_symbol === selectedSymbolFilter);
  }, [allOpen, selectedSymbolFilter]);

  const filteredClosed = useMemo(() => {
    if (selectedSymbolFilter === 'ALL' || !selectedSymbolFilter) return allClosed;
    const cat = ['synthetic', 'jump', 'forex', 'commodities'].includes(selectedSymbolFilter) ? selectedSymbolFilter : null;
    if (cat) {
      return allClosed.filter(p => getCategoryForSymbol(p.underlying_symbol) === cat);
    }
    return allClosed.filter(p => p.underlying_symbol === selectedSymbolFilter);
  }, [allClosed, selectedSymbolFilter]);

  // Compute Metrics
  const metrics = useMemo(() => {
    const totalTrades = allClosed.length;
    let wins = 0;
    let losses = 0;
    let totalProfit = 0;
    let totalBuyPrice = 0;

    allClosed.forEach((p) => {
      const buyPrice = typeof p.buy_price === 'number' ? p.buy_price : parseFloat(String(p.buy_price) || '0');
      const sellPrice = typeof p.sell_price === 'number' ? p.sell_price : parseFloat(String(p.sell_price) || '0');
      const profit = sellPrice - buyPrice;
      totalProfit += profit;
      totalBuyPrice += buyPrice;
      if (profit > 0) wins++;
      else if (profit < 0) losses++;
    });

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const avgStake = totalTrades > 0 ? totalBuyPrice / totalTrades : 0;

    return {
      totalTrades,
      wins,
      losses,
      totalProfit,
      winRate: winRate.toFixed(1),
      avgStake: avgStake.toFixed(2),
    };
  }, [allClosed]);

  const handleExportCSV = () => {
    if (allClosed.length === 0) {
      toast.info('No closed position history available to export.');
      return;
    }
    const headers = ['Contract ID', 'Underlying', 'Contract Type', 'Buy Price', 'Sell Price', 'Profit/Loss', 'Purchase Time'];
    const rows = allClosed.map(p => {
      const buyPrice = typeof p.buy_price === 'number' ? p.buy_price : parseFloat(String(p.buy_price) || '0');
      const sellPrice = typeof p.sell_price === 'number' ? p.sell_price : parseFloat(String(p.sell_price) || '0');
      return [
        p.contract_id,
        p.underlying_symbol,
        p.contract_type,
        buyPrice,
        sellPrice,
        (sellPrice - buyPrice).toFixed(2),
        p.purchase_time ? new Date(p.purchase_time * 1000).toISOString() : '',
      ];
    });

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `trading_report_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Trading report exported successfully as CSV!');
  };

  if (authState !== 'authenticated') {
    return (
      <main className="flex flex-col bg-background items-center justify-center min-h-dvh">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </main>
    );
  }

  return (
    <main className="flex flex-col bg-background max-lg:h-dvh max-lg:overflow-y-auto lg:min-h-dvh">
      <Header
        authState={authState}
        accounts={accounts}
        activeAccount={activeAccount}
        onLogin={login}
        onSignUp={signUp}
        onLogout={logout}
        onSwitchAccount={switchAccount}
        logoSrc={logoSrc}
        actions={<ThemeToggle />}
      />

      {/* Spacer */}
      <div className="h-[76px] shrink-0" />

      <div className="flex-1 w-full max-w-7xl mx-auto px-3 py-4 sm:px-4 sm:py-6 pb-20">
        {/* Navigation & Actions */}
        <div className="flex items-center justify-between mb-4">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-400 hover:text-slate-100 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            <span>Return to Trading Workspace</span>
          </Link>
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition-all shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Statement (CSV)</span>
          </button>
        </div>

        {/* Executive Metrics Overview */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider">Win Rate</span>
              <Percent className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="text-2xl font-bold text-slate-100">{metrics.winRate}%</div>
            <div className="text-[11px] text-slate-400 mt-1">{metrics.wins} Wins / {metrics.losses} Losses</div>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider">Net Profit</span>
              <DollarSign className="w-4 h-4 text-emerald-400" />
            </div>
            <div className={`text-2xl font-bold ${metrics.totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {metrics.totalProfit >= 0 ? '+' : ''}${metrics.totalProfit.toFixed(2)}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">Closed PnL Total</div>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider">Total Trades</span>
              <BarChart3 className="w-4 h-4 text-purple-400" />
            </div>
            <div className="text-2xl font-bold text-slate-100">{metrics.totalTrades}</div>
            <div className="text-[11px] text-slate-400 mt-1">{allOpen.length} Active Positions</div>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider">Avg Stake</span>
              <Award className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-2xl font-bold text-slate-100">${metrics.avgStake}</div>
            <div className="text-[11px] text-slate-400 mt-1">Per Position Executed</div>
          </div>
        </div>

        {/* Market Category Selector Bar */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 mb-6">
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
            Filter Activity by Market Category
          </span>
          <MarketCategorySelector
            selectedSymbol={selectedSymbolFilter}
            onSelectSymbol={(sym) => setSelectedSymbolFilter(sym)}
          />
        </div>

        {/* Positions & Execution History */}
        <PositionsTable
          openPositions={filteredOpen}
          closedPositions={filteredClosed}
          onSell={trading.sellContract}
          sellingId={trading.sellingId}
          sellError={trading.sellError}
          onClearSellError={trading.clearSellError}
          contractTypeLabels={RISE_FALL_CONTRACT_LABELS}
          className="mt-0"
        />
      </div>

      {/* Fixed footer */}
      <div className="fixed bottom-0 left-0 right-0 py-2 text-center bg-background/80 backdrop-blur-sm z-10 border-t border-border">
        <Footer />
      </div>
    </main>
  );
}

