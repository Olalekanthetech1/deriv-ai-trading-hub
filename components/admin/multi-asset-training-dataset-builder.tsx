'use client';

import Link from 'next/link';
import { AssetBatchPresets } from './asset-batch-presets';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Beaker,
  CheckCircle2,
  Database,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
  CheckSquare,
  Square,
  AlertTriangle,
  Search,
  Filter,
  Layers,
} from 'lucide-react';
import { formatReadableAsset, formatReadableDatasetName, formatReadableDuration } from '@/lib/ml-display-formatters';
import { UnifiedMultiHorizonDatasetBuilder } from './unified-multi-horizon-dataset-builder';
import { adminFetch } from '@/lib/admin-client-auth';

type DurationUnit = 't' | 's' | 'm' | 'h' | 'd';
type SymbolItem = { symbol: string; displayName: string; market: string; submarket: string; isOpen: boolean; isAvailable: boolean };
type DurationRange = { id: string; unit: DurationUnit; min: number; max: number; tradeTypes: string[]; source: string };
type TrainingHorizon = { value: number; unit: DurationUnit; rangeId: string };
type Dataset = {
  id: string;
  name: string;
  raw_name?: string;
  asset_symbol: string;
  horizon_ticks: number;
  duration_value: number | null;
  duration_unit: DurationUnit | null;
  duration_seconds: number | null;
  sample_count: number;
  train_count: number;
  validation_count: number;
  test_count: number;
  status: string;
  leakage_check_passed: boolean;
  metadata?: { assetDisplayName?: string } | null;
};
type AssetState = {
  symbol: string;
  datasets: Dataset[];
  durationSource: string;
  durationDiscovery: { ranges: DurationRange[] };
  trainingHorizons: TrainingHorizon[];
  autoTrainingHorizons: TrainingHorizon[];
};
type AutoJob = {
  id: string;
  symbol: string;
  status: 'running' | 'completed' | 'failed';
  requestedCount: number;
  completedCount: number;
  skippedCount: number;
  failedCount: number;
  cancelledCount?: number;
  skips: Array<{ value: number; unit: DurationUnit; reason: string }>;
  failures: Array<{ value: number; unit: DurationUnit; error: string }>;
};
type RuntimeLimits = { maxAssets: number | null; concurrency: number; pollIntervalMs: number };

const unitLabel: Record<DurationUnit, string> = { t: 'ticks', s: 'seconds', m: 'minutes', h: 'hours', d: 'days' };

function key(h: TrainingHorizon) {
  return `${h.value}:${h.unit}`;
}

