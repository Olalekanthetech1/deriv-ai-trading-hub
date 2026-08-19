'use client';

import React, { useState, useMemo } from 'react';
import { Activity, Zap, DollarSign, Coins, Globe, Check, Layers } from 'lucide-react';

export interface MarketCategorySelectorProps {
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  availableSymbols?: any[];
  compact?: boolean;
}

const DEFAULT_FALLBACK_SYMBOLS = [
  { symbol: '1HZ100V', displayName: 'Volatility 100 (1s) Index', category: 'volatility_1s' },
  { symbol: '1HZ75V', displayName: 'Volatility 75 (1s) Index', category: 'volatility_1s' },
  { symbol: '1HZ50V', displayName: 'Volatility 50 (1s) Index', category: 'volatility_1s' },
  { symbol: '1HZ25V', displayName: 'Volatility 25 (1s) Index', category: 'volatility_1s' },
  { symbol: '1HZ10V', displayName: 'Volatility 10 (1s) Index', category: 'volatility_1s' },
  { symbol: 'R_100', displayName: 'Volatility 100 Index', category: 'volatility_std' },
  { symbol: 'R_75', displayName: 'Volatility 75 Index', category: 'volatility_std' },
  { symbol: 'R_50', displayName: 'Volatility 50 Index', category: 'volatility_std' },
  { symbol: 'R_25', displayName: 'Volatility 25 Index', category: 'volatility_std' },
  { symbol: 'R_10', displayName: 'Volatility 10 Index', category: 'volatility_std' },
  { symbol: 'JD10', displayName: 'Jump 10 Index', category: 'jump' },
  { symbol: 'JD25', displayName: 'Jump 25 Index', category: 'jump' },
  { symbol: 'JD50', displayName: 'Jump 50 Index', category: 'jump' },
  { symbol: 'JD75', displayName: 'Jump 75 Index', category: 'jump' },
  { symbol: 'JD100', displayName: 'Jump 100 Index', category: 'jump' },
  { symbol: 'stpRNG', displayName: 'Step Index 100', category: 'step' },
  { symbol: 'stpRNG2', displayName: 'Step Index 200', category: 'step' },
  { symbol: 'frxEURUSD', displayName: 'EUR/USD', category: 'forex' },
  { symbol: 'frxGBPUSD', displayName: 'GBP/USD', category: 'forex' },
  { symbol: 'frxUSDJPY', displayName: 'USD/JPY', category: 'forex' },
  { symbol: 'frxAUDUSD', displayName: 'AUD/USD', category: 'forex' },
  { symbol: 'frxUSDCAD', displayName: 'USD/CAD', category: 'forex' },
  { symbol: 'frxXAUUSD', displayName: 'Gold/USD', category: 'commodities' },
  { symbol: 'frxXAGUSD', displayName: 'Silver/USD', category: 'commodities' },
];

function getCategoryForSymbol(item: any): string {
  const code = typeof item === 'string' ? item : item?.symbol || '';
  const market = item?.market || '';
  const submarket = item?.submarket || '';

  if (code.startsWith('1HZ') || (submarket === 'random_index' && code.includes('1HZ'))) return 'volatility_1s';
  if (code.startsWith('R_') || (submarket === 'random_index' && code.startsWith('R_'))) return 'volatility_std';
  if (code.startsWith('JD') || submarket === 'jump_index') return 'jump';
  if (code.startsWith('stp') || submarket === 'step_index') return 'step';
  if (code.startsWith('frxX') || market === 'commodities' || submarket === 'metals') return 'commodities';
  if (code.startsWith('frx') || code.startsWith('FRX') || market === 'forex') return 'forex';
  if (submarket === 'europe_OTC' || submarket === 'asia_oceania_OTC' || submarket === 'americas_OTC') return 'otc_indices';

  return 'volatility_1s';
}

export function MarketCategorySelector({
  selectedSymbol,
  onSelectSymbol,
  availableSymbols,
  compact = false,
}: MarketCategorySelectorProps) {
  const [activeCategory, setActiveCategory] = useState<string>('all');

  const normalizedSymbols = useMemo(() => {
    const rawList = availableSymbols && availableSymbols.length > 0 ? availableSymbols : DEFAULT_FALLBACK_SYMBOLS;
    return rawList.map((s: any) => {
      const code = typeof s === 'string' ? s : s?.symbol || s;
      const name = typeof s === 'string' ? s : s?.displayName || s?.symbol || s;
      const cat = getCategoryForSymbol(s);
      return { symbol: code, displayName: name, category: cat };
    });
  }, [availableSymbols]);

  const categories = useMemo(() => {
    const all = [
      { id: 'all', label: 'All Rise/Fall', icon: Globe, count: normalizedSymbols.length },
      { id: 'volatility_1s', label: '1s Volatility', icon: Zap, count: normalizedSymbols.filter((s) => s.category === 'volatility_1s').length },
      { id: 'volatility_std', label: 'Standard Volatility', icon: Activity, count: normalizedSymbols.filter((s) => s.category === 'volatility_std').length },
      { id: 'jump', label: 'Jump Indices', icon: Layers, count: normalizedSymbols.filter((s) => s.category === 'jump').length },
      { id: 'step', label: 'Step Indices', icon: Activity, count: normalizedSymbols.filter((s) => s.category === 'step').length },
      { id: 'forex', label: 'Forex', icon: DollarSign, count: normalizedSymbols.filter((s) => s.category === 'forex').length },
      { id: 'commodities', label: 'Commodities', icon: Coins, count: normalizedSymbols.filter((s) => s.category === 'commodities').length },
    ];
    // Return all plus only non-empty categories
    return all.filter((c) => c.id === 'all' || c.count > 0);
  }, [normalizedSymbols]);

  const filteredSymbols = useMemo(() => {
    if (activeCategory === 'all') return normalizedSymbols;
    return normalizedSymbols.filter((s) => s.category === activeCategory);
  }, [normalizedSymbols, activeCategory]);

  return (
    <div className="flex flex-col gap-2 w-full">
      {/* Category Tabs Row */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
        {categories.map((cat) => {
          const Icon = cat.icon;
          const isActive = activeCategory === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => setActiveCategory(cat.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all border ${
                isActive
                  ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50 shadow-sm shadow-cyan-500/20 ring-1 ring-cyan-500/30'
                  : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200 hover:border-slate-700'
              }`}
            >
              <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-cyan-400' : 'text-slate-500'}`} />
              <span>{cat.label}</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${isActive ? 'bg-cyan-500/30 text-cyan-200' : 'bg-slate-800 text-slate-500'}`}>
                {cat.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Sub-row with Symbol Pills / Select */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
        {filteredSymbols.map((item) => {
          const isSelected = selectedSymbol === item.symbol;
          return (
            <button
              key={item.symbol}
              type="button"
              onClick={() => onSelectSymbol(item.symbol)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold whitespace-nowrap transition-all border ${
                isSelected
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/60 shadow-sm shadow-emerald-500/20'
                  : 'bg-slate-900/60 text-slate-300 border-slate-800 hover:bg-slate-800 hover:border-slate-700'
              }`}
            >
              {isSelected && <Check className="w-3 h-3 text-emerald-400" />}
              <span>{item.displayName}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
