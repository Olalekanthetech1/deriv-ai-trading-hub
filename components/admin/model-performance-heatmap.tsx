'use client';
import { useMemo } from 'react';
import { Activity } from 'lucide-react';

interface RegistryModel {
  symbol?: string;
  raw_symbol?: string;
  horizon_secs?: number;
  raw_horizon_ticks?: number;
  accuracy?: number | null;
  metrics?: Record<string, any> | null;
  status?: string;
}

interface HeatmapProps {
  models: RegistryModel[];
}

export function ModelPerformanceHeatmap({ models }: HeatmapProps) {
  // We only care about models in 'production' or the best model for a cell
  const data = useMemo(() => {
    const map = new Map<string, { f1: number; count: number }>();
    const allSymbols = new Set<string>();
    const allHorizons = new Set<number>();

    models.forEach(m => {
      const sym = m.raw_symbol || m.symbol;
      const hor = m.raw_horizon_ticks || m.horizon_secs;
      if (!sym || hor == null) return;
      
      allSymbols.add(sym);
      allHorizons.add(hor);

      const key = `${sym}-${hor}`;
      const f1 = m.metrics?.validation_f1 ?? (m.accuracy ? m.accuracy / 100 : 0);
      
      const current = map.get(key);
      if (!current || f1 > current.f1) {
        map.set(key, { f1, count: 1 });
      }
    });

    const horizons = Array.from(allHorizons).sort((a, b) => a - b);
    const symbols = Array.from(allSymbols).sort();

    return { map, symbols, horizons };
  }, [models]);

  const getColor = (f1: number) => {
    if (f1 === 0) return 'bg-white/5 border-white/5 text-slate-500';
    if (f1 < 0.5) return 'bg-rose-500/20 border-rose-500/30 text-rose-300';
    if (f1 < 0.52) return 'bg-amber-500/20 border-amber-500/30 text-amber-300';
    if (f1 < 0.54) return 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300';
    return 'bg-blue-500/20 border-blue-500/30 text-blue-300';
  };

  if (models.length === 0) return null;

  return (
    <article className="rounded-3xl border border-white/10 bg-white/[0.03] p-5 lg:p-7 backdrop-blur-md shadow-2xl mb-8">
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-xl border border-blue-400/20 bg-blue-400/10 p-2.5">
            <Activity className="h-5 w-5 text-blue-300" />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight text-white">Model Performance Matrix</h2>
            <p className="text-xs font-medium text-slate-400">Best Validation F1-Score across Asset/Horizon pairs.</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[10px] font-medium uppercase tracking-wider text-slate-400">
          <div className="flex items-center gap-1.5"><div className="h-3 w-3 rounded-sm bg-rose-500/20 border border-rose-500/30" />&lt;50%</div>
          <div className="flex items-center gap-1.5"><div className="h-3 w-3 rounded-sm bg-amber-500/20 border border-amber-500/30" />50-52%</div>
          <div className="flex items-center gap-1.5"><div className="h-3 w-3 rounded-sm bg-emerald-500/20 border border-emerald-500/30" />52-54%</div>
          <div className="flex items-center gap-1.5"><div className="h-3 w-3 rounded-sm bg-blue-500/20 border border-blue-500/30" />&gt;54%</div>
        </div>
      </div>
      
      <div className="overflow-x-auto pb-4">
        <div className="min-w-max">
          <div className="flex border-b border-white/10 pb-3">
            <div className="w-32 flex-shrink-0"></div>
            {data.horizons.map(h => (
              <div key={h} className="w-20 flex-shrink-0 text-center text-xs font-bold text-slate-400">
                {h} Tick{h !== 1 ? 's' : ''}
              </div>
            ))}
          </div>
          
          <div className="pt-3 space-y-2">
            {data.symbols.map(sym => (
              <div key={sym} className="flex items-center">
                <div className="w-32 flex-shrink-0 text-xs font-bold uppercase tracking-wider text-slate-300">
                  {sym.replace(/_/g, ' ')}
                </div>
                {data.horizons.map(h => {
                  const key = `${sym}-${h}`;
                  const cell = data.map.get(key);
                  const f1 = cell ? cell.f1 : 0;
                  return (
                    <div key={h} className="w-20 flex-shrink-0 px-1">
                      <div className={`flex h-10 w-full items-center justify-center rounded-lg border text-xs font-bold transition-all hover:scale-105 cursor-default ${getColor(f1)}`}>
                        {f1 > 0 ? (f1 * 100).toFixed(1) + '%' : '-'}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}
