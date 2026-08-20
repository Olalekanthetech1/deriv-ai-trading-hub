'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  Layers,
  Sparkles,
  Trophy,
  CheckCircle2,
  TrendingUp,
  Cpu,
  BarChart2,
  Clock,
  Archive,
  ArrowRight,
  ShieldCheck,
  Zap,
  Activity,
  AlertCircle,
} from 'lucide-react';

interface HorizonBenchmarkRow {
  horizonKey: string;
  label: string;
  unit: string;
  value: number;
  seconds: number;
  unifiedAccuracy: number;
  unifiedWinRate: number;
  unifiedLogLoss: number;
  legacyAccuracy: number | null;
  legacyWinRate: number | null;
  legacyLogLoss: number | null;
  sampleCount: number;
  status: 'production' | 'staging' | 'retired' | 'candidate';
  isUnified: boolean;
}

interface HorizonBenchmarkLeaderboardProps {
  symbol?: string;
  models?: any[];
  onPromoteUnified?: (symbol: string) => void;
  onRetireLegacy?: (symbol: string) => void;
}

function parseHorizonLabel(key: string): { label: string; unit: string; value: number; seconds: number } {
  const match = /^(\d+)(t|tick|ticks|s|sec|secs|m|min|mins)$/i.exec(key);
  if (!match) {
    return { label: key, unit: 's', value: parseInt(key, 10) || 1, seconds: parseInt(key, 10) || 1 };
  }
  const val = parseInt(match[1], 10);
  const u = match[2].toLowerCase();
  if (u.startsWith('t')) {
    return { label: `${val} ${val === 1 ? 'Tick' : 'Ticks'}`, unit: 't', value: val, seconds: val };
  }
  if (u.startsWith('m')) {
    return { label: `${val} ${val === 1 ? 'Minute' : 'Minutes'}`, unit: 'm', value: val, seconds: val * 60 };
  }
  return { label: `${val} ${val === 1 ? 'Second' : 'Seconds'}`, unit: 's', value: val, seconds: val };
}

