'use client';

import { useState, useMemo } from 'react';
import type { ActiveSymbol } from '@deriv/core';
import { Activity, Flame, ChevronDown, Sparkles, TrendingUp, TrendingDown, Layers } from 'lucide-react';

interface TickSentimentBarProps {
  prices?: number[];
  activeSymbol?: ActiveSymbol | null;
  className?: string;
}

export type HorizonOption = 'auto' | 10 | 25 | 50 | 100 | 300;

export interface MarketRegime {
  label: string;
  color: string;
  badgeBg: string;
  badgeBorder: string;
}

/**
 * Helper to determine asset category and dynamic horizons
 */
function getAssetCategoryInfo(symbolKey?: string) {
  if (!symbolKey) {
    return {
      category: 'Synthetics',
      defaultHorizon: 25,
      pyramid: [5, 25, 100, 300],
    };
  }

  const s = symbolKey.toUpperCase();
  if (s.startsWith('R_') || s.includes('HZ') || s.includes('VOLATILITY') || s.includes('BOOM') || s.includes('CRASH') || s.includes('JUMP')) {
    return {
      category: 'Synthetic Volatility Index',
      defaultHorizon: 25,
      pyramid: [5, 25, 100, 300],
    };
  }
  if (s.startsWith('FRX') || s.includes('EUR') || s.includes('USD') || s.includes('GBP') || s.includes('JPY') || s.includes('AUD')) {
    return {
      category: 'Forex Currency Pair',
      defaultHorizon: 30,
      pyramid: [10, 30, 90, 250],
    };
  }
  if (s.includes('XAU') || s.includes('XAG') || s.includes('OIL') || s.includes('GOLD') || s.includes('SILVER')) {
    return {
      category: 'Commodity & Metal',
      defaultHorizon: 20,
      pyramid: [5, 20, 60, 180],
    };
  }
  if (s.includes('BTC') || s.includes('ETH') || s.includes('CRYPTO')) {
    return {
      category: 'Cryptocurrency',
      defaultHorizon: 25,
      pyramid: [5, 25, 75, 200],
    };
  }

  return {
    category: 'Market Asset',
    defaultHorizon: 25,
    pyramid: [5, 25, 100, 300],
  };
}

/**
 * Calculates uptick and downtick statistics for a price series over a given window size
 */
function calculateTickMetrics(prices: number[], windowSize: number) {
  if (!prices || prices.length < 2) {
    return {
      upCount: 0,
      downCount: 0,
      equalCount: 0,
      totalCount: 0,
      risePercent: 50,
      fallPercent: 50,
    };
  }

  // Slice the last (windowSize + 1) prices to get windowSize price changes
  const recentPrices = prices.slice(-Math.min(prices.length, windowSize + 1));
  let upCount = 0;
  let downCount = 0;
  let equalCount = 0;

  for (let i = 1; i < recentPrices.length; i++) {
    const diff = recentPrices[i] - recentPrices[i - 1];
    if (diff > 0) {
      upCount++;
    } else if (diff < 0) {
      downCount++;
    } else {
      equalCount++;
    }
  }

  const activeChanges = upCount + downCount;
  if (activeChanges === 0) {
    return {
      upCount,
      downCount,
      equalCount,
      totalCount: recentPrices.length - 1,
      risePercent: 50,
      fallPercent: 50,
    };
  }

  const risePercent = Math.round((upCount / activeChanges) * 100);
  const fallPercent = 100 - risePercent;

  return {
    upCount,
    downCount,
    equalCount,
    totalCount: activeChanges,
    risePercent,
    fallPercent,
  };
}

/**
 * Evaluates market regime / macro direction across short and long horizons
 */