async function readJson(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`Request failed with HTTP ${response.status}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    if (response.status === 401) {
      throw new Error('Admin authorization required. Please authenticate.');
    }
    throw new Error(`Invalid server response (HTTP ${response.status}).`);
  }
}

function durationText(value: number, unit: DurationUnit) {
  return formatReadableDuration(value, unit);
}

export default function MultiAssetTrainingDatasetBuilder() {
  const [symbols, setSymbols] = useState<SymbolItem[]>([]);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [assets, setAssets] = useState<Record<string, AssetState>>({});
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedUnit, setSelectedUnit] = useState<DurationUnit>('t');
  const [selectedHorizons, setSelectedHorizons] = useState<string[]>([]);
  const [autoMode, setAutoMode] = useState(false);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [jobs, setJobs] = useState<AutoJob[]>([]);
  const [limits, setLimits] = useState<RuntimeLimits | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Multi-select & Batch Deletion state
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<string[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [datasetSearch, setDatasetSearch] = useState('');
  const [datasetUnitFilter, setDatasetUnitFilter] = useState<string>('ALL');
  const [builderMode, setBuilderMode] = useState<'standard' | 'unified'>('unified');

  const selectedAssets = useMemo(
    () => selectedSymbols.map((symbol) => symbols.find((item) => item.symbol === symbol)).filter(Boolean) as SymbolItem[],
    [selectedSymbols, symbols]
  );
  const selectedStates = useMemo(() => selectedSymbols.map((symbol) => assets[symbol]).filter(Boolean), [assets, selectedSymbols]);
  const allAvailableHorizons = useMemo(() => {
    if (!selectedStates.length) return [] as TrainingHorizon[];
    const map = new Map<string, TrainingHorizon>();
    for (const state of selectedStates) {
      for (const h of state.trainingHorizons) {
        if (!map.has(key(h))) map.set(key(h), h);
      }
    }
    return [...map.values()].sort((a, b) => a.unit.localeCompare(b.unit) || a.value - b.value);
  }, [selectedStates]);
  const commonHorizons = useMemo(() => {
    if (!selectedStates.length) return [] as TrainingHorizon[];
    const map = new Map<string, TrainingHorizon>(selectedStates[0].trainingHorizons.map((h) => [key(h), h]));
    for (const state of selectedStates.slice(1)) {
      const keys = new Set(state.trainingHorizons.map(key));
      for (const candidate of [...map.keys()]) if (!keys.has(candidate)) map.delete(candidate);
    }
    return [...map.values()].sort((a, b) => a.unit.localeCompare(b.unit) || a.value - b.value);
  }, [selectedStates]);
  const activeHorizons = useMemo(() => {
    return commonHorizons.length > 0 ? commonHorizons : allAvailableHorizons;
  }, [commonHorizons, allAvailableHorizons]);
  const visibleHorizons = useMemo(() => activeHorizons.filter((horizon) => horizon.unit === selectedUnit), [activeHorizons, selectedUnit]);
  const availableUnits = useMemo(() => [...new Set(activeHorizons.map((h) => h.unit))], [activeHorizons]);
  const selectedCommonHorizons = useMemo(
    () => selectedHorizons.map((value) => allAvailableHorizons.find((horizon) => key(horizon) === value)).filter(Boolean) as TrainingHorizon[],
    [allAvailableHorizons, selectedHorizons]
  );
  const totals = useMemo(
    () =>
      jobs.reduce(
        (acc, job) => {
          acc.requested += job.requestedCount;
          acc.completed += job.completedCount;
          acc.skipped += job.skippedCount;
          acc.failed += job.failedCount;
          acc.cancelled += job.cancelledCount ?? 0;
          return acc;
        },
        { requested: 0, completed: 0, skipped: 0, failed: 0, cancelled: 0 }
      ),
    [jobs]
  );
  const terminal = totals.completed + totals.skipped + totals.failed + totals.cancelled;
  const progress = totals.requested ? Math.min(100, Math.round((terminal / totals.requested) * 100)) : 0;
  const busy = building || jobIds.length > 0;
  const limitLabel = limits?.maxAssets == null ? 'Select all' : `Select all (${limits.maxAssets})`;

  // Filtered dataset list for table display
  const filteredDatasets = useMemo(() => {
    const q = datasetSearch.trim().toLowerCase();
    return datasets.filter((ds) => {
      const matchesSearch =
        !q ||
        (ds.name && ds.name.toLowerCase().includes(q)) ||
        (ds.asset_symbol && ds.asset_symbol.toLowerCase().includes(q)) ||
        (ds.id && ds.id.toLowerCase().includes(q));
      const matchesUnit = datasetUnitFilter === 'ALL' || ds.duration_unit === datasetUnitFilter;
      return matchesSearch && matchesUnit;
    });
  }, [datasets, datasetSearch, datasetUnitFilter]);

  async function loadSymbols() {
    const response = await adminFetch('/api/symbols', { cache: 'no-store' });
    const data = await readJson(response);
    if (!response.ok || !Array.isArray(data?.symbols)) throw new Error(data?.error || 'Live Deriv symbols are unavailable.');
    const live = (data.symbols as SymbolItem[]).filter((item) => item.isAvailable);
    setSymbols(live);
    setSelectedSymbols((current) => {
      const valid = current.filter((symbol) => live.some((item) => item.symbol === symbol));
      return valid.length ? valid : live[0] ? [live[0].symbol] : [];
    });
  }

  async function loadState(symbolList: string[]) {
    if (!symbolList.length) {
      setAssets({});
      setDatasets([]);
      setSelectedDatasetIds([]);
      return;
    }
    const response = await adminFetch(`/api/admin/dataset-batches?symbols=${encodeURIComponent(symbolList.join(','))}`, { cache: 'no-store' });
    const data = await readJson(response);
    if (!response.ok || !data?.success) throw new Error(data?.error || 'Unable to load dataset builder state.');
    if (data.limits) setLimits(data.limits as RuntimeLimits);
    const next: Record<string, AssetState> = {};
    for (const asset of data.assets as AssetState[]) next[asset.symbol] = asset;
    setAssets(next);
    const rawDatasets = (data.datasets || []) as Dataset[];
    setDatasets(rawDatasets);
    setSelectedDatasetIds((current) => current.filter((id) => rawDatasets.some((d) => d.id === id)));
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      await loadSymbols();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Dataset Builder.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (selectedSymbols.length) {
      void loadState(selectedSymbols).catch((err) => setError(err instanceof Error ? err.message : 'Unable to load dataset builder state.'));
    } else {
      setAssets({});
      setDatasets([]);
      setSelectedDatasetIds([]);
    }
  }, [selectedSymbols]);

  useEffect(() => {
    setSelectedHorizons((current) => current.filter((selected) => commonHorizons.some((horizon) => key(horizon) === selected)));
  }, [commonHorizons]);

  useEffect(() => {
    if (!availableUnits.length) return;
    if (!availableUnits.includes(selectedUnit)) setSelectedUnit(availableUnits[0]);
  }, [availableUnits, selectedUnit]);

  useEffect(() => {
    if (!jobIds.length || !limits?.pollIntervalMs) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await adminFetch(`/api/admin/dataset-batches?jobIds=${encodeURIComponent(jobIds.join(','))}`, { cache: 'no-store' });
        const data = await readJson(response);
        if (!response.ok || !data?.success) throw new Error(data?.error || 'Unable to read dataset build progress.');
        if (cancelled) return;
        if (data.limits) setLimits(data.limits as RuntimeLimits);
        const nextJobs = data.jobs as AutoJob[];
        setJobs(nextJobs);
        if (nextJobs.some((job) => job.status === 'running')) return;
        setJobIds([]);
        await loadState(selectedSymbols);
        const failed = nextJobs.reduce((sum, job) => sum + job.failedCount, 0);
        const completed = nextJobs.reduce((sum, job) => sum + job.completedCount, 0);
        const skipped = nextJobs.reduce((sum, job) => sum + job.skippedCount, 0);
        if (failed) setError(`Dataset batch finished: ${completed} created, ${skipped} skipped, ${failed} failed.`);
        else setMessage(`Dataset batch finished: ${completed} datasets created and ${skipped} feasibility skips across ${nextJobs.length} assets.`);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to read dataset build progress.');
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), limits.pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobIds, limits?.pollIntervalMs, selectedSymbols]);

  function toggle(symbol: string) {
    setSelectedSymbols((current) => {
      if (current.includes(symbol)) return current.filter((item) => item !== symbol);
      if (limits?.maxAssets !== null && limits?.maxAssets !== undefined && current.length >= limits.maxAssets) {
        setError(`A maximum of ${limits.maxAssets} assets can be selected.`);
        return current;
      }
      return [...current, symbol];
    });
    setAutoMode(false);
  }

  function selectAll() {
    const selected = limits?.maxAssets == null ? symbols.map((item) => item.symbol) : symbols.slice(0, limits.maxAssets).map((item) => item.symbol);
    setSelectedSymbols(selected);
    if (limits?.maxAssets != null && symbols.length > limits.maxAssets) setMessage(`Selected the first ${limits.maxAssets} available assets.`);
  }

  function chooseUnit(unit: DurationUnit) {
    setSelectedUnit(unit);
    setAutoMode(false);
  }

  function toggleHorizon(horizon: TrainingHorizon) {
    const horizonKey = key(horizon);
    setSelectedHorizons((current) =>
      current.includes(horizonKey) ? current.filter((value) => value !== horizonKey) : [...current, horizonKey]
    );
    setAutoMode(false);
  }

  async function startBuild(body: Record<string, unknown>) {
    setBuilding(true);
    setError(null);
    setMessage(null);
    setJobs([]);
    try {
      const response = await adminFetch('/api/admin/dataset-batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await readJson(response);
      if (data.limits) setLimits(data.limits as RuntimeLimits);
      if (!response.ok || !data?.success) throw new Error(data?.error || 'Unable to start dataset build.');
      setJobIds((data.autoJobIds || []).map(String));
      setJobs((data.jobs || []) as AutoJob[]);
      setMessage(data.message || 'Dataset build started.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start dataset build.');
    } finally {
      setBuilding(false);
    }
  }

  async function buildSelected() {
    if (!selectedSymbols.length || !selectedCommonHorizons.length || busy) return;
    await startBuild({
      symbols: selectedSymbols,
      durations: selectedCommonHorizons.map((horizon) => ({ value: horizon.value, unit: horizon.unit })),
    });
  }

  async function buildAll() {
    if (!selectedSymbols.length || busy) return;
    await startBuild({
      symbols: selectedSymbols,
      buildAllSupportedHorizons: true,
      ...(autoMode ? {} : { durationUnit: selectedUnit }),
    });
  }

  async function archiveReports() {
    if (jobIds.length || !jobs.length) return;
    try {
      const response = await adminFetch(`/api/admin/dataset-batches?jobIds=${encodeURIComponent(jobs.map((job) => job.id).join(','))}`, {
        method: 'DELETE',
        cache: 'no-store',
      });
      const data = await readJson(response);
      if (data.limits) setLimits(data.limits as RuntimeLimits);
      if (!response.ok || !data?.success) throw new Error(data?.error || 'Unable to archive reports.');
      setJobs([]);
      setMessage('Dataset build reports archived. Persisted datasets were preserved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to archive reports.');
    }
  }

  async function stopAllJobs() {
    if (!window.confirm('Are you sure you want to stop and cancel ALL active background dataset jobs?')) return;
    setBuilding(true);
    setError(null);
    setMessage(null);
    try {
      const response = await adminFetch('/api/admin/datasets?stopAll=1', { method: 'DELETE', cache: 'no-store' });
      const data = await readJson(response);
      if (!response.ok || !data?.success) throw new Error(data?.error || 'Unable to stop active jobs.');
      setJobIds([]);
      setJobs([]);
      setMessage(data.message || 'All background dataset build jobs were stopped and cancelled.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to stop background dataset jobs.');
    } finally {
      setBuilding(false);
    }
  }

  // Single dataset deletion
  async function removeDataset(dataset: Dataset) {
    if (deletingId || batchDeleting) return;
    if (!window.confirm(`Delete dataset “${dataset.name}”? The server will protect datasets with training/model lineage.`)) return;
    setDeletingId(dataset.id);
    setError(null);
    setMessage(null);
    try {
      const response = await adminFetch(`/api/admin/datasets/${encodeURIComponent(dataset.id)}`, { method: 'DELETE', cache: 'no-store' });
      const data = await readJson(response);
      if (!response.ok || !data?.success) throw new Error(data?.message || data?.error || 'Unable to delete dataset.');
      setDatasets((current) => current.filter((item) => item.id !== dataset.id));
      setSelectedDatasetIds((current) => current.filter((id) => id !== dataset.id));
      setMessage(`Deleted ${dataset.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete dataset.');
    } finally {
      setDeletingId(null);
    }
  }

  // Multi-select helpers
  function toggleDatasetSelect(id: string) {
    setSelectedDatasetIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function selectAllFilteredDatasets() {
    const ids = filteredDatasets.map((d) => d.id);
    setSelectedDatasetIds((current) => {
      const allSelected = ids.every((id) => current.includes(id));
      if (allSelected) {
        return current.filter((id) => !ids.includes(id));
      }
      return Array.from(new Set([...current, ...ids]));
    });
  }

  function clearSelectedDatasets() {
    setSelectedDatasetIds([]);
  }

  // Batch Deletion action
  async function removeSelectedDatasets() {
    if (!selectedDatasetIds.length || batchDeleting || busy) return;
    const count = selectedDatasetIds.length;
    const confirmed = window.confirm(
      `Delete ${count} selected dataset${count > 1 ? 's' : ''}?\n\nThe server will safely delete unlinked datasets while protecting any datasets linked to active training runs or registered ML models.`
    );
    if (!confirmed) return;

    setBatchDeleting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await adminFetch('/api/admin/datasets/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetIds: selectedDatasetIds }),
      });
      const data = await readJson(response);
      if (!response.ok || !data?.success) {
        throw new Error(data?.message || data?.error || 'Unable to delete selected datasets.');
      }

      // Reload dataset state
      await loadState(selectedSymbols);
      setMessage(data.message || `Batch deletion completed.`);
      if (data.blockedCount > 0) {
        setError(`${data.blockedCount} dataset(s) were protected from deletion due to training or model lineage.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to complete batch deletion.');
    } finally {
      setBatchDeleting(false);
    }
  }

  const allFilteredSelected =
    filteredDatasets.length > 0 && filteredDatasets.every((ds) => selectedDatasetIds.includes(ds.id));

  return (
    <main className="min-h-screen bg-[#05070b] px-4 py-5 text-slate-100 sm:px-6 lg:px-8 pb-24">
      <div className="mx-auto max-w-[1500px]">
        {/* Header */}
        <header className="mb-5 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/admin" className="mb-3 inline-flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-300">
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to Admin Operations
            </Link>
            <div className="flex items-center gap-3">
              <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3">
                <Beaker className="h-6 w-6 text-cyan-300" />
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-300">Agenda 5</p>
                <h1 className="text-2xl font-black sm:text-3xl">Training Dataset Builder</h1>
                <p className="mt-1 text-sm text-slate-500">
                  Leakage-safe datasets built from persisted real Deriv ticks with broker-driven durations.
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void stopAllJobs()}
              disabled={building || busy}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-300 hover:bg-red-500/20 disabled:opacity-50 cursor-pointer"
              title="Immediately stop and cancel all active background dataset construction jobs"
            >
              <XCircle className="h-4 w-4" />
              Stop All Auto Jobs
            </button>
            <button
              onClick={() => void refresh()}
              disabled={loading || busy}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold disabled:opacity-50 hover:bg-white/10 cursor-pointer"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </header>

        {/* Alerts */}
        {error && (
          <div className="mb-5 flex items-start gap-3 rounded-2xl border border-red-400/20 bg-red-400/5 p-4 text-sm text-red-200">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {message && (
          <div className="mb-5 flex items-start gap-3 rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-sm text-emerald-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{message}</span>
          </div>
        )}

        {/* Mode Selector Tabs */}
        <div className="mb-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="flex overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-1.5 max-w-xl">
            <button
              type="button"
              onClick={() => setBuilderMode('unified')}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2.5 px-4 text-xs font-bold transition cursor-pointer ${
                builderMode === 'unified'
                  ? 'bg-cyan-400 text-slate-950 shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="h-4 w-4" />
              Unified Multi-Horizon Builder (Primary · All-in-1)
            </button>
            <button
              type="button"
              onClick={() => setBuilderMode('standard')}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2.5 px-4 text-xs font-bold transition cursor-pointer ${
                builderMode === 'standard'
                  ? 'bg-cyan-400 text-slate-950 shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Database className="h-4 w-4" />
              Single-Duration Datasets (Legacy)
            </button>
          </div>

          {builderMode === 'standard' && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-300 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>Legacy single-duration builder is superseded by Unified Multi-Horizon training.</span>
            </div>
          )}
        </div>

        {builderMode === 'unified' ? (
          <UnifiedMultiHorizonDatasetBuilder />
        ) : (
          <>
        {/* Builder Controls */}
        <section className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
          <article className="rounded-3xl border border-white/10 bg-white/[0.025] p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-bold text-cyan-300">
                <Sparkles className="h-4 w-4" />
                Build dataset
              </div>
              <span className="text-xs text-slate-500">{selectedSymbols.length} selected</span>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="mb-3 flex flex-col gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Deriv assets</span>
                <AssetBatchPresets
                  availableAssets={symbols as any}
                  onSelectSymbols={(newSymbols: string[]) => {
                    const selected = limits?.maxAssets == null ? newSymbols : newSymbols.slice(0, limits.maxAssets);
                    setSelectedSymbols(selected);
                    if (limits?.maxAssets != null && newSymbols.length > limits.maxAssets) {
                      setMessage(`Limited selection to ${limits.maxAssets} assets due to concurrency limits.`);
                    }
                  }}
                  onClear={() => setSelectedSymbols([])}
                  selectedCount={selectedSymbols.length}
                />
              </div>
              <div className="grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-2">
                {symbols.map((asset) => (
                  <label
                    key={asset.symbol}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition ${
                      selectedSymbols.includes(asset.symbol)
                        ? 'border-cyan-400/30 bg-cyan-400/[0.06]'
                        : 'border-white/10 bg-black/10 hover:bg-white/[0.02]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSymbols.includes(asset.symbol)}
                      onChange={() => toggle(asset.symbol)}
                      disabled={busy}
                      className="h-4 w-4 accent-cyan-400"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{asset.displayName}</span>
                      <span className="text-[11px] text-slate-500">{asset.symbol}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Prediction horizon</span>
                <span className="text-xs font-semibold text-cyan-300">{selectedHorizons.length} selected</span>
              </div>
              <div className="flex flex-wrap overflow-hidden rounded-xl border border-white/10 bg-black/30">
                <button
                  onClick={() => {
                    setAutoMode(true);
                    setSelectedHorizons([]);
                  }}
                  disabled={busy || !selectedSymbols.length}
                  className={`px-4 py-3 text-xs font-bold cursor-pointer transition ${
                    autoMode ? 'bg-cyan-400 text-slate-950' : 'text-slate-300 hover:bg-white/5'
                  }`}
                >
                  AUTO
                </button>
                {availableUnits.map((unit) => (
                  <button
                    key={unit}
                    onClick={() => chooseUnit(unit)}
                    disabled={busy}
                    className={`px-4 py-3 text-xs font-bold sm:text-sm cursor-pointer transition ${
                      !autoMode && selectedUnit === unit ? 'bg-cyan-400 text-slate-950' : 'text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    {unit === 't' ? 'TICKS' : unit === 's' ? 'SEC' : unit === 'm' ? 'MIN' : unit === 'h' ? 'HOUR' : 'DAY'}
                  </button>
                ))}
              </div>
            </div>

            {!autoMode ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {visibleHorizons.map((horizon) => {
                  const selected = selectedHorizons.includes(key(horizon));
                  return (
                    <button
                      key={key(horizon)}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleHorizon(horizon)}
                      disabled={busy}
                      className={`rounded-full border px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
                        selected
                          ? 'border-cyan-400/35 bg-cyan-400/15 text-cyan-100'
                          : 'border-white/10 text-slate-400 hover:border-white/20'
                      }`}
                    >
                      {durationText(horizon.value, horizon.unit)}
                    </button>
                  );
                })}
                {!visibleHorizons.length && (
                  <span className="text-xs text-slate-600">
                    No common horizon across all selected assets. AUTO can still build each asset's supported durations.
                  </span>
                )}
              </div>
            ) : (
              <p className="mt-3 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] p-3 text-xs text-cyan-100">
                AUTO uses each selected asset's own broker-discovered duration ladder.
              </p>
            )}

            {!autoMode && selectedHorizons.length > 0 && (
              <p className="mt-2 text-[11px] text-slate-500">
                Selected horizons are preserved when switching units and will be submitted together.
              </p>
            )}

            <label className="mt-4 flex items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-300">
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              Each asset keeps independent broker-duration, leakage, and dataset lineage.
            </label>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button
                onClick={() => void buildSelected()}
                disabled={busy || !selectedSymbols.length || !selectedCommonHorizons.length}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 disabled:opacity-50 cursor-pointer hover:bg-cyan-300 transition"
              >
                {building ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
                Build selected horizons
              </button>
              <button
                onClick={() => void buildAll()}
                disabled={busy || !selectedSymbols.length}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3 text-sm font-bold text-emerald-200 disabled:opacity-50 cursor-pointer hover:bg-emerald-400/15 transition"
              >
                <Sparkles className="h-4 w-4" />
                Build all supported horizons
              </button>
            </div>
          </article>

          <article className="rounded-3xl border border-white/10 bg-white/[0.025] p-5">
            <div className="mb-4 flex items-center gap-2 text-sm font-bold text-emerald-300">
              <Database className="h-4 w-4" />
              Dynamic runtime contract
            </div>
            <div className="space-y-4 text-sm">
              <div>
                <span className="block text-[10px] uppercase tracking-wider text-slate-500">Selected assets</span>
                <span className="mt-1 block text-slate-200">
                  {selectedAssets.map((asset) => formatReadableAsset(asset.symbol)).join(', ') || 'None'}
                </span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wider text-slate-500">Common horizons</span>
                <span className="mt-1 block text-slate-200">{commonHorizons.length}</span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wider text-slate-500">Selected horizons</span>
                <span className="mt-1 block text-slate-200">{selectedHorizons.length}</span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wider text-slate-500">Concurrency budget</span>
                <span className="mt-1 block text-slate-200">
                  {limits?.concurrency ?? 'Loading…'} active dataset workers
                </span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wider text-slate-500">Asset selection limit</span>
                <span className="mt-1 block text-slate-200">
                  {limits?.maxAssets == null ? 'Dynamic / no configured cap' : `${limits.maxAssets} assets`}
                </span>
              </div>
            </div>
          </article>
        </section>

        {/* Batch Job Progress */}
        {jobs.length > 0 && (
          <section className="mt-5 rounded-3xl border border-white/10 bg-white/[0.025] p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold">Dataset Build Batch</h2>
                <p className="mt-1 text-xs text-slate-500">Uses the configured runtime concurrency budget.</p>
              </div>
              {!jobIds.length && (
                <button
                  onClick={() => void archiveReports()}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold hover:bg-white/10 cursor-pointer"
                >
                  Archive reports
                </button>
              )}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${progress}%` }} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <div>
                Requested <b>{totals.requested}</b>
              </div>
              <div>
                Created <b>{totals.completed}</b>
              </div>
              <div>
                Skipped <b>{totals.skipped}</b>
              </div>
              <div>
                Failed <b>{totals.failed}</b>
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {jobs.map((job) => (
                <div key={job.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{formatReadableAsset(job.symbol)}</span>
                    <span className="text-[10px] uppercase text-slate-500">{job.status}</span>
                  </div>
                  <div className="mt-2 text-[11px] text-slate-500">
                    {job.completedCount} created · {job.skippedCount} skipped · {job.failedCount} failed
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Built Datasets Section with Multi-Select */}
        <section className="mt-5 rounded-3xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-bold flex items-center gap-2">
                <Database className="h-4 w-4 text-cyan-300" />
                Built datasets
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Persisted datasets across selected assets. Select multiple datasets to delete in batch.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Filter datasets..."
                  value={datasetSearch}
                  onChange={(e) => setDatasetSearch(e.target.value)}
                  className="rounded-xl border border-white/10 bg-black/30 pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-400/40"
                />
              </div>

              <select
                value={datasetUnitFilter}
                onChange={(e) => setDatasetUnitFilter(e.target.value)}
                className="rounded-xl border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-400/40"
              >
                <option value="ALL">All Units</option>
                <option value="t">Ticks (t)</option>
                <option value="s">Seconds (s)</option>
                <option value="m">Minutes (m)</option>
                <option value="h">Hours (h)</option>
                <option value="d">Days (d)</option>
              </select>

              <button
                onClick={selectAllFilteredDatasets}
                disabled={filteredDatasets.length === 0}
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/10 disabled:opacity-50 cursor-pointer"
              >
                {allFilteredSelected ? <CheckSquare className="h-3.5 w-3.5 text-cyan-400" /> : <Square className="h-3.5 w-3.5" />}
                {allFilteredSelected ? 'Deselect All' : `Select All (${filteredDatasets.length})`}
              </button>

              {selectedDatasetIds.length > 0 && (
                <button
                  onClick={clearSelectedDatasets}
                  className="rounded-xl border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-slate-400 hover:text-white cursor-pointer"
                >
                  Clear Selection
                </button>
              )}
            </div>
          </div>

          {datasets.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-slate-500">
              No datasets available for the selected assets.
            </div>
          ) : filteredDatasets.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">
              No datasets match the current filter criteria.
            </div>
          ) : (
            <div className="space-y-2">
              {filteredDatasets.map((dataset) => {
                const isSelected = selectedDatasetIds.includes(dataset.id);
                return (
                  <article
                    key={dataset.id}
                    className={`flex flex-col gap-3 rounded-2xl border p-4 transition sm:flex-row sm:items-center sm:justify-between ${
                      isSelected
                        ? 'border-cyan-400/40 bg-cyan-950/20'
                        : 'border-white/10 bg-black/20 hover:bg-black/30'
                    }`}
                  >
                    <div className="flex items-start sm:items-center gap-3 min-w-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleDatasetSelect(dataset.id)}
                        className="mt-1 sm:mt-0 h-4 w-4 shrink-0 accent-cyan-400 cursor-pointer rounded"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-bold text-slate-100">
                          {dataset.name ||
                            formatReadableDatasetName({
                              name: dataset.name,
                              assetSymbol: dataset.asset_symbol,
                              durationValue: dataset.duration_value,
                              durationUnit: dataset.duration_unit,
                            })}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          <span className="font-semibold text-slate-400">{dataset.asset_symbol}</span> ·{' '}
                          {dataset.duration_value ?? '—'}{' '}
                          {dataset.duration_unit ? unitLabel[dataset.duration_unit] : ''} ·{' '}
                          {dataset.sample_count.toLocaleString()} samples
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 shrink-0">
                      <span
                        className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${
                          dataset.status === 'completed'
                            ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
                            : 'border-amber-400/20 bg-amber-400/10 text-amber-200'
                        }`}
                      >
                        {dataset.status.toUpperCase()}
                      </span>
                      <button
                        onClick={() => void removeDataset(dataset)}
                        disabled={busy || Boolean(deletingId) || batchDeleting}
                        title="Delete single dataset"
                        className="rounded-lg border border-rose-400/20 p-2 text-rose-300 hover:bg-rose-400/10 disabled:opacity-40 cursor-pointer transition"
                      >
                        {deletingId === dataset.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* Floating Batch Action Bar */}
        {selectedDatasetIds.length > 0 && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-2xl border border-cyan-400/30 bg-[#0d131f]/95 px-5 py-3.5 shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-bottom-4 duration-200">
            <div className="flex items-center gap-2 text-xs font-semibold text-cyan-200">
              <CheckSquare className="h-4 w-4 text-cyan-400" />
              <span>
                <strong>{selectedDatasetIds.length}</strong> dataset
                {selectedDatasetIds.length > 1 ? 's' : ''} selected
              </span>
            </div>

            <div className="h-4 w-[1px] bg-white/20" />

            <button
              onClick={clearSelectedDatasets}
              disabled={batchDeleting}
              className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Clear
            </button>

            <button
              onClick={removeSelectedDatasets}
              disabled={batchDeleting}
              className="inline-flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/20 px-4 py-2 text-xs font-bold text-rose-200 hover:bg-rose-500/30 disabled:opacity-50 cursor-pointer transition shadow-lg"
            >
              {batchDeleting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Deleting {selectedDatasetIds.length}...
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete Selected ({selectedDatasetIds.length})
                </>
              )}
            </button>
          </div>
        )}
        </>
        )}
      </div>
    </main>
  );
}
