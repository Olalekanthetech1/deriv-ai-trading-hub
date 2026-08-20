'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Radio,
  Server,
  ShieldAlert,
  ShieldCheck,
  DatabaseZap,
  Trash2,
  Sparkles,
  Layers,
  Clock,
  ArrowRight,
  TrendingUp,
  Activity,
  AlertTriangle,
  Zap,
  RotateCcw,
} from 'lucide-react';
import { adminFetch } from '@/lib/admin-client-auth';

type LiveSymbol = {
  symbol: string;
  displayName: string;
  market: string;
  submarket: string;
  isOpen: boolean;
  isAvailable: boolean;
};

type IngestionRun = {
  runId: string;
  symbol: string;
  requestedCount: number;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'partial' | 'failed';
  recordsReceived: number;
  recordsInserted: number;
  recordsRejected: number;
  firstTickTime: string | null;
  lastTickTime: string | null;
  errorMessage: string | null;
  metadata?: Record<string, unknown>;
};

type Checkpoint = {
  source: string;
  symbol: string;
  lastTickEpoch: number | null;
  lastTickTime: string | null;
  updatedAt: string;
};

type RuntimeConfig = {
  maxAssets: number | null;
  concurrency: number;
};

const POPULAR_PRESETS = [
  {
    id: 'vol_1s',
    label: '1s Volatility Suite',
    description: '1HZ10V to 1HZ100V (1-sec ticks)',
    symbols: ['1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'],
  },
  {
    id: 'vol_std',
    label: 'Standard Volatility',
    description: 'R_10 to R_100 (2-sec ticks)',
    symbols: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
  },
  {
    id: 'jump_indices',
    label: 'Jump Indices',
    description: 'JD10 to JD100 (Rise/Fall supported)',
    symbols: ['JD10', 'JD25', 'JD50', 'JD75', 'JD100'],
  },
];

const TICK_DEPTH_PRESETS = [1000, 2500, 5000, 10000, 25000];

