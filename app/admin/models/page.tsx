'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  Cpu,
  Database,
  Rocket,
  GitBranch,
  RefreshCw,
  ArrowLeft,
  AlertTriangle,
  Clock3,
  XCircle,
  Archive,
  Search,
  ChevronDown,
  Activity,
  CheckCircle2,
  ShieldAlert,
  Sparkles,
  Award,
} from 'lucide-react';
import { HorizonBenchmarkLeaderboard } from '@/components/admin/horizon-benchmark-leaderboard';
import { ModelPerformanceHeatmap } from '@/components/admin/model-performance-heatmap';
import { CircuitBreakerPanel } from '@/components/custom/circuit-breaker-panel';

type RegistryModel = {
  id?: string;
  model_id: string;
  model_name?: string;
  version?: string;
  symbol: string;
  raw_symbol?: string;
  asset_display_name?: string;
  horizon_secs?: number;
  raw_horizon_ticks?: number;
  format?: string;
  status?: string;
  accuracy?: number | null;
  backtest_win_rate?: number | null;
  backtest_profit_factor?: number | null;
  feature_count?: number | null;
  file_path?: string | null;
  hyperparameters?: Record<string, unknown> | null;
  metrics?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
};

type RegistryResponse = {
  success?: boolean;
  count?: number;
  models?: RegistryModel[];
  dataSource?: string;
  error?: string;
};

function formatMetric(value: number | null | undefined, suffix = '') {
  return Number.isFinite(value) ? `${Number(value).toFixed(2)}${suffix}` : '—';
}

function formatDate(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function statusTone(status?: string) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'production') return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300';
  if (normalized === 'staging') return 'border-cyan-400/20 bg-cyan-400/10 text-cyan-200';
  if (normalized === 'retired' || normalized === 'archived') return 'border-amber-400/20 bg-amber-400/10 text-amber-300';
  return 'border-white/10 bg-white/5 text-slate-300';
}

function statusLabel(status?: string) {
  const value = String(status || '').trim();
  return value ? value.toUpperCase() : 'UNSPECIFIED';
}