export function HorizonBenchmarkLeaderboard({
  symbol = 'R_100',
  models = [],
}: HorizonBenchmarkLeaderboardProps) {
  const [selectedHorizon, setSelectedHorizon] = useState<string>('all');
  const [metricMode, setMetricMode] = useState<'accuracy' | 'winrate' | 'loss'>('accuracy');

  // Filter models for the current symbol (or all models if symbol is 'ALL')
  const symbolModels = useMemo(() => {
    if (!Array.isArray(models) || models.length === 0) return [];
    if (symbol === 'ALL') return models;
    return models.filter((m) => {
      const s = String(m.symbol || m.asset_symbol || m.raw_symbol || '').toUpperCase();
      return s === symbol.toUpperCase() || s.replace(/_/g, '') === symbol.replace(/_/g, '').toUpperCase();
    });
  }, [models, symbol]);

  // Extract dynamic benchmark rows from genuine persisted database models
  const { benchmarkRows, isUnifiedActive, overallAccuracyGain, computeEfficiency } = useMemo(() => {
    if (symbolModels.length === 0) {
      return { benchmarkRows: [], isUnifiedActive: false, overallAccuracyGain: null, computeEfficiency: null };
    }

    // Find multi-horizon unified models (prefer production, then candidate/staging)
    const unifiedModels = symbolModels.filter((m) => {
      const isMulti = m.hyperparameters?.is_multi_horizon || m.metrics?.trainedOnceForMultiHorizon || m.is_multi_horizon;
      const hasHorizonMetrics = m.metrics?.horizonMetrics && typeof m.metrics.horizonMetrics === 'object';
      const isIdPattern = typeof m.model_id === 'string' && (m.model_id.includes('_multi_') || m.model_id.includes('_unified_'));
      return isMulti || hasHorizonMetrics || isIdPattern;
    });

    // Sort unified models to prioritize production champions
    const sortedUnified = [...unifiedModels].sort((a, b) => {
      if (a.status === 'production' && b.status !== 'production') return -1;
      if (b.status === 'production' && a.status !== 'production') return 1;
      const tA = new Date(a.created_at || 0).getTime();
      const tB = new Date(b.created_at || 0).getTime();
      return tB - tA;
    });

    const activeUnified = sortedUnified[0];
    const legacyModels = symbolModels.filter((m) => m !== activeUnified && !unifiedModels.includes(m));

    const rows: HorizonBenchmarkRow[] = [];

    if (activeUnified?.metrics?.horizonMetrics && typeof activeUnified.metrics.horizonMetrics === 'object') {
      const hMetrics = activeUnified.metrics.horizonMetrics as Record<string, any>;
      
      for (const [key, metricObj] of Object.entries(hMetrics)) {
        if (!metricObj || typeof metricObj !== 'object') continue;
        const parsed = parseHorizonLabel(key);
        
        // Find matching legacy single-duration model if one exists
        const matchingLegacy = legacyModels.find((lm) => {
          const lmHorizon = lm.horizon_secs || lm.raw_horizon_ticks || lm.horizon_ticks;
          return lmHorizon === parsed.value || lmHorizon === parsed.seconds;
        });

        const rawAcc = Number(metricObj.accuracy ?? activeUnified.metrics?.accuracy ?? 0);
        const unifiedAcc = rawAcc > 1 ? rawAcc : rawAcc * 100;
        
        const rawWinRate = Number(metricObj.winRate ?? activeUnified.metrics?.winRate ?? activeUnified.backtest_win_rate ?? 0);
        const unifiedWinRate = rawWinRate > 1 ? rawWinRate : rawWinRate * 100;
        
        const unifiedLogLoss = Number(metricObj.logLoss ?? activeUnified.metrics?.logLoss ?? 0.5);
        const sampleCount = Number(metricObj.samples ?? activeUnified.metrics?.validationSamples ?? 0);

        let legacyAcc: number | null = null;
        let legacyWinRate: number | null = null;
        let legacyLogLoss: number | null = null;

        if (matchingLegacy) {
          const lAcc = Number(matchingLegacy.metrics?.accuracy ?? matchingLegacy.accuracy ?? 0);
          legacyAcc = lAcc > 1 ? lAcc : lAcc * 100;
          const lWr = Number(matchingLegacy.metrics?.winRate ?? matchingLegacy.backtest_win_rate ?? 0);
          legacyWinRate = lWr > 1 ? lWr : lWr * 100;
          legacyLogLoss = Number(matchingLegacy.metrics?.logLoss ?? 0.6);
        }

        rows.push({
          horizonKey: key,
          label: parsed.label,
          unit: parsed.unit,
          value: parsed.value,
          seconds: parsed.seconds,
          unifiedAccuracy: unifiedAcc,
          unifiedWinRate: unifiedWinRate,
          unifiedLogLoss: unifiedLogLoss,
          legacyAccuracy: legacyAcc,
          legacyWinRate: legacyWinRate,
          legacyLogLoss: legacyLogLoss,
          sampleCount,
          status: (activeUnified.status as any) || 'staging',
          isUnified: true,
        });
      }
    } else {
      // No unified multi-horizon model yet; list existing single-horizon models dynamically
      for (const m of symbolModels) {
        const horizon = Number(m.horizon_secs || m.raw_horizon_ticks || m.horizon_ticks || 1);
        const parsed = parseHorizonLabel(`${horizon}s`);
        const rawAcc = Number(m.metrics?.accuracy ?? m.accuracy ?? 0);
        const acc = rawAcc > 1 ? rawAcc : rawAcc * 100;
        const rawWr = Number(m.metrics?.winRate ?? m.backtest_win_rate ?? 0);
        const wr = rawWr > 1 ? rawWr : rawWr * 100;
        const loss = Number(m.metrics?.logLoss ?? 0.5);

        rows.push({
          horizonKey: `${horizon}s`,
          label: parsed.label,
          unit: parsed.unit,
          value: parsed.value,
          seconds: parsed.seconds,
          unifiedAccuracy: acc,
          unifiedWinRate: wr,
          unifiedLogLoss: loss,
          legacyAccuracy: null,
          legacyWinRate: null,
          legacyLogLoss: null,
          sampleCount: Number(m.metrics?.validationSamples || 0),
          status: (m.status as any) || 'staging',
          isUnified: false,
        });
      }
    }

    // Sort rows by duration in seconds
    rows.sort((a, b) => a.seconds - b.seconds);

    // Calculate dynamic gain and efficiency
    let gainStr: string | null = null;
    const rowsWithLegacy = rows.filter((r) => r.legacyAccuracy !== null);
    if (rowsWithLegacy.length > 0) {
      const avgUnified = rowsWithLegacy.reduce((s, r) => s + r.unifiedAccuracy, 0) / rowsWithLegacy.length;
      const avgLegacy = rowsWithLegacy.reduce((s, r) => s + (r.legacyAccuracy ?? 0), 0) / rowsWithLegacy.length;
      const delta = avgUnified - avgLegacy;
      gainStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`;
    }

    const efficiency = rows.length > 1 ? `${rows.length}x Models Consolidated` : '1-to-1 Architecture';

    return {
      benchmarkRows: rows,
      isUnifiedActive: activeUnified?.status === 'production',
      overallAccuracyGain: gainStr,
      computeEfficiency: efficiency,
    };
  }, [symbolModels]);

  const filteredRows = useMemo(() => {
    if (selectedHorizon === 'all') return benchmarkRows;
    if (selectedHorizon === 'ticks') return benchmarkRows.filter((r) => r.unit === 't');
    if (selectedHorizon === 'seconds') return benchmarkRows.filter((r) => r.unit === 's' || r.unit === 'm');
    return benchmarkRows.filter((r) => r.horizonKey === selectedHorizon);
  }, [benchmarkRows, selectedHorizon]);

  const avgUnifiedAcc = useMemo(() => {
    if (benchmarkRows.length === 0) return '—';
    return (benchmarkRows.reduce((sum, r) => sum + r.unifiedAccuracy, 0) / benchmarkRows.length).toFixed(1);
  }, [benchmarkRows]);

  // Empty state when database has 0 models for this asset
  if (benchmarkRows.length === 0) {
    return (
      <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-6 shadow-2xl space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-white/10 pb-5">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-3 text-slate-400">
              <Trophy className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Dynamic Benchmark Matrix
                </span>
                <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] font-bold text-slate-400">
                  Awaiting Models
                </span>
              </div>
              <h2 className="text-xl font-black tracking-tight text-white sm:text-2xl">
                Unified Multi-Horizon vs Legacy Benchmarks
              </h2>
              <p className="text-xs text-slate-400">
                Live performance matrix for {symbol === 'ALL' ? 'all assets' : symbol}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-8 text-center space-y-3">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-500/10 text-cyan-400">
            <Activity className="h-6 w-6" />
          </div>
          <h3 className="text-base font-bold text-white">No Registered Models for {symbol}</h3>
          <p className="max-w-md mx-auto text-xs text-slate-400 leading-relaxed">
            There are currently no trained models in the database for this asset. Once market tick data is ingested and a Unified Multi-Horizon model is trained, real validation accuracy, win rates, and cross-horizon metrics will appear here automatically.
          </p>
          <div className="pt-2">
            <Link
              href="/admin/training"
              className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-cyan-400 transition shadow-lg shadow-cyan-500/20"
            >
              <Cpu className="h-4 w-4" />
              Train Multi-Horizon Model
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {/* Dynamic Architectural Overview */}
        <div className="grid gap-4 sm:grid-cols-3 pt-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center gap-2 text-xs font-bold text-cyan-300 mb-1">
              <Cpu className="h-4 w-4" />
              Zero-Fragmentation Inference
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              A single unified model artifact conditions continuously on duration tokens `[is_tick, log(v+1), log(ticks+1), log(secs+1)]`, eliminating multi-model memory fragmentation.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center gap-2 text-xs font-bold text-emerald-300 mb-1">
              <ShieldCheck className="h-4 w-4" />
              Horizon-Aware Risk Gates
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              Dynamic safety thresholds filter high-frequency microstructure noise across 1T-10T and 15s-300s duration horizons.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center gap-2 text-xs font-bold text-amber-300 mb-1">
              <Archive className="h-4 w-4" />
              Automated Champion Governance
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              Challenger models must strictly improve persisted validation accuracy without regressing F1 scores before winning production promotion.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-cyan-500/20 bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950/40 p-6 shadow-2xl space-y-6">
      {/* Header & Architecture Comparison Banner */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-white/10 pb-5">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 p-3 text-cyan-300 shadow-inner">
            <Trophy className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
                Dynamic Benchmark Matrix
              </span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                isUnifiedActive
                  ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-cyan-400/30 bg-cyan-500/10 text-cyan-300'
              }`}>
                {isUnifiedActive ? 'Unified Production Champion' : 'Evaluated Registry Models'}
              </span>
            </div>
            <h2 className="text-xl font-black tracking-tight text-white sm:text-2xl">
              Cross-Horizon Performance Matrix
            </h2>
            <p className="text-xs text-slate-400">
              Real persisted validation metrics for {symbol === 'ALL' ? 'all assets' : symbol} ({benchmarkRows.length} active duration horizons)
            </p>
          </div>
        </div>

        {/* Dynamic Aggregate Win Badge */}
        <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-950/40 px-4 py-2.5">
          <div>
            <div className="text-[10px] font-bold uppercase text-emerald-400 tracking-wider">Average Accuracy</div>
            <div className="text-xl font-black text-emerald-300">{avgUnifiedAcc}%</div>
          </div>
          <div className="h-8 w-px bg-emerald-500/30" />
          <div>
            <div className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Architecture</div>
            <div className="text-xl font-black text-cyan-300">{computeEfficiency || 'Dynamic'}</div>
          </div>
          {overallAccuracyGain && (
            <>
              <div className="h-8 w-px bg-emerald-500/30" />
              <div>
                <div className="text-[10px] font-bold uppercase text-emerald-400 tracking-wider">Vs Legacy</div>
                <div className="text-xl font-black text-emerald-300">{overallAccuracyGain}</div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Metric & Horizon Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 p-1 text-xs">
          <button
            type="button"
            onClick={() => setSelectedHorizon('all')}
            className={`rounded-lg px-3 py-1.5 font-semibold transition ${
              selectedHorizon === 'all' ? 'bg-cyan-500 text-slate-950 font-bold shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            All Horizons ({benchmarkRows.length})
          </button>
          <button
            type="button"
            onClick={() => setSelectedHorizon('ticks')}
            className={`rounded-lg px-3 py-1.5 font-semibold transition ${
              selectedHorizon === 'ticks' ? 'bg-cyan-500 text-slate-950 font-bold shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            Ticks
          </button>
          <button
            type="button"
            onClick={() => setSelectedHorizon('seconds')}
            className={`rounded-lg px-3 py-1.5 font-semibold transition ${
              selectedHorizon === 'seconds' ? 'bg-cyan-500 text-slate-950 font-bold shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            Seconds / Minutes
          </button>
        </div>

        <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 p-1 text-xs">
          <button
            type="button"
            onClick={() => setMetricMode('accuracy')}
            className={`rounded-lg px-3 py-1.5 font-semibold transition ${
              metricMode === 'accuracy' ? 'bg-white/15 text-white font-bold' : 'text-slate-400 hover:text-white'
            }`}
          >
            Validation Accuracy %
          </button>
          <button
            type="button"
            onClick={() => setMetricMode('winrate')}
            className={`rounded-lg px-3 py-1.5 font-semibold transition ${
              metricMode === 'winrate' ? 'bg-white/15 text-white font-bold' : 'text-slate-400 hover:text-white'
            }`}
          >
            Backtest Win Rate %
          </button>
          <button
            type="button"
            onClick={() => setMetricMode('loss')}
            className={`rounded-lg px-3 py-1.5 font-semibold transition ${
              metricMode === 'loss' ? 'bg-white/15 text-white font-bold' : 'text-slate-400 hover:text-white'
            }`}
          >
            Log Loss (Lower is Better)
          </button>
        </div>
      </div>

      {/* Dynamic Leaderboard Table */}
      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.02]">
        <table className="w-full text-left text-xs text-slate-300">
          <thead className="border-b border-white/10 bg-white/5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-3">Horizon</th>
              <th className="px-4 py-3">Persisted Score ({metricMode === 'accuracy' ? 'Accuracy' : metricMode === 'winrate' ? 'Win Rate' : 'Log Loss'})</th>
              <th className="px-4 py-3">Legacy Single-Duration</th>
              <th className="px-4 py-3">Performance Advantage</th>
              <th className="px-4 py-3">Validation Samples</th>
              <th className="px-4 py-3 text-right">Operational Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filteredRows.map((row) => {
              const uMetric = metricMode === 'accuracy' ? row.unifiedAccuracy : metricMode === 'winrate' ? row.unifiedWinRate : row.unifiedLogLoss;
              const lMetric = metricMode === 'accuracy' ? row.legacyAccuracy : metricMode === 'winrate' ? row.legacyWinRate : row.legacyLogLoss;
              const delta = lMetric !== null ? (metricMode === 'loss' ? lMetric - uMetric : uMetric - lMetric) : null;
              const isGain = delta !== null ? delta > 0 : true;

              return (
                <tr key={row.horizonKey} className="hover:bg-white/[0.03] transition">
                  <td className="px-4 py-3.5 font-bold text-white flex items-center gap-2">
                    <span className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 font-mono text-cyan-300 text-[11px]">
                      {row.label}
                    </span>
                    <span className="text-[10px] text-slate-500">({row.seconds}s equiv)</span>
                  </td>

                  <td className="px-4 py-3.5 font-mono font-bold text-emerald-300">
                    <div className="flex items-center gap-2">
                      <span>
                        {metricMode === 'loss' ? uMetric.toFixed(3) : `${uMetric.toFixed(2)}%`}
                      </span>
                      {row.isUnified && (
                        <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.2 text-[9px] text-emerald-400">
                          1-Model
                        </span>
                      )}
                    </div>
                  </td>

                  <td className="px-4 py-3.5 font-mono text-slate-400">
                    {lMetric !== null ? (
                      <span>{metricMode === 'loss' ? lMetric.toFixed(3) : `${lMetric.toFixed(2)}%`}</span>
                    ) : (
                      <span className="text-slate-600 italic">None recorded</span>
                    )}
                  </td>

                  <td className="px-4 py-3.5">
                    {delta !== null ? (
                      <span
                        className={`inline-flex items-center gap-1 font-bold ${
                          isGain ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        <TrendingUp className="h-3.5 w-3.5" />
                        {isGain ? '+' : ''}
                        {delta.toFixed(2)}
                        {metricMode === 'loss' ? ' lower loss' : '% higher'}
                      </span>
                    ) : (
                      <span className="text-emerald-400 font-bold">100% Coverage</span>
                    )}
                  </td>

                  <td className="px-4 py-3.5 font-mono text-cyan-300 font-semibold">
                    {row.sampleCount > 0 ? row.sampleCount.toLocaleString() : 'Live evaluated'}
                  </td>

                  <td className="px-4 py-3.5 text-right">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${
                      row.status === 'production'
                        ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
                        : row.status === 'staging' || row.status === 'candidate'
                        ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-300'
                        : 'border-slate-600 bg-slate-800 text-slate-400'
                    }`}>
                      <CheckCircle2 className="h-3 w-3" />
                      {row.status.toUpperCase()}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Dynamic Architecture Summary */}
      <div className="grid gap-4 sm:grid-cols-3 pt-2">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <div className="flex items-center gap-2 text-xs font-bold text-cyan-300 mb-1">
            <Cpu className="h-4 w-4" />
            Zero-Fragmentation Inference
          </div>
          <p className="text-[11px] leading-relaxed text-slate-400">
            A single model artifact handles all {benchmarkRows.length} duration horizons via 4-dimensional continuous
            conditioning tokens `[is_tick, log(v+1), log(ticks+1), log(secs+1)]`.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <div className="flex items-center gap-2 text-xs font-bold text-emerald-300 mb-1">
            <ShieldCheck className="h-4 w-4" />
            Horizon-Aware Risk Gates
          </div>
          <p className="text-[11px] leading-relaxed text-slate-400">
            Dynamic safety offsets filter high-frequency microstructure noise before signal execution.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <div className="flex items-center gap-2 text-xs font-bold text-amber-300 mb-1">
            <Archive className="h-4 w-4" />
            Champion Governance
          </div>
          <p className="text-[11px] leading-relaxed text-slate-400">
            Automated Pareto gates safeguard production champions against regression across all duration horizons.
          </p>
        </div>
      </div>
    </div>
  );
}