function aggregatePartialRuns(runs: IngestionRun[]): IngestionRun[] {
  const groups = new Map<string, IngestionRun>();
  for (const run of runs) {
    const sessionId = typeof run.metadata?.backfillSessionId === 'string' ? run.metadata.backfillSessionId : null;
    const key = run.status === 'partial' ? (sessionId ? `session:${sessionId}` : `legacy:${run.symbol}:${run.requestedCount}`) : `run:${run.runId}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...run });
      continue;
    }
    existing.recordsReceived += run.recordsReceived;
    existing.recordsInserted += run.recordsInserted;
    existing.recordsRejected += run.recordsRejected;
    existing.startedAt = new Date(Math.min(new Date(existing.startedAt).getTime(), new Date(run.startedAt).getTime())).toISOString();
    existing.completedAt =
      existing.completedAt && run.completedAt
        ? new Date(Math.max(new Date(existing.completedAt).getTime(), new Date(run.completedAt).getTime())).toISOString()
        : existing.completedAt || run.completedAt;
    if (run.firstTickTime && (!existing.firstTickTime || new Date(run.firstTickTime).getTime() < new Date(existing.firstTickTime).getTime())) {
      existing.firstTickTime = run.firstTickTime;
    }
    if (run.lastTickTime && (!existing.lastTickTime || new Date(run.lastTickTime).getTime() > new Date(existing.lastTickTime).getTime())) {
      existing.lastTickTime = run.lastTickTime;
    }
    existing.errorMessage = run.errorMessage || existing.errorMessage;
    existing.metadata = { ...existing.metadata, aggregatedBatches: Number(existing.metadata?.aggregatedBatches || 1) + 1 };
  }
  return [...groups.values()].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export default function MarketDataIngestionPage() {
  const [symbols, setSymbols] = useState<LiveSymbol[]>([]);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [count, setCount] = useState('5000');
  const [resumeFromCheckpoint, setResumeFromCheckpoint] = useState(true);
  const [freshIngestMode, setFreshIngestMode] = useState(false);
  const [recentRuns, setRecentRuns] = useState<IngestionRun[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [purging, setPurging] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | '1s' | 'volatility' | 'jump' | 'forex_metals'>('all');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearTarget, setClearTarget] = useState<'all' | 'failed'>('all');
  const [showPurgeModal, setShowPurgeModal] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<{ symbol: string; name: string } | null>(null);

  const [symbolsLoading, setSymbolsLoading] = useState(true);

  const availableSymbols = useMemo(() => symbols.filter((symbol) => symbol.isAvailable), [symbols]);
  
  const filteredSymbols = useMemo(() => {
    return availableSymbols.filter((item) => {
      const matchesSearch =
        item.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.symbol.toLowerCase().includes(searchQuery.toLowerCase());
      if (!matchesSearch) return false;
      if (activeFilter === '1s') return item.symbol.startsWith('1HZ');
      if (activeFilter === 'volatility') return item.symbol.startsWith('R_');
      if (activeFilter === 'jump') return item.symbol.startsWith('JD');
      if (activeFilter === 'forex_metals') return item.symbol.startsWith('frx') || item.symbol.startsWith('FRX');
      return true;
    });
  }, [availableSymbols, searchQuery, activeFilter]);

  const displayRuns = useMemo(() => aggregatePartialRuns(recentRuns), [recentRuns]);
  const failedRunsCount = useMemo(() => displayRuns.filter((r) => r.status === 'failed').length, [displayRuns]);
  const selectedLimit = runtime?.maxAssets ?? null;
  const selectAllLabel = selectedLimit === null ? 'Select all' : `Select all (max ${selectedLimit})`;

  const getHumanReadableAssetName = (symbolCode: string | null | undefined) => {
    if (!symbolCode) return 'Unavailable';
    const found = symbols.find((s) => s.symbol === symbolCode);
    if (found?.displayName) return found.displayName;
    // Pretty-print symbol code if symbol list is still loading
    if (symbolCode.startsWith('1HZ') && symbolCode.endsWith('V')) {
      return `Volatility ${symbolCode.replace('1HZ', '').replace('V', '')} (1s) Index`;
    }
    if (symbolCode.startsWith('R_')) {
      return `Volatility ${symbolCode.replace('R_', '')} Index`;
    }
    if (symbolCode.startsWith('BOOM')) return `Boom ${symbolCode.replace('BOOM', '')} Index`;
    if (symbolCode.startsWith('CRASH')) return `Crash ${symbolCode.replace('CRASH', '')} Index`;
    return symbolCode;
  };

  async function loadSymbols(): Promise<LiveSymbol[]> {
    setSymbolsLoading(true);
    try {
      const response = await adminFetch('/api/symbols', { cache: 'no-store' });
      if (response.status === 401) {
        if (typeof window !== 'undefined') window.location.replace('/admin');
        return [];
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `Unable to load live Deriv symbols (${response.status}).`);
      if (!Array.isArray(data?.symbols)) throw new Error('Deriv symbol endpoint returned an invalid symbol list.');
      const loaded = data.symbols.filter((item: LiveSymbol) => item?.symbol && item?.isAvailable);
      setSymbols(loaded);
      return loaded;
    } finally {
      setSymbolsLoading(false);
    }
  }

  const loadState = useCallback(async (symbolsToLoad: string[]) => {
    const qs = symbolsToLoad.length ? `?symbols=${encodeURIComponent(symbolsToLoad.join(','))}` : '';
    const response = await adminFetch(`/api/admin/market-data${qs}`, { cache: 'no-store' });
    if (response.status === 401) {
      if (typeof window !== 'undefined') window.location.replace('/admin');
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'Unable to load historical ingestion state.');
    if (data.runtime) setRuntime(data.runtime as RuntimeConfig);
    setRecentRuns(Array.isArray(data?.recentRuns) ? data.recentRuns : []);
    setCheckpoints(Array.isArray(data?.checkpoints) ? data.checkpoints : data?.checkpoint ? [data.checkpoint] : []);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await loadSymbols();
      if (!loaded || !loaded.length) return;
      let nextSelection: string[] = [];
      setSelectedSymbols((prevSelected) => {
        const validSelected = prevSelected.filter((symbol) => loaded.some((item) => item.symbol === symbol));
        nextSelection = validSelected.length ? validSelected : loaded.slice(0, 1).map((item) => item.symbol);
        return nextSelection;
      });
      await loadState(nextSelection);
    } catch (err: any) {
      setError(err?.message || 'Unable to load the historical ingestion page.');
    } finally {
      setLoading(false);
    }
  }, [loadState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function toggleSymbol(symbol: string) {
    setError(null);
    setSelectedSymbols((current) => {
      if (current.includes(symbol)) return current.filter((item) => item !== symbol);
      if (selectedLimit !== null && current.length >= selectedLimit) {
        setError(`A maximum of ${selectedLimit} assets can be selected for one ingestion batch.`);
        return current;
      }
      return [...current, symbol];
    });
  }

  function applyPreset(presetSymbols: string[]) {
    setError(null);
    const valid = presetSymbols.filter((s) => availableSymbols.some((a) => a.symbol === s));
    const finalSelection = selectedLimit !== null ? valid.slice(0, selectedLimit) : valid;
    setSelectedSymbols(finalSelection);
    setMessage(`Selected ${finalSelection.length} preset assets.`);
  }

  function selectAll() {
    setError(null);
    const selected =
      selectedLimit === null
        ? availableSymbols.map((symbol) => symbol.symbol)
        : availableSymbols.slice(0, selectedLimit).map((symbol) => symbol.symbol);
    setSelectedSymbols(selected);
    setMessage(
      selectedLimit !== null && availableSymbols.length > selectedLimit
        ? `Selected the first ${selectedLimit} available assets.`
        : `Selected all ${selected.length} available assets.`,
    );
  }

  async function handleClearRuns(target: 'all' | 'failed' | string) {
    setClearing(true);
    setError(null);
    setMessage(null);
    try {
      let endpoint = '/api/admin/market-data';
      if (target === 'failed') {
        endpoint += '?filter=failed';
      } else if (target !== 'all') {
        endpoint += `?runId=${encodeURIComponent(target)}`;
      }

      const response = await adminFetch(endpoint, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to clear ingestion runs.');
      }

      setMessage(data.message || `Cleared ingestion records.`);
      setShowClearConfirm(false);
      await loadState(selectedSymbols);
    } catch (err: any) {
      setError(err?.message || 'Failed to clear ingestion run history.');
    } finally {
      setClearing(false);
    }
  }

  async function handlePurgeTicks(targetSymbol: string, targetName?: string) {
    setPurging(true);
    setError(null);
    setMessage(null);
    try {
      const response = await adminFetch('/api/admin/market-data/purge-ticks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: targetSymbol,
          confirm: true,
          reason: `admin_dashboard_purge_${targetSymbol.toLowerCase()}`,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to purge stored ticks.');
      }

      setMessage(
        data.message ||
          `Successfully purged ${data.deletedTicks?.toLocaleString() ?? 0} ticks and reset checkpoints for ${targetName || targetSymbol}.`
      );
      setShowPurgeModal(false);
      setPurgeTarget(null);
      await loadState(selectedSymbols);
    } catch (err: any) {
      setError(err?.message || 'Failed to purge stored ticks from database.');
    } finally {
      setPurging(false);
    }
  }

  async function handleIngest() {
    if (!selectedSymbols.length) {
      setError('Select at least one asset.');
      return;
    }
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await adminFetch('/api/admin/market-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: selectedSymbols,
          count: Number(count),
          resumeFromCheckpoint: freshIngestMode ? false : resumeFromCheckpoint,
          freshIngest: freshIngestMode,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Historical ingestion failed.');
      }
      if (data.runtime) setRuntime(data.runtime as RuntimeConfig);
      if (Array.isArray(data.results)) {
        setMessage(
          `Ingestion batch finished: ${data.completedAssets ?? 0} completed, ${data.partialAssets ?? 0} partial, ${data.failedAssets ?? 0} failed across ${data.requestedAssets ?? selectedSymbols.length} assets.`,
        );
      } else {
        const inserted = Number(data.progress?.inserted ?? data.recordsInserted ?? 0);
        const requested = Number(data.progress?.requested ?? data.requestedCount ?? Number(count));
        const percent = Number(data.progress?.percent ?? ((inserted / Math.max(1, requested)) * 100));
        setMessage(
          `${freshIngestMode ? 'Fresh Ingest' : 'Backfill'} ${data.status === 'completed' ? 'completed' : 'in progress'}: ${inserted.toLocaleString()} / ${requested.toLocaleString()} real ticks stored (${Math.min(100, percent).toFixed(0)}%).`,
        );
      }
      await loadState(selectedSymbols);
    } catch (err: any) {
      setError(err?.message || 'Historical ingestion failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#05070b] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Top Header */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-white/10 pb-5">
          <div>
            <Link
              href="/admin"
              className="inline-flex items-center gap-2 text-xs font-semibold text-cyan-400 hover:text-cyan-300 transition"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Admin Operations
            </Link>
            <h1 className="mt-2 text-2xl sm:text-3xl font-black tracking-tight flex items-center gap-3">
              Market Data Ingestion Engine
              <span className="rounded-full bg-cyan-500/10 border border-cyan-500/30 px-3 py-0.5 text-xs font-bold text-cyan-300">
                v2.0 Multi-Cluster
              </span>
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-3xl">
              Download and synchronize authoritative Deriv tick history with multi-cluster failover, automatic rate-limit
              handling, and persistent checkpoint resumes.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/admin/dataset-builder"
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-bold text-cyan-300 hover:bg-cyan-500/20 transition"
            >
              <Layers className="h-4 w-4" />
              Dataset Builder
            </Link>
            <button
              onClick={refresh}
              disabled={loading || submitting}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold hover:bg-white/10 transition disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
              Refresh
            </button>
          </div>
        </header>

        {/* Global Feedback Banner */}
        {message && (
          <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-400 flex-shrink-0" />
              <span>{message}</span>
            </div>
            <button
              onClick={() => setMessage(null)}
              className="text-xs text-emerald-400 hover:underline font-semibold"
            >
              Dismiss
            </button>
          </div>
        )}

        {error && (
          <div className="rounded-2xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-red-400 flex-shrink-0" />
              <span>{error}</span>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-xs text-red-400 hover:underline font-semibold"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Main Grid: Control Panel + Checkpoint Inspector */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Ingestion Configuration Card */}
          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-6 lg:col-span-2 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/5 pb-4">
              <div className="flex items-center gap-2 text-sm font-bold text-cyan-400">
                <Radio className="h-4 w-4" />
                Historical Backfill Configuration
              </div>
              <span className="rounded-full bg-cyan-400/10 border border-cyan-400/20 px-3 py-1 text-xs font-bold text-cyan-300">
                {selectedSymbols.length} of {availableSymbols.length} Assets Selected
              </span>
            </div>

            {/* Quick Market Presets */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                  Quick Market Presets
                </span>
                <span className="text-[11px] text-slate-500 font-normal">Click to multi-select target assets</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {POPULAR_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset.symbols)}
                    disabled={submitting}
                    className="flex flex-col text-left p-3 rounded-2xl border border-white/10 bg-black/40 hover:border-cyan-500/40 hover:bg-cyan-500/5 transition group disabled:opacity-50"
                  >
                    <span className="text-xs font-bold text-slate-200 group-hover:text-cyan-300 flex items-center justify-between">
                      {preset.label}
                      <ArrowRight className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </span>
                    <span className="text-[11px] text-slate-500 mt-0.5">{preset.description}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Asset Selection Matrix */}
            <div className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Deriv Assets</span>
                  <div className="flex gap-1 bg-black/50 p-1 rounded-xl border border-white/5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setActiveFilter('all')}
                      className={`px-2.5 py-1 rounded-lg font-semibold transition ${
                        activeFilter === 'all' ? 'bg-cyan-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveFilter('1s')}
                      className={`px-2.5 py-1 rounded-lg font-semibold transition ${
                        activeFilter === '1s' ? 'bg-cyan-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      1s Vol
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveFilter('volatility')}
                      className={`px-2.5 py-1 rounded-lg font-semibold transition ${
                        activeFilter === 'volatility'
                          ? 'bg-cyan-500 text-slate-950'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Standard Vol
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveFilter('jump')}
                      className={`px-2.5 py-1 rounded-lg font-semibold transition ${
                        activeFilter === 'jump'
                          ? 'bg-cyan-500 text-slate-950'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Jump
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveFilter('forex_metals')}
                      className={`px-2.5 py-1 rounded-lg font-semibold transition ${
                        activeFilter === 'forex_metals'
                          ? 'bg-cyan-500 text-slate-950'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Forex / Metals
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={selectAll}
                    disabled={!availableSymbols.length || submitting}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10 transition disabled:opacity-50"
                  >
                    {selectAllLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedSymbols([])}
                    disabled={submitting || selectedSymbols.length === 0}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 transition disabled:opacity-50"
                  >
                    Deselect All
                  </button>
                  {selectedSymbols.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setPurgeTarget({
                          symbol: selectedSymbols.join(','),
                          name: `${selectedSymbols.length} Selected Asset${selectedSymbols.length === 1 ? '' : 's'} (${selectedSymbols.join(', ')})`,
                        });
                        setShowPurgeModal(true);
                      }}
                      disabled={submitting || purging}
                      className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/20 transition disabled:opacity-50 flex items-center gap-1.5"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Purge Selected ({selectedSymbols.length})
                    </button>
                  )}
                </div>
              </div>

              {/* Search Bar */}
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search synthetic assets (e.g. Volatility 100, Boom, 1HZ)..."
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-400/50"
              />

              {/* Scrollable Asset List */}
              <div className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                {symbolsLoading && availableSymbols.length === 0 ? (
                  <div className="col-span-full py-8 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
                    Loading Deriv active assets…
                  </div>
                ) : filteredSymbols.length === 0 ? (
                  <div className="col-span-full py-8 text-center text-xs text-slate-500">
                    No matching assets found.
                  </div>
                ) : (
                  filteredSymbols.map((asset) => {
                    const isSelected = selectedSymbols.includes(asset.symbol);
                    return (
                      <div
                        key={asset.symbol}
                        onClick={() => toggleSymbol(asset.symbol)}
                        className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 text-xs transition select-none ${
                          isSelected
                            ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200 shadow-sm'
                            : 'border-white/5 bg-black/20 text-slate-300 hover:border-white/20 hover:bg-white/5'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            disabled={submitting}
                            className="h-4 w-4 accent-cyan-400 rounded flex-shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <span className="block truncate font-bold text-slate-200">{asset.displayName}</span>
                            <span className="block text-[10px] text-slate-500 font-mono">{asset.symbol}</span>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setPurgeTarget({ symbol: asset.symbol, name: asset.displayName });
                            setShowPurgeModal(true);
                          }}
                          disabled={submitting || purging}
                          title={`Purge stored ticks for ${asset.displayName} from database`}
                          className="p-1.5 rounded-lg border border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition text-[10px] font-semibold flex items-center gap-1 flex-shrink-0"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span className="hidden sm:inline">Purge</span>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Depth & Execution Options */}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                  Ticks Per Asset
                </label>
                <div className="flex items-center gap-2">
                  <input
                    value={count}
                    onChange={(e) => setCount(e.target.value)}
                    inputMode="numeric"
                    className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm font-mono font-bold text-cyan-300 outline-none focus:border-cyan-400/50"
                  />
                </div>
                {/* Depth Quick Picks */}
                <div className="flex flex-wrap gap-1.5">
                  {TICK_DEPTH_PRESETS.map((presetCount) => (
                    <button
                      key={presetCount}
                      type="button"
                      onClick={() => setCount(presetCount.toString())}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-mono font-semibold transition ${
                        count === presetCount.toString()
                          ? 'bg-cyan-500 text-slate-950 font-bold'
                          : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200'
                      }`}
                    >
                      {presetCount.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/20 p-4 space-y-2 text-xs">
                <span className="block font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-cyan-400" />
                  Cluster Ingestion Engine
                </span>
                <p className="text-slate-300 leading-relaxed">
                  Executing concurrently across independent asset checkpoints with primary and failover WebSocket
                  clusters.
                </p>
                <div className="text-[11px] text-slate-500 font-mono">
                  Concurrency: {runtime?.concurrency ?? 1} asset stream | Real Deriv Historical Feed
                </div>
              </div>
            </div>

            {/* Ingestion Mode Segmented Choice */}
            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                Ingestion Mode
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setFreshIngestMode(false);
                    setResumeFromCheckpoint(true);
                  }}
                  className={`p-4 rounded-2xl border text-left transition flex items-start gap-3 ${
                    !freshIngestMode
                      ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200 shadow-sm'
                      : 'border-white/10 bg-black/20 text-slate-400 hover:border-white/20 hover:bg-black/30'
                  }`}
                >
                  <CheckCircle2
                    className={`h-5 w-5 mt-0.5 flex-shrink-0 ${!freshIngestMode ? 'text-cyan-400' : 'text-slate-500'}`}
                  />
                  <div>
                    <span className="block font-bold text-xs text-slate-200">Incremental Backfill</span>
                    <span className="block text-[11px] text-slate-400 mt-0.5">
                      Resumes from checkpoint and steps backward without re-fetching existing ticks.
                    </span>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setFreshIngestMode(true);
                    setResumeFromCheckpoint(false);
                  }}
                  className={`p-4 rounded-2xl border text-left transition flex items-start gap-3 ${
                    freshIngestMode
                      ? 'border-amber-400/40 bg-amber-400/10 text-amber-200 shadow-sm'
                      : 'border-white/10 bg-black/20 text-slate-400 hover:border-white/20 hover:bg-black/30'
                  }`}
                >
                  <RotateCcw
                    className={`h-5 w-5 mt-0.5 flex-shrink-0 ${freshIngestMode ? 'text-amber-400' : 'text-slate-500'}`}
                  />
                  <div>
                    <span className="block font-bold text-xs text-slate-200">Fresh Ingest (Auto-Purge)</span>
                    <span className="block text-[11px] text-slate-400 mt-0.5">
                      Automatically deletes stored ticks for selected assets in the database before starting.
                    </span>
                  </div>
                </button>
              </div>
            </div>

            {/* Checkpoint Checkbox (only when not in fresh ingest mode) */}
            {!freshIngestMode && (
              <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-xs text-slate-300 hover:bg-black/30 transition">
                <input
                  type="checkbox"
                  checked={resumeFromCheckpoint}
                  onChange={(e) => setResumeFromCheckpoint(e.target.checked)}
                  className="h-4 w-4 accent-cyan-400 rounded"
                />
                <div>
                  <span className="font-bold text-slate-200 block">Resume each asset from its saved checkpoint</span>
                  <span className="text-slate-400 block text-[11px] mt-0.5">
                    Avoids duplicate fetches and continues historical backfills backward in time seamlessly.
                  </span>
                </div>
              </label>
            )}

            {/* Submit CTA */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                onClick={handleIngest}
                disabled={submitting || !selectedSymbols.length}
                className={`inline-flex items-center gap-2 rounded-2xl px-6 py-3.5 text-sm font-bold text-slate-950 transition hover:opacity-95 shadow-lg disabled:cursor-not-allowed disabled:opacity-50 ${
                  freshIngestMode
                    ? 'bg-gradient-to-r from-amber-400 to-orange-500 shadow-amber-500/20'
                    : 'bg-gradient-to-r from-cyan-400 to-blue-500 shadow-cyan-500/20'
                }`}
              >
                {submitting ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : freshIngestMode ? (
                  <RotateCcw className="h-5 w-5" />
                ) : (
                  <DatabaseZap className="h-5 w-5" />
                )}
                {submitting
                  ? `Ingesting ${selectedSymbols.length} Asset${selectedSymbols.length === 1 ? '' : 's'}…`
                  : freshIngestMode
                  ? `Start Fresh Ingest (${selectedSymbols.length} Selected)`
                  : `Start Ingestion (${selectedSymbols.length} Selected)`}
              </button>
              <span className="text-xs text-slate-400">
                100% Real Deriv tick history. No synthetic/dummy data.
              </span>
            </div>
          </div>

          {/* Right Column: Asset Checkpoints */}
          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-white/5 pb-4">
              <div className="flex items-center gap-2 text-sm font-bold text-emerald-400">
                <Server className="h-4 w-4" />
                Asset Checkpoints ({checkpoints.length})
              </div>
              <span className="text-xs text-slate-500">Persistent Ticks</span>
            </div>

            {checkpoints.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-xs text-slate-500">
                No checkpoints stored yet for selected assets. Run an ingestion to establish initial checkpoints.
              </div>
            ) : (
              <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
                {checkpoints.map((checkpoint) => (
                  <div
                    key={checkpoint.symbol}
                    className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-2 hover:border-emerald-500/30 transition"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-200 text-xs">
                        {getHumanReadableAssetName(checkpoint.symbol)}
                      </span>
                      <span className="font-mono text-[10px] text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded-full">
                        {checkpoint.symbol}
                      </span>
                    </div>

                    <div className="text-[11px] text-slate-400 space-y-1">
                      <div className="flex items-center justify-between">
                        <span>Last Tick:</span>
                        <span className="font-mono text-slate-200">
                          {checkpoint.lastTickTime ? new Date(checkpoint.lastTickTime).toLocaleString() : 'Unavailable'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-slate-500">
                        <span>Updated:</span>
                        <span>{new Date(checkpoint.updatedAt).toLocaleTimeString()}</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setPurgeTarget({
                          symbol: checkpoint.symbol,
                          name: getHumanReadableAssetName(checkpoint.symbol),
                        });
                        setShowPurgeModal(true);
                      }}
                      disabled={submitting || purging}
                      className="w-full mt-2 inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-500/20 bg-red-500/10 py-1.5 text-[11px] font-semibold text-red-300 hover:bg-red-500/20 transition"
                    >
                      <Trash2 className="h-3 w-3" />
                      Purge Stored Ticks
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Ingestion Runs Section with Clear Actions */}
        <section className="rounded-3xl border border-white/10 bg-white/[0.025] p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/5 pb-4">
            <div>
              <h3 className="text-base font-bold text-slate-200 flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-cyan-400" />
                Recent Ingestion Runs ({displayRuns.length})
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Audit history of market-data ingestion batches and their database storage status.
              </p>
            </div>

            {/* Clear Action Controls */}
            <div className="flex items-center gap-2">
              {failedRunsCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setClearTarget('failed');
                    setShowClearConfirm(true);
                  }}
                  disabled={clearing || loading}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs font-bold text-amber-300 hover:bg-amber-500/20 transition disabled:opacity-50"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Clear Failed Runs ({failedRunsCount})
                </button>
              )}

              {displayRuns.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setClearTarget('all');
                    setShowClearConfirm(true);
                  }}
                  disabled={clearing || loading}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2 text-xs font-bold text-red-300 hover:bg-red-500/20 transition disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear All History
                </button>
              )}
            </div>
          </div>

          {/* Confirmation Modal / Banner */}
          {showClearConfirm && (
            <div className="rounded-2xl border border-red-500/30 bg-red-950/40 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h4 className="text-sm font-bold text-red-200">
                    Confirm {clearTarget === 'failed' ? 'Failed Runs Clearance' : 'Full Ingestion Log Clearance'}
                  </h4>
                  <p className="text-xs text-slate-300">
                    {clearTarget === 'failed'
                      ? `This will remove ${failedRunsCount} failed/rate-limited run records from the audit log. Stored tick data is NOT deleted.`
                      : 'This will purge all ingestion audit records from the data_ingestion_runs table. Underlying ticks in the database remain completely intact.'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowClearConfirm(false)}
                  disabled={clearing}
                  className="rounded-xl border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/10 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleClearRuns(clearTarget)}
                  disabled={clearing}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-red-500 px-4 py-1.5 text-xs font-bold text-white hover:bg-red-600 transition disabled:opacity-50"
                >
                  {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Confirm Clear
                </button>
              </div>
            </div>
          )}

          {/* Runs Grid */}
          {loading ? (
            <div className="py-12 text-center text-xs text-slate-500">
              <Loader2 className="h-6 w-6 animate-spin text-cyan-400 mx-auto mb-2" />
              Loading historical ingestion runs…
            </div>
          ) : displayRuns.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center text-xs text-slate-500">
              No historical ingestion runs recorded. Configure and run a backfill above.
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {displayRuns.map((run) => {
                const progress = Math.min(100, (run.recordsInserted / Math.max(1, run.requestedCount)) * 100);
                const rawBatches = run.metadata?.batches;
                const batchCount = Number(
                  run.metadata?.aggregatedBatches || (Array.isArray(rawBatches) ? rawBatches.length : 0),
                );
                const assetName = getHumanReadableAssetName(run.symbol);

                return (
                  <article
                    key={run.runId}
                    className="rounded-2xl border border-white/10 bg-black/30 p-5 text-sm space-y-4 hover:border-white/20 transition relative group"
                  >
                    {/* Header */}
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-bold text-slate-100 flex items-center gap-2">
                          {assetName}
                          <span className="font-mono text-[10px] text-cyan-300 bg-cyan-500/10 px-2 py-0.5 rounded">
                            {run.symbol}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-slate-500 flex items-center gap-1.5">
                          <Clock className="h-3 w-3" />
                          {new Date(run.startedAt).toLocaleString()}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span
                          className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold tracking-wider ${
                            run.status === 'completed'
                              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                              : run.status === 'partial'
                              ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
                              : run.status === 'failed'
                              ? 'border-red-400/30 bg-red-400/10 text-red-200'
                              : 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200'
                          }`}
                        >
                          {run.status === 'partial' ? 'IN PROGRESS' : run.status.toUpperCase()}
                        </span>

                        <button
                          type="button"
                          onClick={() => handleClearRuns(run.runId)}
                          disabled={clearing}
                          title="Delete this run record"
                          className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-red-400 transition"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="space-y-1.5">
                      <div className="h-2 overflow-hidden rounded-full bg-white/10">
                        <div
                          className={`h-full rounded-full transition-all ${
                            run.status === 'failed'
                              ? 'bg-red-400'
                              : run.status === 'completed'
                              ? 'bg-emerald-400'
                              : 'bg-cyan-400'
                          }`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="font-semibold text-slate-200">
                          {run.recordsInserted.toLocaleString()} / {run.requestedCount.toLocaleString()}
                        </span>
                        <span className="text-slate-400 font-bold">{progress.toFixed(0)}%</span>
                      </div>
                    </div>

                    {/* Metrics 4-grid */}
                    <div className="grid grid-cols-2 gap-2.5 rounded-xl border border-white/5 bg-black/40 p-3 text-xs">
                      <div>
                        <span className="block text-[10px] text-slate-500 uppercase font-semibold">Requested</span>
                        <span className="font-mono font-bold text-slate-200">
                          {run.requestedCount.toLocaleString()}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[10px] text-slate-500 uppercase font-semibold">Stored Ticks</span>
                        <span className="font-mono font-bold text-emerald-400">
                          {run.recordsInserted.toLocaleString()}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[10px] text-slate-500 uppercase font-semibold">Received</span>
                        <span className="font-mono text-slate-300">{run.recordsReceived.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="block text-[10px] text-slate-500 uppercase font-semibold">Rejected</span>
                        <span className="font-mono text-slate-400">{run.recordsRejected.toLocaleString()}</span>
                      </div>
                    </div>

                    {batchCount > 1 && (
                      <div className="text-[11px] text-cyan-300 flex items-center gap-1.5">
                        <Activity className="h-3.5 w-3.5" />
                        {batchCount} ingestion batches aggregated into this session.
                      </div>
                    )}

                    {/* Timestamp range */}
                    <div className="text-[11px] text-slate-500 font-mono">
                      {run.firstTickTime ? `From: ${new Date(run.firstTickTime).toLocaleString()}` : 'No start time'}
                      {run.lastTickTime ? ` • To: ${new Date(run.lastTickTime).toLocaleString()}` : ''}
                    </div>

                    {/* Error Banner */}
                    {run.errorMessage && (
                      <div className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-200 space-y-1">
                        <span className="font-bold block">Failure Detail:</span>
                        <span className="block break-words">{run.errorMessage}</span>
                      </div>
                    )}

                    {/* Bridge to Dataset Builder */}
                    {run.status === 'completed' && run.recordsInserted > 0 && (
                      <div className="pt-2 border-t border-white/5 flex items-center justify-between">
                        <span className="text-[11px] text-slate-400">Ready for dataset pipeline</span>
                        <Link
                          href={`/admin/dataset-builder?symbol=${encodeURIComponent(run.symbol)}`}
                          className="inline-flex items-center gap-1.5 text-xs font-bold text-cyan-400 hover:text-cyan-300 transition"
                        >
                          Build Dataset
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
        {/* Purge Ticks Confirmation Modal */}
        {showPurgeModal && purgeTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="w-full max-w-lg rounded-3xl border border-red-500/30 bg-[#0d1017] p-6 shadow-2xl space-y-5">
              <div className="flex items-start gap-4">
                <div className="p-3 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 flex-shrink-0">
                  <AlertTriangle className="h-6 w-6" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-lg font-bold text-slate-100">
                    Confirm Permanent Tick Deletion
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    You are about to permanently purge all raw tick records from the database table (<span className="text-cyan-300 font-mono">market_ticks</span>) and reset the ingestion checkpoint for:
                  </p>
                  <div className="mt-2 p-2.5 rounded-xl bg-black/40 border border-white/5 font-mono text-xs text-amber-300">
                    {purgeTarget.name} ({purgeTarget.symbol})
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-red-500/20 bg-red-950/30 p-3.5 text-xs text-red-200 space-y-1.5">
                <span className="font-bold block flex items-center gap-1.5">
                  <ShieldAlert className="h-4 w-4 text-red-400" />
                  Database Clearance Warning:
                </span>
                <p className="text-slate-300 text-[11px] leading-relaxed">
                  This operation directly deletes all stored ticks from your connected <span className="font-mono text-cyan-300">DATABASE_URL</span> and clears corresponding checkpoint entries. This action cannot be undone.
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowPurgeModal(false);
                    setPurgeTarget(null);
                  }}
                  disabled={purging}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handlePurgeTicks(purgeTarget.symbol, purgeTarget.name)}
                  disabled={purging}
                  className="inline-flex items-center gap-2 rounded-xl bg-red-500 px-5 py-2 text-xs font-bold text-white hover:bg-red-600 transition shadow-lg shadow-red-500/20 disabled:opacity-50"
                >
                  {purging ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  {purging ? 'Purging from Database…' : 'Confirm Permanent Purge'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