export default function ModelOperationsPage() {
  const [models, setModels] = useState<RegistryModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [symbolFilter, setSymbolFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Modals & Action States
  const [selectedModel, setSelectedModel] = useState<RegistryModel | null>(null);
  const [retireTarget, setRetireTarget] = useState<RegistryModel | null>(null);
  const [retireReason, setRetireReason] = useState('Operator lifecycle rotation');
  const [retiring, setRetiring] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setRefreshing(true);
    setError(null);
    try {
      const response = await fetch('/api/ml/registry', { cache: 'no-store' });
      if (response.status === 401) {
        window.location.replace('/admin');
        return;
      }
      const data: RegistryResponse = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        setModels([]);
        setDataSource(data.dataSource || null);
        setError(data.error || `Model registry returned HTTP ${response.status}.`);
        return;
      }
      setModels(Array.isArray(data.models) ? data.models : []);
      setDataSource(data.dataSource || null);
      setLastRefresh(new Date().toISOString());
    } catch {
      setError('Unable to reach the model registry.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
    const timer = window.setInterval(() => load(false), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  const symbols = useMemo(
    () => Array.from(new Set(models.map((model) => model.symbol).filter(Boolean))).sort(),
    [models]
  );

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return models.filter((model) => {
      const statusMatches =
        statusFilter === 'ALL' || String(model.status || '').toUpperCase() === statusFilter;
      const symbolMatches = symbolFilter === 'ALL' || model.symbol === symbolFilter;
      const searchMatches =
        !q ||
        (model.model_name && model.model_name.toLowerCase().includes(q)) ||
        (model.model_id && model.model_id.toLowerCase().includes(q)) ||
        (model.symbol && model.symbol.toLowerCase().includes(q));
      return statusMatches && symbolMatches && searchMatches;
    });
  }, [models, statusFilter, symbolFilter, searchQuery]);

  const productionCount = models.filter(
    (model) => String(model.status || '').toLowerCase() === 'production'
  ).length;
  const stagingCount = models.filter(
    (model) => String(model.status || '').toLowerCase() === 'staging'
  ).length;
  const retiredCount = models.filter((model) => {
    const st = String(model.status || '').toLowerCase();
    return st === 'retired' || st === 'archived';
  }).length;

  // Evaluate fallback champion for the target model being retired
  const fallbackChallenger = useMemo(() => {
    if (!retireTarget) return null;
    return (
      models.find(
        (m) =>
          m.model_id !== retireTarget.model_id &&
          m.symbol === retireTarget.symbol &&
          m.horizon_secs === retireTarget.horizon_secs &&
          String(m.status || '').toLowerCase() === 'staging'
      ) || null
    );
  }, [models, retireTarget]);

  const promote = async (model: RegistryModel) => {
    if (!model.model_id || !model.symbol || !Number.isFinite(model.horizon_secs)) return;
    const confirmed = window.confirm(
      `Promote ${model.model_id} to production for ${model.asset_display_name || model.symbol} (${model.symbol}) / ${model.horizon_secs}s? The current production model for that symbol and horizon will be moved to staging.`
    );
    if (!confirmed) return;

    setPromoting(model.model_id);
    setError(null);
    setSuccessMessage(null);
    try {
      const response = await fetch('/api/ml/registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'promote',
          modelId: model.model_id,
          symbol: model.symbol,
          horizonSecs: model.horizon_secs,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.replace('/admin');
        return;
      }
      if (!response.ok || !data.success) {
        setError(data.error || 'Model promotion failed.');
        return;
      }
      setSuccessMessage(`Successfully promoted model ${model.model_id} to production.`);
      await load();
      setSelectedModel((current) =>
        current?.model_id === model.model_id
          ? { ...current, status: 'production', updated_at: data.promotedAt }
          : current
      );
    } catch {
      setError('Unable to complete model promotion.');
    } finally {
      setPromoting(null);
    }
  };

  const handleRetire = async () => {
    if (!retireTarget?.model_id) return;
    setRetiring(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const response = await fetch('/api/ml/registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'retire',
          modelId: retireTarget.model_id,
          reason: retireReason,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.replace('/admin');
        return;
      }
      if (!response.ok || !data.success) {
        setError(data.error || 'Model retirement failed.');
        return;
      }
      setSuccessMessage(`Model ${retireTarget.model_id} has been retired and removed from the active production path.`);
      setRetireTarget(null);
      await load();
    } catch {
      setError('Unable to complete model retirement.');
    } finally {
      setRetiring(false);
    }
  };

  const [remedyingSchema, setRemedyingSchema] = useState(false);

  const handleRemedySchema = async () => {
    const confirmed = window.confirm(
      "Are you sure you want to remedy schema mismatches? This will check all production models against the current schema, archive mismatches, and queue a new training job for active configurations."
    );
    if (!confirmed) return;

    setRemedyingSchema(true);
    setError(null);
    setSuccessMessage(null);
    
    try {
      const response = await fetch('/api/admin/remedy-schema', {
        method: 'POST',
      });
      const data = await response.json().catch(() => ({}));
      
      if (!response.ok) {
        setError(data.error || 'Failed to remedy schema mismatches.');
        return;
      }
      
      setSuccessMessage(data.message || 'Schema remedied successfully.');
      await load();
    } catch (err) {
      setError('Network error while remedying schema.');
    } finally {
      setRemedyingSchema(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#05070b] text-slate-100 pb-16">
      <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3">
              <Cpu className="h-6 w-6 text-cyan-300" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">
                Operations Center · ML Registry
              </p>
              <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Model Operations</h1>
              <p className="mt-1 text-xs text-slate-400">
                Live model registry, production lifecycle management, graceful retirement and controlled promotion.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/admin/tradeability"
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3.5 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-400/20 transition"
            >
              <Sparkles className="h-4 w-4 text-emerald-400" />
              Tradeability Matrix
            </Link>
            <Link
              href="/admin/champion-challenger"
              className="inline-flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-400/20 transition"
            >
              <Award className="h-4 w-4" />
              Champion / Challenger
            </Link>
            <Link
              href="/admin/models/retire"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition"
            >
              <Archive className="h-4 w-4" />
              Retire / Sunset Console
            </Link>
            <Link
              href="/admin"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition"
            >
              <ArrowLeft className="h-4 w-4" />
              Operations Center
            </Link>
            <button
              onClick={handleRemedySchema}
              disabled={remedyingSchema}
              className="inline-flex items-center gap-2 rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/5 px-3 py-2 text-xs font-semibold text-fuchsia-200 hover:bg-fuchsia-400/10 disabled:opacity-60 transition"
              title="Fix schema mismatches and trigger retraining"
            >
              <ShieldAlert className={`h-4 w-4 ${remedyingSchema ? 'animate-pulse' : ''}`} />
              {remedyingSchema ? 'Remedying...' : 'Remedy Schema'}
            </button>
            <button
              onClick={() => load()}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-60 transition"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </header>

        {/* Notifications */}
        {error && (
          <div className="mb-5 flex items-start gap-3 rounded-2xl border border-red-400/20 bg-red-400/[0.06] px-4 py-3 text-sm text-red-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {successMessage && (
          <div className="mb-5 flex items-start gap-3 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.08] px-4 py-3 text-sm text-emerald-200">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Stat Cards */}
        <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <div className="mb-3 flex items-center justify-between">
              <Database className="h-5 w-5 text-cyan-300" />
              <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[10px] font-bold text-emerald-300">
                {dataSource === 'live-database' ? 'LIVE DB' : 'UNCONFIRMED'}
              </span>
            </div>
            <p className="text-xs uppercase tracking-wider text-slate-500">Registered models</p>
            <p className="mt-1 text-2xl font-black">{models.length.toLocaleString()}</p>
          </article>

          <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <div className="mb-3 flex items-center justify-between">
              <Rocket className="h-5 w-5 text-emerald-300" />
              <span className="text-[10px] font-bold tracking-wider text-slate-500">PERSISTED</span>
            </div>
            <p className="text-xs uppercase tracking-wider text-slate-500">Production records</p>
            <p className="mt-1 text-2xl font-black text-emerald-300">{productionCount.toLocaleString()}</p>
          </article>

          <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <div className="mb-3 flex items-center justify-between">
              <GitBranch className="h-5 w-5 text-cyan-300" />
              <span className="text-[10px] font-bold tracking-wider text-slate-500">STAGING</span>
            </div>
            <p className="text-xs uppercase tracking-wider text-slate-500">Staging records</p>
            <p className="mt-1 text-2xl font-black text-cyan-200">{stagingCount.toLocaleString()}</p>
          </article>

          <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <div className="mb-3 flex items-center justify-between">
              <Archive className="h-5 w-5 text-amber-300" />
              <span className="text-[10px] font-bold tracking-wider text-slate-500">RETIRED</span>
            </div>
            <p className="text-xs uppercase tracking-wider text-slate-500">Retired / Sunset</p>
            <p className="mt-1 text-2xl font-black text-amber-300">{retiredCount.toLocaleString()}</p>
          </article>
        </section>

        {/* Automated Horizon Benchmark Leaderboard */}
        <section className="mb-6">
          <HorizonBenchmarkLeaderboard
            symbol={symbolFilter === 'ALL' ? (symbols[0] || 'R_100') : symbolFilter}
            models={models}
          />
        </section>

        {/* Filter and Table Container */}
        <section className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 backdrop-blur-xl">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search by ID, name, or symbol..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/40 pl-10 pr-4 py-2 text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-400/40"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400/40"
              >
                <option value="ALL">All statuses</option>
                <option value="PRODUCTION">Production</option>
                <option value="STAGING">Staging</option>
                <option value="RETIRED">Retired</option>
              </select>

              <select
                value={symbolFilter}
                onChange={(event) => setSymbolFilter(event.target.value)}
                className="max-w-[220px] rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400/40"
              >
                <option value="ALL">All symbols</option>
                {symbols.map((symbol) => (
                  <option key={symbol} value={symbol}>
                    {symbol}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Loading registry…
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 px-5 py-12 text-center">
              <XCircle className="mx-auto h-7 w-7 text-slate-600" />
              <p className="mt-3 text-sm font-semibold text-slate-400">
                No registered models match the current filters.
              </p>
              <p className="mt-1 text-xs text-slate-600">
                This is an empty live state; no model data is being fabricated.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1020px] text-left">
                <thead>
                  <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-3">Model</th>
                    <th className="px-3 py-3">Symbol</th>
                    <th className="px-3 py-3">Horizon</th>
                    <th className="px-3 py-3">Format</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Validation</th>
                    <th className="px-3 py-3">Backtest</th>
                    <th className="px-3 py-3 text-right">Actions & Lifecycle</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredModels.map((model) => {
                    const isProd = String(model.status || '').toLowerCase() === 'production';
                    const isStaging = String(model.status || '').toLowerCase() === 'staging';
                    const isRetired =
                      String(model.status || '').toLowerCase() === 'retired' ||
                      String(model.status || '').toLowerCase() === 'archived';

                    return (
                      <tr
                        key={model.model_id || model.id}
                        className="border-b border-white/5 align-top hover:bg-white/[0.02] transition"
                      >
                        <td className="px-3 py-4">
                          <button
                            onClick={() => setSelectedModel(model)}
                            className="text-left group cursor-pointer"
                          >
                            <p className="text-xs font-bold text-cyan-200 group-hover:text-cyan-100">
                              {model.model_name || 'Unknown model'}
                            </p>
                            <p className="mt-1 break-all font-mono text-[10px] text-slate-500">
                              RAW ID: {model.model_id || '—'}
                            </p>
                            <p className="mt-1 text-[10px] text-slate-600">{model.version || '—'}</p>
                          </button>
                        </td>

                        <td className="px-3 py-4">
                          <p className="text-xs font-semibold text-slate-200">
                            {model.asset_display_name || model.symbol || '—'}
                          </p>
                          <p className="mt-1 font-mono text-[10px] text-slate-500">
                            RAW: {model.raw_symbol || model.symbol || '—'}
                          </p>
                        </td>

                        <td className="px-3 py-4">
                          <p className="text-xs text-slate-300">
                            {Number.isFinite(model.horizon_secs) ? `${model.horizon_secs}s` : '—'}
                          </p>
                          <p className="mt-1 font-mono text-[10px] text-slate-600">
                            ticks: {Number.isFinite(model.raw_horizon_ticks) ? model.raw_horizon_ticks : '—'}
                          </p>
                        </td>

                        <td className="px-3 py-4 text-xs text-slate-300">{model.format || '—'}</td>

                        <td className="px-3 py-4">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wider ${statusTone(
                              model.status
                            )}`}
                          >
                            {String(model.status || '').toLowerCase() === 'production' && (
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            )}
                            {statusLabel(model.status)}
                          </span>
                        </td>

                        <td className="px-3 py-4 text-xs font-semibold">
                          {formatMetric(model.accuracy, '%')}
                        </td>

                        <td className="px-3 py-4 text-xs text-slate-300">
                          {formatMetric(model.backtest_win_rate, '%')}{' '}
                          <span className="text-slate-600">
                            · PF {formatMetric(model.backtest_profit_factor)}
                          </span>
                        </td>

                        <td className="px-3 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {isProd && (
                              <>
                                <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-300">
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  ACTIVE
                                </span>
                                <button
                                  onClick={() => setRetireTarget(model)}
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-400/20 transition cursor-pointer"
                                  title="Retire model from active production path"
                                >
                                  <Archive className="h-3.5 w-3.5" />
                                  Retire
                                </button>
                              </>
                            )}

                            {isStaging && (
                              <button
                                onClick={() => promote(model)}
                                disabled={promoting === model.model_id}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-400/20 disabled:opacity-60 transition cursor-pointer"
                              >
                                {promoting === model.model_id ? (
                                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Rocket className="h-3.5 w-3.5" />
                                )}
                                Promote
                              </button>
                            )}

                            {isRetired && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500">
                                <Archive className="h-3.5 w-3.5 text-slate-600" />
                                SUNSET
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Automated Drift & Circuit Breaker Fleet Monitor */}
        <CircuitBreakerPanel />

        {/* Model Details Modal */}
        {selectedModel && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-6"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setSelectedModel(null);
            }}
          >
            <aside className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-white/10 bg-[#0a0e15] p-5 shadow-2xl sm:rounded-3xl">
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-300">
                    Model details
                  </p>
                  <h2 className="mt-1 break-all text-lg font-black">
                    {selectedModel.model_name || 'Unknown model'}
                  </h2>
                  <p className="mt-1 break-all font-mono text-[10px] text-slate-500">
                    RAW ID: {selectedModel.model_id || '—'}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedModel(null)}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-400 hover:text-white"
                >
                  Close
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <p className="text-[11px] text-slate-500">Model</p>
                  <p className="mt-1 text-sm font-semibold">
                    {selectedModel.model_name || '—'} · {selectedModel.version || '—'}
                  </p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <p className="text-[11px] text-slate-500">Asset</p>
                  <p className="mt-1 text-sm font-semibold">
                    {selectedModel.asset_display_name || selectedModel.symbol || '—'}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-slate-500">
                    RAW: {selectedModel.raw_symbol || selectedModel.symbol || '—'}
                  </p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <p className="text-[11px] text-slate-500">Horizon</p>
                  <p className="mt-1 text-sm font-semibold">
                    {Number.isFinite(selectedModel.horizon_secs) ? `${selectedModel.horizon_secs}s` : '—'}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-slate-500">
                    RAW ticks: {Number.isFinite(selectedModel.raw_horizon_ticks) ? selectedModel.raw_horizon_ticks : '—'}
                  </p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <p className="text-[11px] text-slate-500">Format</p>
                  <p className="mt-1 text-sm font-semibold">{selectedModel.format || '—'}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <p className="text-[11px] text-slate-500">Validation accuracy</p>
                  <p className="mt-1 text-sm font-semibold">{formatMetric(selectedModel.accuracy, '%')}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <p className="text-[11px] text-slate-500">Backtest win rate</p>
                  <p className="mt-1 text-sm font-semibold">{formatMetric(selectedModel.backtest_win_rate, '%')}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <p className="text-[11px] text-slate-500">Profit factor</p>
                  <p className="mt-1 text-sm font-semibold">{formatMetric(selectedModel.backtest_profit_factor)}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <p className="text-[11px] text-slate-500">Features</p>
                  <p className="mt-1 text-sm font-semibold">{Number.isFinite(selectedModel.feature_count) ? selectedModel.feature_count : '—'}</p>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4">
                <p className="text-[11px] text-slate-500">Artifact</p>
                <p className="mt-1 break-all font-mono text-xs text-slate-300">
                  {selectedModel.file_path || 'No artifact path persisted'}
                </p>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <p className="text-[11px] text-slate-500">Created</p>
                  <p className="mt-1 text-xs text-slate-300">{formatDate(selectedModel.created_at)}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <p className="text-[11px] text-slate-500">Updated</p>
                  <p className="mt-1 text-xs text-slate-300">{formatDate(selectedModel.updated_at)}</p>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div>
                  <p className="text-xs font-bold">Lifecycle State</p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Status: <span className="font-semibold text-cyan-200">{statusLabel(selectedModel.status)}</span>
                  </p>
                </div>
                {String(selectedModel.status || '').toLowerCase() === 'production' && (
                  <button
                    onClick={() => {
                      const target = selectedModel;
                      setSelectedModel(null);
                      setRetireTarget(target);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-400/20 transition"
                  >
                    <Archive className="h-4 w-4" />
                    Retire Model
                  </button>
                )}
              </div>
            </aside>
          </div>
        )}

        {/* Retirement Confirmation & Safety Guard Modal */}
        {retireTarget && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !retiring) setRetireTarget(null);
            }}
          >
            <div className="w-full max-w-lg rounded-3xl border border-amber-500/30 bg-[#0d1117] p-6 shadow-2xl">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-3 text-amber-300">
                  <ShieldAlert className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-lg font-black text-white">Retire Production Model</h3>
                  <p className="text-xs text-slate-400">Safety Guard & Succession Check</p>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-white/10 bg-black/40 p-4">
                <p className="text-xs text-slate-400">Target Model:</p>
                <p className="text-sm font-bold text-cyan-200">{retireTarget.model_name || retireTarget.model_id}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-300">
                  <span className="rounded-md bg-white/5 px-2 py-0.5 border border-white/10">
                    Asset: <strong>{retireTarget.symbol}</strong>
                  </span>
                  <span className="rounded-md bg-white/5 px-2 py-0.5 border border-white/10">
                    Horizon: <strong>{retireTarget.horizon_secs}s</strong>
                  </span>
                  <span className="rounded-md bg-white/5 px-2 py-0.5 border border-white/10">
                    Accuracy: <strong>{formatMetric(retireTarget.accuracy, '%')}</strong>
                  </span>
                </div>
              </div>

              {/* Safety Fallback Guard Status */}
              <div className="mt-4">
                {fallbackChallenger ? (
                  <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.07] p-3.5 text-xs text-emerald-200">
                    <p className="font-bold flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      Automatic Succession Available
                    </p>
                    <p className="mt-1 text-slate-300">
                      <strong>{retireTarget.asset_display_name || retireTarget.symbol}</strong> has a staging candidate (
                      <span className="font-mono text-cyan-300">{fallbackChallenger.model_id}</span>) ready for promotion.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.08] p-3.5 text-xs text-amber-200">
                    <p className="font-bold flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 text-amber-300" />
                      No Secondary Challenger Configured
                    </p>
                    <p className="mt-1 text-slate-300 leading-relaxed">
                      Retiring this model will remove active ML inference for{' '}
                      <strong>{retireTarget.symbol} ({retireTarget.horizon_secs}s)</strong> until a new model is trained or promoted.
                    </p>
                  </div>
                )}
              </div>

              {/* Audit Reason Input */}
              <div className="mt-4">
                <label className="block text-xs font-semibold text-slate-300">
                  Retirement Reason (Recorded in Immutable Audit Log):
                </label>
                <input
                  type="text"
                  value={retireReason}
                  onChange={(e) => setRetireReason(e.target.value)}
                  placeholder="e.g., Performance decay, horizon migration, operator replacement..."
                  className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/50 px-3.5 py-2.5 text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-amber-400/50"
                />
              </div>

              {/* Modal Actions */}
              <div className="mt-6 flex items-center justify-end gap-3">
                <button
                  type="button"
                  disabled={retiring}
                  onClick={() => setRetireTarget(null)}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-xs font-semibold text-slate-300 hover:bg-white/10 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={retiring}
                  onClick={handleRetire}
                  className="inline-flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/20 px-4 py-2.5 text-xs font-bold text-amber-200 hover:bg-amber-500/30 disabled:opacity-50 transition shadow-lg"
                >
                  {retiring ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      Retiring Model...
                    </>
                  ) : (
                    <>
                      <Archive className="h-4 w-4" />
                      Confirm Retirement
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
