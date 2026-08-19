'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Zap,
  Layers,
  Sparkles,
  ShieldCheck,
  Search,
  ArrowUpRight,
  TrendingUp,
  Cpu,
  HelpCircle,
} from 'lucide-react';
import type {
  AssetTradeabilityReport,
  DurationHorizonSpec,
  HorizonEnsembleStatus,
} from '@/app/api/admin/tradeability/route';

export default function TradeabilityMatrixPage() {
  const [data, setData] = useState<{
    summary?: {
      totalAssetsEvaluated: number;
      assetsWithTradeableHorizons: number;
      totalPairsCount: number;
      fullyTradeablePairsCount: number;
      missingRegimeCount: number;
      missingAnomalyCount: number;
      missingPredictiveCount: number;
      standardHorizons: DurationHorizonSpec[];
    };
    assets?: AssetTradeabilityReport[];
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'ready_only' | 'incomplete_only'>('all');
  const [selectedHorizonDetail, setSelectedHorizonDetail] = useState<{
    asset: AssetTradeabilityReport;
    horizon: HorizonEnsembleStatus;
  } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/tradeability', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.replace('/admin');
        return;
      }
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to load tradeability data.');
      }
      setData(json);
    } catch (err: any) {
      setError(err.message || 'Error connecting to tradeability API.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const filteredAssets = useMemo(() => {
    if (!data?.assets) return [];
    return data.assets.filter((asset) => {
      const matchesSearch =
        asset.symbol.toLowerCase().includes(search.toLowerCase()) ||
        asset.displayName.toLowerCase().includes(search.toLowerCase());
      if (!matchesSearch) return false;

      if (filterMode === 'ready_only') return asset.fullyTradeableHorizonsCount > 0;
      if (filterMode === 'incomplete_only')
        return asset.fullyTradeableHorizonsCount < asset.totalHorizons;
      return true;
    });
  }, [data?.assets, search, filterMode]);

  const horizonsList = data?.summary?.standardHorizons || [];

  return (
    <main className="min-h-screen bg-[#05070b] text-slate-100 pb-16">
      <div className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6 lg:px-8">
        {/* Header Bar */}
        <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3.5">
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-3">
              <ShieldCheck className="h-7 w-7 text-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-400">
                  Operations &amp; Model Readiness
                </p>
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/30">
                  Live Ensemble Verification
                </span>
              </div>
              <h1 className="text-2xl font-black tracking-tight sm:text-3xl text-white">
                Asset Tradeability Matrix
              </h1>
              <p className="mt-0.5 text-xs text-slate-400">
                Direct verification of all three mandatory ensemble components (Directional, HMM Regime, Isolation Forest) across every duration horizon.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Link
              href="/admin/champion-challenger"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition"
            >
              <ArrowLeft className="h-4 w-4" /> Champion / Challenger
            </Link>
            <Link
              href="/trade"
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3.5 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/20 transition"
            >
              Launch Live Terminal <ArrowUpRight className="h-4 w-4" />
            </Link>
            <button
              onClick={() => void loadData()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3.5 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-400/20 transition disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh Status
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-6 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-200">
            <strong>Verification Error:</strong> {error}
          </div>
        )}

        {/* Global Summary KPI Tiles */}
        {data?.summary && (
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" /> Fully Tradeable
              </span>
              <p className="mt-2 text-2xl font-black text-white">
                {data.summary.fullyTradeablePairsCount}{' '}
                <span className="text-xs font-normal text-slate-400">
                  / {data.summary.totalPairsCount} Pairs
                </span>
              </p>
              <p className="mt-1 text-[11px] text-emerald-300/80">
                All 3 models active + verified on disk
              </p>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Cpu className="h-4 w-4 text-cyan-400" /> Active Assets
              </span>
              <p className="mt-2 text-2xl font-black text-white">
                {data.summary.assetsWithTradeableHorizons}{' '}
                <span className="text-xs font-normal text-slate-400">
                  / {data.summary.totalAssetsEvaluated} Assets
                </span>
              </p>
              <p className="mt-1 text-[11px] text-slate-400">
                Have $\ge$ 1 ready trade horizon
              </p>
            </div>

            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.03] p-4">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4" /> Missing HMM
              </span>
              <p className="mt-2 text-2xl font-black text-amber-200">
                {data.summary.missingRegimeCount}
              </p>
              <p className="mt-1 text-[11px] text-slate-400">
                Blocked by regime gate
              </p>
            </div>

            <div className="rounded-2xl border border-purple-500/20 bg-purple-500/[0.03] p-4">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-purple-400 flex items-center gap-1.5">
                <Layers className="h-4 w-4" /> Missing Anomaly
              </span>
              <p className="mt-2 text-2xl font-black text-purple-200">
                {data.summary.missingAnomalyCount}
              </p>
              <p className="mt-1 text-[11px] text-slate-400">
                Blocked by Isolation Forest gate
              </p>
            </div>

            <div className="rounded-2xl border border-blue-500/20 bg-blue-500/[0.03] p-4 col-span-2 sm:col-span-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-400 flex items-center gap-1.5">
                <Zap className="h-4 w-4" /> Directional
              </span>
              <p className="mt-2 text-2xl font-black text-blue-200">
                {data.summary.totalPairsCount - data.summary.missingPredictiveCount}
              </p>
              <p className="mt-1 text-[11px] text-slate-400">
                Pairs have directional predictions
              </p>
            </div>
          </div>
        )}

        {/* Filter & Search Bar */}
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setFilterMode('all')}
              className={`rounded-xl px-3.5 py-2 text-xs font-bold transition ${
                filterMode === 'all'
                  ? 'bg-white/15 text-white shadow-sm'
                  : 'bg-white/5 text-slate-400 hover:text-white'
              }`}
            >
              All Assets ({data?.assets?.length || 0})
            </button>
            <button
              onClick={() => setFilterMode('ready_only')}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition ${
                filterMode === 'ready_only'
                  ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                  : 'bg-white/5 text-emerald-400 hover:bg-white/10'
              }`}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Fully Tradeable ({data?.assets?.filter((a) => a.fullyTradeableHorizonsCount > 0).length || 0})
            </button>
            <button
              onClick={() => setFilterMode('incomplete_only')}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition ${
                filterMode === 'incomplete_only'
                  ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20'
                  : 'bg-white/5 text-amber-400 hover:bg-white/10'
              }`}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Incomplete ({data?.assets?.filter((a) => a.fullyTradeableHorizonsCount < a.totalHorizons).length || 0})
            </button>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search symbol (e.g. JD50, 1HZ10V)..."
              className="w-full rounded-xl border border-white/10 bg-black/40 py-2 pl-9 pr-3 text-xs text-white placeholder-slate-500 focus:border-cyan-400 focus:outline-none"
            />
          </div>
        </div>

        {/* Tradeability Master Matrix Table */}
        <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.02] shadow-2xl backdrop-blur-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 bg-black/40 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-3.5 px-4 sticky left-0 z-10 bg-[#070b12] border-r border-white/10 min-w-[220px]">
                    Asset Underlying
                  </th>
                  <th className="py-3.5 px-3 text-center border-r border-white/10 min-w-[110px]">
                    Readiness
                  </th>
                  {horizonsList.map((h) => (
                    <th key={h.key} className="py-3.5 px-3 text-center min-w-[130px]">
                      <div>{h.label}</div>
                      <div className="text-[9px] font-mono text-slate-500 font-normal">{h.key}</div>
                    </th>
                  ))}
                  <th className="py-3.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-sans">
                {loading && !data ? (
                  <tr>
                    <td colSpan={horizonsList.length + 3} className="py-12 text-center text-slate-500">
                      Evaluating complete ensemble readiness across all assets &amp; horizons…
                    </td>
                  </tr>
                ) : filteredAssets.length === 0 ? (
                  <tr>
                    <td colSpan={horizonsList.length + 3} className="py-12 text-center text-slate-500">
                      No assets found matching current criteria.
                    </td>
                  </tr>
                ) : (
                  filteredAssets.map((asset) => (
                    <tr key={asset.symbol} className="hover:bg-white/[0.02] transition">
                      {/* Asset Header Cell (Sticky) */}
                      <td className="py-3.5 px-4 sticky left-0 z-10 bg-[#06090e] border-r border-white/10">
                        <div className="font-bold text-slate-100 text-sm">{asset.displayName}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="font-mono text-[11px] text-cyan-300/80 font-bold">
                            {asset.symbol}
                          </span>
                          <span className="text-[10px] text-slate-500 font-mono">
                            · {asset.fullyTradeableHorizonsCount}/{asset.totalHorizons} Horizons
                          </span>
                        </div>
                      </td>

                      {/* Readiness Progress Bar Cell */}
                      <td className="py-3.5 px-3 text-center border-r border-white/10">
                        <div className="flex items-center justify-center gap-1.5 font-bold font-mono">
                          <span
                            className={
                              asset.overallTradeabilityPct === 100
                                ? 'text-emerald-300'
                                : asset.overallTradeabilityPct > 0
                                ? 'text-amber-300'
                                : 'text-slate-500'
                            }
                          >
                            {asset.overallTradeabilityPct}%
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all ${
                              asset.overallTradeabilityPct === 100
                                ? 'bg-emerald-400'
                                : asset.overallTradeabilityPct > 0
                                ? 'bg-amber-400'
                                : 'bg-slate-700'
                            }`}
                            style={{ width: `${asset.overallTradeabilityPct}%` }}
                          />
                        </div>
                      </td>

                      {/* Duration Horizon Cells */}
                      {horizonsList.map((h) => {
                        const status = asset.horizons[h.key];
                        if (!status) return <td key={h.key} className="py-3 px-2 text-center text-slate-600">—</td>;

                        const isReady = status.isFullyTradeable;
                        const hasPartial = status.readinessScore > 0;

                        return (
                          <td key={h.key} className="py-3 px-2.5 text-center">
                            <button
                              onClick={() => setSelectedHorizonDetail({ asset, horizon: status })}
                              className={`w-full py-1.5 px-2 rounded-xl border text-[11px] font-bold transition flex flex-col items-center justify-center cursor-pointer ${
                                isReady
                                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 hover:border-emerald-400'
                                  : hasPartial
                                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 hover:border-amber-400'
                                  : 'border-white/5 bg-white/[0.02] text-slate-500 hover:bg-white/5 hover:text-slate-300'
                              }`}
                            >
                              <div className="flex items-center gap-1">
                                {isReady ? (
                                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                                ) : hasPartial ? (
                                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                                ) : (
                                  <XCircle className="h-3.5 w-3.5 text-slate-600" />
                                )}
                                <span>{isReady ? 'READY' : hasPartial ? `${status.readinessScore}%` : 'NONE'}</span>
                              </div>

                              <div className="mt-0.5 text-[9px] font-mono text-slate-400">
                                {isReady
                                  ? '3/3 Components'
                                  : hasPartial
                                  ? `${status.predictive.ready ? 'Dir' : ''} ${status.regime.ready ? 'HMM' : ''} ${status.anomaly.ready ? 'Iso' : ''}`.trim() || 'Missing'
                                  : 'Untrained'}
                              </div>
                            </button>
                          </td>
                        );
                      })}

                      {/* Trade Quick Launch Cell */}
                      <td className="py-3.5 px-4 text-right">
                        <Link
                          href={`/trade?symbol=${asset.symbol}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-bold text-cyan-200 hover:bg-cyan-500/20 transition"
                        >
                          Trade <ArrowUpRight className="h-3 w-3" />
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Modal: Deep Component Inspection Drawer */}
        {selectedHorizonDetail && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="w-full max-w-2xl rounded-3xl border border-white/10 bg-[#080d17] p-6 shadow-2xl">
              <div className="flex items-start justify-between pb-4 border-b border-white/10">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-cyan-500/20 px-2.5 py-0.5 text-[10px] font-bold text-cyan-300 border border-cyan-500/30">
                      {selectedHorizonDetail.asset.symbol}
                    </span>
                    <span className="text-xs font-bold text-slate-400">
                      {selectedHorizonDetail.horizon.label} ({selectedHorizonDetail.horizon.horizonKey})
                    </span>
                  </div>
                  <h3 className="text-lg font-bold text-white mt-1">
                    {selectedHorizonDetail.asset.displayName} · Ensemble Breakdown
                  </h3>
                </div>
                <button
                  onClick={() => setSelectedHorizonDetail(null)}
                  className="rounded-xl p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
                >
                  ✕
                </button>
              </div>

              {/* Status Banner */}
              <div
                className={`my-4 p-4 rounded-2xl border flex items-start gap-3 ${
                  selectedHorizonDetail.horizon.isFullyTradeable
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                }`}
              >
                {selectedHorizonDetail.horizon.isFullyTradeable ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400 mt-0.5" />
                ) : (
                  <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" />
                )}
                <div>
                  <div className="font-bold text-sm">
                    {selectedHorizonDetail.horizon.isFullyTradeable
                      ? '100% Fully Tradeable · All Production Gates Cleared'
                      : 'Incomplete Ensemble · AI Auto-Trading Blocked'}
                  </div>
                  <p className="text-xs mt-1 opacity-90">
                    {selectedHorizonDetail.horizon.isFullyTradeable
                      ? 'This asset and duration will execute instantly on the trading terminal without any missing model errors.'
                      : `Missing components: ${selectedHorizonDetail.horizon.missingComponents.join(', ')}`}
                  </p>
                </div>
              </div>

              {/* Component Checklist */}
              <div className="space-y-3">
                {/* 1. Predictive Directional */}
                <div className="p-3.5 rounded-xl border border-white/10 bg-white/[0.02]">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-slate-200 flex items-center gap-1.5">
                      {selectedHorizonDetail.horizon.predictive.ready ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <XCircle className="h-4 w-4 text-rose-400" />
                      )}
                      1. Directional Prediction (XGBoost / TCN / LSTM)
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        selectedHorizonDetail.horizon.predictive.ready
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-rose-500/20 text-rose-300'
                      }`}
                    >
                      {selectedHorizonDetail.horizon.predictive.ready ? 'PASSED' : 'MISSING'}
                    </span>
                  </div>
                  {selectedHorizonDetail.horizon.predictive.models.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {selectedHorizonDetail.horizon.predictive.models.map((m) => (
                        <div key={m.modelId} className="flex items-center justify-between text-[11px] font-mono text-slate-400 bg-black/30 p-2 rounded-lg">
                          <span>{m.key.toUpperCase()} ({m.modelId.slice(0, 14)}…)</span>
                          <span className="text-emerald-300 font-bold">
                            Acc: {m.accuracy ? `${m.accuracy.toFixed(1)}%` : '—'} | F1: {m.f1 ? m.f1.toFixed(3) : '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500 mt-1">No production directional model registered for this horizon.</p>
                  )}
                </div>

                {/* 2. HMM Regime */}
                <div className="p-3.5 rounded-xl border border-white/10 bg-white/[0.02]">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-slate-200 flex items-center gap-1.5">
                      {selectedHorizonDetail.horizon.regime.ready ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <XCircle className="h-4 w-4 text-rose-400" />
                      )}
                      2. HMM Market Regime Classifier (`hmm`)
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        selectedHorizonDetail.horizon.regime.ready
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-rose-500/20 text-rose-300'
                      }`}
                    >
                      {selectedHorizonDetail.horizon.regime.ready ? 'PASSED' : 'MISSING'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    {selectedHorizonDetail.horizon.regime.ready
                      ? `Active Champion Model: ${selectedHorizonDetail.horizon.regime.modelId}`
                      : 'Required to prevent trades during turbulent or counter-trend regimes.'}
                  </p>
                </div>

                {/* 3. Isolation Forest Anomaly */}
                <div className="p-3.5 rounded-xl border border-white/10 bg-white/[0.02]">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-slate-200 flex items-center gap-1.5">
                      {selectedHorizonDetail.horizon.anomaly.ready ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <XCircle className="h-4 w-4 text-rose-400" />
                      )}
                      3. Isolation Forest Anomaly Detector (`isolation_forest`)
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        selectedHorizonDetail.horizon.anomaly.ready
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-rose-500/20 text-rose-300'
                      }`}
                    >
                      {selectedHorizonDetail.horizon.anomaly.ready ? 'PASSED' : 'MISSING'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    {selectedHorizonDetail.horizon.anomaly.ready
                      ? `Active Champion Model: ${selectedHorizonDetail.horizon.anomaly.modelId}`
                      : 'Required to filter out abnormal micro-spread anomalies and tick latency spikes.'}
                  </p>
                </div>
              </div>

              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={() => setSelectedHorizonDetail(null)}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10"
                >
                  Close
                </button>
                <Link
                  href={`/trade?symbol=${selectedHorizonDetail.asset.symbol}`}
                  className="rounded-xl bg-cyan-400 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-cyan-300 transition"
                >
                  Trade This Asset Now
                </Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