function evaluateMarketRegime(risePct: number, fallPct: number, shortRisePct: number): MarketRegime {
  if (risePct >= 65 && shortRisePct >= 60) {
    return {
      label: 'BULLISH MOMENTUM',
      color: 'text-emerald-400',
      badgeBg: 'bg-emerald-500/10',
      badgeBorder: 'border-emerald-500/30',
    };
  }
  if (fallPct >= 65 && (100 - shortRisePct) >= 60) {
    return {
      label: 'BEARISH MOMENTUM',
      color: 'text-rose-400',
      badgeBg: 'bg-rose-500/10',
      badgeBorder: 'border-rose-500/30',
    };
  }
  if (Math.abs(risePct - shortRisePct) > 30) {
    return {
      label: 'VOLATILE REVERSAL',
      color: 'text-amber-400',
      badgeBg: 'bg-amber-500/10',
      badgeBorder: 'border-amber-500/30',
    };
  }
  return {
    label: 'RANGING',
    color: 'text-blue-400',
    badgeBg: 'bg-blue-500/10',
    badgeBorder: 'border-blue-500/30',
  };
}

export function TickSentimentBar({ prices = [], activeSymbol, className = '' }: TickSentimentBarProps) {
  const [selectedHorizon, setSelectedHorizon] = useState<HorizonOption>('auto');
  const [showDetails, setShowDetails] = useState(false);

  // Asset category info
  const assetInfo = useMemo(
    () => getAssetCategoryInfo(activeSymbol?.underlying_symbol),
    [activeSymbol?.underlying_symbol]
  );

  // Effective primary window
  const activeWindow = useMemo(() => {
    if (selectedHorizon === 'auto') return assetInfo.defaultHorizon;
    return selectedHorizon;
  }, [selectedHorizon, assetInfo.defaultHorizon]);

  // Primary tick metrics
  const metrics = useMemo(
    () => calculateTickMetrics(prices, activeWindow),
    [prices, activeWindow]
  );

  // Short horizon metrics (e.g. 5 ticks) for momentum check
  const shortMetrics = useMemo(
    () => calculateTickMetrics(prices, 5),
    [prices]
  );

  // Multi-horizon pyramid metrics
  const pyramidMetrics = useMemo(() => {
    return assetInfo.pyramid.map((h) => ({
      horizon: h,
      metrics: calculateTickMetrics(prices, h),
    }));
  }, [prices, assetInfo.pyramid]);

  // Market regime
  const regime = useMemo(
    () => evaluateMarketRegime(metrics.risePercent, metrics.fallPercent, shortMetrics.risePercent),
    [metrics.risePercent, metrics.fallPercent, shortMetrics.risePercent]
  );

  return (
    <div className={`w-full rounded-2xl bg-[#0e131d]/90 border border-white/10 p-3.5 shadow-xl backdrop-blur-md flex flex-col gap-2.5 ${className}`}>
      {/* Top Row: Rise % label | Live Badge | Fall % label */}
      <div className="flex items-center justify-between text-xs font-semibold">
        {/* Rise Sentiment */}
        <div className="flex items-center gap-1.5 text-emerald-400">
          <TrendingUp className="h-4 w-4" />
          <span className="text-sm font-bold tracking-tight">{metrics.risePercent}% Rise</span>
        </div>

        {/* Live Badge & Horizon Trigger */}
        <div className="flex items-center gap-2">
          <div
            onClick={() => setShowDetails(!showDetails)}
            className="group flex cursor-pointer items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-gray-300 transition-all hover:border-white/20 hover:bg-white/10"
            title="Click to view Multi-Horizon Pyramid analysis"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
            </span>
            <Sparkles className="h-3 w-3 text-indigo-400 group-hover:rotate-12 transition-transform" />
            <span className="font-medium tracking-wide">Live AI Tick Sentiment</span>
            <ChevronDown className={`h-3 w-3 text-gray-400 transition-transform ${showDetails ? 'rotate-180' : ''}`} />
          </div>
        </div>

        {/* Fall Sentiment */}
        <div className="flex items-center gap-1.5 text-rose-400">
          <span className="text-sm font-bold tracking-tight">{metrics.fallPercent}% Fall</span>
          <TrendingDown className="h-4 w-4" />
        </div>
      </div>

      {/* Progress Bar */}
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-gray-800/80 p-0.5 shadow-inner">
        <div className="flex h-full w-full overflow-hidden rounded-full">
          <div
            className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-300 ease-out"
            style={{ width: `${metrics.risePercent}%` }}
          />
          <div
            className="h-full bg-gradient-to-r from-rose-500 to-rose-700 transition-all duration-300 ease-out"
            style={{ width: `${metrics.fallPercent}%` }}
          />
        </div>
      </div>

      {/* Bottom Info Row: Pyramid summary + Macro Regime + Up/Down counter */}
      <div className="flex items-center justify-between text-[11px] text-gray-400 pt-0.5">
        {/* Asset & Pyramid info */}
        <div className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          <span className="truncate max-w-[170px] sm:max-w-none">
            Pyramid ({assetInfo.pyramid.join('/')} Ticks)
          </span>
        </div>

        {/* Macro Regime Badge */}
        <div className={`rounded-md px-2 py-0.5 text-[10px] font-bold border tracking-wider ${regime.badgeBg} ${regime.badgeBorder} ${regime.color}`}>
          MACRO: {regime.label}
        </div>

        {/* Up / Down Ticks Live Counter */}
        <div className="flex items-center gap-1.5 font-bold tracking-tight">
          <span className="text-emerald-400 flex items-center gap-0.5">
            {metrics.upCount} <span className="text-[9px]">▲</span>
          </span>
          <span className="text-gray-500">/</span>
          <span className="text-rose-400 flex items-center gap-0.5">
            {metrics.downCount} <span className="text-[9px]">▼</span>
          </span>
        </div>
      </div>

      {/* Expanded Multi-Horizon Pyramid Details Panel */}
      {showDetails && (
        <div className="mt-2 pt-2.5 border-t border-white/10 flex flex-col gap-2.5 text-xs animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-gray-300 font-semibold text-[11px]">
              <Layers className="h-3.5 w-3.5 text-indigo-400" />
              <span>Multi-Horizon Sentiment Pyramid</span>
            </div>

            {/* Horizon Window Selector Pills */}
            <div className="flex items-center gap-1 bg-black/40 p-1 rounded-lg border border-white/5">
              {(['auto', 10, 25, 50, 100] as const).map((opt) => (
                <button
                  key={String(opt)}
                  onClick={() => setSelectedHorizon(opt)}
                  className={`px-2 py-0.5 text-[10px] font-semibold rounded-md transition-colors ${
                    selectedHorizon === opt
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
                  }`}
                >
                  {opt === 'auto' ? `Auto (${assetInfo.defaultHorizon}t)` : `${opt}t`}
                </button>
              ))}
            </div>
          </div>

          {/* Pyramid Breakdown Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {pyramidMetrics.map(({ horizon, metrics: hMetrics }) => (
              <div
                key={horizon}
                className="flex flex-col gap-1 p-2 rounded-xl bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors"
              >
                <div className="flex items-center justify-between text-[10px] text-gray-400 font-medium">
                  <span>{horizon} Ticks</span>
                  <span className="font-bold text-gray-300">
                    {hMetrics.upCount}▲ / {hMetrics.downCount}▼
                  </span>
                </div>
                {/* Mini bar */}
                <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden flex">
                  <div
                    className="h-full bg-emerald-500"
                    style={{ width: `${hMetrics.risePercent}%` }}
                  />
                  <div
                    className="h-full bg-rose-500"
                    style={{ width: `${hMetrics.fallPercent}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] font-bold">
                  <span className="text-emerald-400">{hMetrics.risePercent}% Rise</span>
                  <span className="text-rose-400">{hMetrics.fallPercent}% Fall</span>
                </div>
              </div>
            ))}
          </div>

          <div className="text-[10px] text-gray-400 flex items-center gap-1 italic">
            <Flame className="h-3 w-3 text-amber-400 shrink-0" />
            <span>
              Category: <strong className="text-gray-300 not-italic">{assetInfo.category}</strong>. Automatically adjusts sample windows based on volatility tick speeds.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
