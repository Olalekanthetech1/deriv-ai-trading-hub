'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Layers,
  Sparkles,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  RefreshCw,
  Loader2,
  ArrowRight,
  Database,
  Trash2,
  CheckSquare,
  Square,
  AlertCircle,
  Info,
} from 'lucide-react';
import type { UnifiedMultiHorizonDatasetSummary } from '@/lib/ml-unified-horizon-contract';
import { formatReadableDuration } from '@/lib/ml-display-formatters';
import type { ActiveSymbolItem } from '@/app/api/symbols/route';
import { adminFetch } from '@/lib/admin-client-auth';
import { AssetBatchPresets } from './asset-batch-presets';

export type HorizonOption = { value: number; unit: string };

export function horizonKey(item: HorizonOption) {
  return `${item.value}:${item.unit}`;
}

export interface HorizonCapability {
  value: number;
  unit: string;
  key: string;
  supportedSymbols: string[];
  supportedCount: number;
  isUniversal: boolean;
}

export interface AssetCapabilityState {
  symbol: string;
  trainingHorizons: HorizonOption[];
  isSupported: boolean;
}

const UNIT_LABELS: Record<string, string> = {
  t: 'Tick-based horizons',
  s: 'Second-based horizons',
  m: 'Minute-based horizons',
  h: 'Hour-based horizons',
  d: 'Day-based horizons',
};

export function UnifiedMultiHorizonDatasetBuilder() {
  const [symbols, setSymbols] = useState<ActiveSymbolItem[]>([]);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [buildMode, setBuildMode] = useState<'single' | 'batch'>('single');
  const [horizonCapabilities, setHorizonCapabilities] = useState<HorizonCapability[]>([]);
  const [assetCapabilities, setAssetCapabilities] = useState<Record<string, AssetCapabilityState>>({});
  const [horizonViewFilter, setHorizonViewFilter] = useState<'all' | 'universal'>('all');
  const [horizons, setHorizons] = useState<HorizonOption[]>([]);
  const [datasets, setDatasets] = useState<UnifiedMultiHorizonDatasetSummary[]>([]);
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingHorizons, setLoadingHorizons] = useState(false);
  const [building, setBuilding] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; currentSymbol: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [symRes, dsRes] = await Promise.all([
        adminFetch('/api/symbols', { cache: 'no-store' }),
        adminFetch('/api/admin/datasets/unified-multi-horizon', { cache: 'no-store' }),
      ]);

      const symData = await symRes.json();
      if (!symRes.ok || !Array.isArray(symData?.symbols)) {
        throw new Error(symData?.error || 'Live Deriv assets are unavailable.');
      }
      const available = symData.symbols.filter((s: ActiveSymbolItem) => s.isAvailable);
      setSymbols(available);
      setSelectedSymbols((current) => {
        const valid = current.filter((symbol) => available.some((asset: ActiveSymbolItem) => asset.symbol === symbol));
        return valid.length ? valid : available[0] ? [available[0].symbol] : [];
      });

      const dsData = await dsRes.json();
      if (dsData?.success && Array.isArray(dsData?.datasets)) {
        setDatasets(dsData.datasets);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load unified dataset state.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSupportedHorizons() {
      if (!selectedSymbols.length) {
        setHorizonCapabilities([]);
        setAssetCapabilities({});
        setHorizons([]);
        setLoadingHorizons(false);
        return;
      }

      setLoadingHorizons(true);
      try {
        const response = await adminFetch(
          `/api/admin/dataset-batches?symbols=${encodeURIComponent(selectedSymbols.join(','))}`,
          { cache: 'no-store' }
        );
        const data = await response.json();
        if (!response.ok || !data?.success || !Array.isArray(data?.assets)) {
          throw new Error(data?.error || 'Unable to load broker-supported horizons.');
        }

        const rawAssets = data.assets as Array<{ symbol: string; trainingHorizons?: HorizonOption[] }>;
        const capMap: Record<string, AssetCapabilityState> = {};
        for (const item of rawAssets) {
          const th = Array.isArray(item.trainingHorizons) ? item.trainingHorizons : [];
          capMap[item.symbol] = {
            symbol: item.symbol,
            trainingHorizons: th,
            isSupported: th.length > 0,
          };
        }

        const horizonMap = new Map<string, { value: number; unit: string; supportedSymbols: string[] }>();
        for (const item of rawAssets) {
          const th = Array.isArray(item.trainingHorizons) ? item.trainingHorizons : [];
          for (const h of th) {
            const k = horizonKey(h);
            if (!horizonMap.has(k)) {
              horizonMap.set(k, { value: Number(h.value), unit: String(h.unit), supportedSymbols: [item.symbol] });
            } else {
              const existing = horizonMap.get(k)!;
              if (!existing.supportedSymbols.includes(item.symbol)) {
                existing.supportedSymbols.push(item.symbol);
              }
            }
          }
        }

        const allHorizons: HorizonCapability[] = [...horizonMap.entries()].map(([k, v]) => ({
          key: k,
          value: v.value,
          unit: v.unit,
          supportedSymbols: v.supportedSymbols,
          supportedCount: v.supportedSymbols.length,
          isUniversal: v.supportedSymbols.length === selectedSymbols.length,
        }));

        allHorizons.sort((a, b) => a.unit.localeCompare(b.unit) || a.value - b.value);

        if (cancelled) return;
        setAssetCapabilities(capMap);
        setHorizonCapabilities(allHorizons);

        // Keep valid selected horizons or default to all available
        setHorizons((current) => {
          const valid = current.filter((item) => allHorizons.some((candidate) => candidate.key === horizonKey(item)));
          if (valid.length > 0) return valid;
          // By default, select all universally supported horizons, or all available if no universal ones exist
          const universal = allHorizons.filter((h) => h.isUniversal).map((h) => ({ value: h.value, unit: h.unit }));
          return universal.length > 0 ? universal : allHorizons.map((h) => ({ value: h.value, unit: h.unit }));
        });
      } catch (err: any) {
        if (!cancelled) {
          setHorizonCapabilities([]);
          setAssetCapabilities({});
          setHorizons([]);
          setError(err?.message || 'Unable to load broker-supported horizons.');
        }
      } finally {
        if (!cancelled) setLoadingHorizons(false);
      }
    }

    void loadSupportedHorizons();
    return () => {
      cancelled = true;
    };
  }, [selectedSymbols]);

  const unsupportedAssets = useMemo(
    () => selectedSymbols.filter((sym) => assetCapabilities[sym] && !assetCapabilities[sym].isSupported),
    [selectedSymbols, assetCapabilities]
  );

  const eligibleAssets = useMemo(
    () => selectedSymbols.filter((sym) => assetCapabilities[sym]?.isSupported),
    [selectedSymbols, assetCapabilities]
  );

  const commonHorizons = useMemo(
    () => horizonCapabilities.filter((h) => h.isUniversal),
    [horizonCapabilities]
  );

  const displayedHorizons = useMemo(() => {
    if (horizonViewFilter === 'universal' && commonHorizons.length > 0) {
      return commonHorizons;
    }
    return horizonCapabilities;
  }, [horizonViewFilter, commonHorizons, horizonCapabilities]);

  const horizonGroups = useMemo(() => {
    const units = [...new Set(displayedHorizons.map((item) => item.unit))];
    return units.map((unit) => ({
      unit,
      label: UNIT_LABELS[unit] || `Supported ${unit} horizons`,
      options: displayedHorizons.filter((item) => item.unit === unit),
    }));
  }, [displayedHorizons]);

  function toggleHorizon(item: HorizonOption) {
    setHorizons((current) => {
      const exists = current.some((h) => horizonKey(h) === horizonKey(item));
      if (exists) {
        if (current.length <= 1) return current;
        return current.filter((h) => horizonKey(h) !== horizonKey(item));
      }
      return [...current, item];
    });
  }

  function isHorizonSelected(item: HorizonOption) {
    return horizons.some((h) => horizonKey(h) === horizonKey(item));
  }

  function selectAllVisibleHorizons() {
    setHorizons(displayedHorizons.map((h) => ({ value: h.value, unit: h.unit })));
  }

  function toggleSymbol(symbol: string) {
    if (buildMode === 'single') {
      setSelectedSymbols([symbol]);
      return;
    }
    setSelectedSymbols((prev) =>
      prev.includes(symbol) ? (prev.length > 1 ? prev.filter((s) => s !== symbol) : prev) : [...prev, symbol]
    );
  }

  async function handleBuild() {
    if (building || !selectedSymbols.length || !horizons.length) return;
    setBuilding(true);
    setError(null);
    setSuccess(null);

    const targetSymbols = buildMode === 'single' ? [selectedSymbols[0]] : selectedSymbols;
    let completed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (let i = 0; i < targetSymbols.length; i++) {
      const sym = targetSymbols[i];
      setBatchProgress({ current: i + 1, total: targetSymbols.length, currentSymbol: sym });

      const assetState = assetCapabilities[sym];
      const assetHorizons = assetState?.trainingHorizons ?? [];
      const assetHorizonKeys = new Set(assetHorizons.map(horizonKey));

      // Resolve valid broker-supported subset for this asset
      const validForSym = horizons.filter((h) => assetHorizonKeys.has(horizonKey(h)));

      if (!validForSym.length) {
        skipped++;
        errors.push(`${sym}: Skipped — asset does not support the selected prediction horizons under Deriv live capabilities.`);
        continue;
      }

      try {
        const res = await adminFetch('/api/admin/datasets/unified-multi-horizon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: sym, horizons: validForSym }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || `Failed for ${sym}`);
        completed++;
      } catch (err: any) {
        errors.push(`${sym}: ${err?.message || 'Build failed'}`);
      }
    }

    setBatchProgress(null);
    setBuilding(false);

    if (errors.length === 0) {
      setSuccess(`Successfully generated unified multi-horizon datasets for ${completed} asset(s) across selected broker horizons.`);
    } else if (completed > 0) {
      setSuccess(`Completed ${completed} of ${targetSymbols.length} datasets. (${errors.length} failed/skipped)`);
      setError(errors.join('; '));
    } else {
      setError(`Failed to build datasets: ${errors.join('; ')}`);
    }

    await loadData();
  }

  async function handleDeleteSelected() {
    if (!selectedDatasetIds.length || deleting) return;
    if (!confirm(`Permanently delete ${selectedDatasetIds.length} unified dataset(s)?`)) return;

    setDeleting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await adminFetch('/api/admin/datasets/unified-multi-horizon', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetIds: selectedDatasetIds }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete datasets');
      setSuccess(`Deleted ${data.deletedCount} unified dataset(s).`);
      setSelectedDatasetIds([]);
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-cyan-500/20 bg-cyan-950/10 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-cyan-400 font-bold text-sm">
              <Layers className="h-4 w-4" />
              Unified Multi-Horizon Engine (Tick & Seconds Joint Training)
            </div>
            <p className="mt-1 text-xs text-slate-400 max-w-3xl">
              Uses the live server asset catalogue and broker-discovered supported horizons. Dynamic capability aggregation with per-asset broker revalidation.
            </p>
          </div>
          <button
            onClick={() => void loadData()}
            disabled={loading || building}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold hover:bg-white/10 transition cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-400/20 bg-red-400/5 p-4 text-sm text-red-200">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-3 rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-sm text-emerald-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-6">
          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-5 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-cyan-400" />
                Build Unified Multi-Horizon Dataset
              </h3>
              <div className="flex rounded-lg border border-white/10 bg-black/40 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => {
                    setBuildMode('single');
                    if (selectedSymbols.length > 1) setSelectedSymbols([selectedSymbols[0]]);
                  }}
                  className={`px-2.5 py-1 rounded-md transition ${buildMode === 'single' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Single Asset
                </button>
                <button
                  type="button"
                  onClick={() => setBuildMode('batch')}
                  className={`px-2.5 py-1 rounded-md transition ${buildMode === 'batch' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Batch Multi-Asset
                </button>
              </div>
            </div>

            {buildMode === 'batch' && (
              <AssetBatchPresets
                availableAssets={symbols}
                onSelectSymbols={setSelectedSymbols}
                onClear={() => setSelectedSymbols([])}
                selectedCount={selectedSymbols.length}
              />
            )}

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {buildMode === 'single' ? 'Target Market Asset' : `Selected Assets (${selectedSymbols.length})`}
                </label>
                <span className="text-[11px] text-slate-500">{symbols.length} available</span>
              </div>
              {buildMode === 'single' ? (
                <select
                  value={selectedSymbols[0] || ''}
                  onChange={(e) => setSelectedSymbols(e.target.value ? [e.target.value] : [])}
                  disabled={building || !symbols.length}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm font-semibold text-slate-100 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                >
                  {!symbols.length && <option value="">No live assets available</option>}
                  {symbols.map((s) => (
                    <option key={s.symbol} value={s.symbol}>
                      {s.displayName} ({s.symbol})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-56 overflow-y-auto rounded-xl border border-white/10 bg-black/30 p-2.5">
                  {symbols.length ? symbols.map((s) => {
                    const sel = selectedSymbols.includes(s.symbol);
                    const assetState = assetCapabilities[s.symbol];
                    const isUnsupported = assetState && !assetState.isSupported;
                    return (
                      <button
                        key={s.symbol}
                        type="button"
                        onClick={() => toggleSymbol(s.symbol)}
                        disabled={building}
                        title={`${s.displayName} (${s.symbol})${isUnsupported ? ' - No high-frequency Rise/Fall horizons' : ''}`}
                        className={`flex items-center justify-between gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs font-semibold transition cursor-pointer ${
                          sel ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/40' : 'bg-white/5 text-slate-400 hover:bg-white/10 border border-transparent'
                        }`}
                      >
                        <span className="min-w-0 truncate">{s.displayName || s.symbol}</span>
                        {isUnsupported && sel && (
                          <span className="shrink-0 rounded bg-amber-500/20 px-1 py-0.2 text-[9px] font-bold text-amber-300">0h</span>
                        )}
                      </button>
                    );
                  }) : (
                    <span className="col-span-full py-5 text-center text-xs text-slate-500">No live Deriv assets are available.</span>
                  )}
                </div>
              )}
            </div>

            {/* Unsupported Asset Warning Notice */}
            {buildMode === 'batch' && unsupportedAssets.length > 0 && (
              <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-950/20 p-3 text-xs text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <div>
                  <div className="font-bold">
                    {unsupportedAssets.length} asset{unsupportedAssets.length === 1 ? '' : 's'} without Rise/Fall high-frequency horizons
                  </div>
                  <p className="mt-0.5 text-[11px] text-amber-200/80">
                    Deriv does not offer tick/second Rise/Fall contracts for: {unsupportedAssets.join(', ')}. These instruments will be skipped during training dataset generation.
                  </p>
                </div>
              </div>
            )}

            {/* Broker-Supported Horizons Container */}
            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-cyan-300">
                    Broker-Supported Horizons
                  </label>
                  <span className="ml-2 text-[11px] text-slate-500">
                    {horizonCapabilities.length} available {buildMode === 'batch' && `(${commonHorizons.length} universal)`}
                  </span>
                </div>
                {buildMode === 'batch' && horizonCapabilities.length > 0 && commonHorizons.length > 0 && commonHorizons.length < horizonCapabilities.length && (
                  <div className="flex rounded-lg border border-white/10 bg-black/40 p-0.5 text-[11px] font-medium">
                    <button
                      type="button"
                      onClick={() => setHorizonViewFilter('all')}
                      className={`px-2 py-0.5 rounded transition ${horizonViewFilter === 'all' ? 'bg-cyan-500/20 text-cyan-200 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                      All Available ({horizonCapabilities.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setHorizonViewFilter('universal')}
                      className={`px-2 py-0.5 rounded transition ${horizonViewFilter === 'universal' ? 'bg-cyan-500/20 text-cyan-200 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                      Universal Only ({commonHorizons.length})
                    </button>
                  </div>
                )}
              </div>

              {loadingHorizons ? (
                <div className="flex items-center gap-2.5 rounded-xl border border-cyan-500/20 bg-cyan-950/20 p-4 text-xs text-cyan-300">
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                  <span>Discovering live Deriv broker-supported horizons for {selectedSymbols.length} asset(s)...</span>
                </div>
              ) : selectedSymbols.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/10 bg-black/20 p-4 text-xs text-slate-500">
                  Select one or more live Deriv assets to load broker-supported training horizons.
                </div>
              ) : horizonCapabilities.length === 0 ? (
                <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 text-xs text-amber-300 space-y-1">
                  <div className="font-bold flex items-center gap-1.5">
                    <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
                    No High-Frequency Rise/Fall Horizons Found
                  </div>
                  <p className="text-slate-400">
                    None of the selected {selectedSymbols.length} assets ({selectedSymbols.join(', ')}) support sub-daily Rise/Fall durations on Deriv.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">
                      {horizons.length} horizon{horizons.length === 1 ? '' : 's'} selected for joint training
                    </span>
                    <button
                      type="button"
                      onClick={selectAllVisibleHorizons}
                      className="text-[11px] font-semibold text-cyan-400 hover:text-cyan-300 transition cursor-pointer"
                    >
                      Select All Visible
                    </button>
                  </div>

                  {horizonGroups.map((group) => (
                    <div key={group.unit} className="mb-3 last:mb-0">
                      <div className="mb-2 text-[11px] font-semibold text-slate-500">{group.label}</div>
                      <div className="flex flex-wrap gap-2">
                        {group.options.map((opt) => {
                          const sel = isHorizonSelected(opt);
                          return (
                            <button
                              key={opt.key}
                              type="button"
                              onClick={() => toggleHorizon(opt)}
                              disabled={building}
                              className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
                                sel
                                  ? 'border-cyan-400 bg-cyan-400/15 text-cyan-200'
                                  : 'border-white/10 bg-black/20 text-slate-400 hover:border-white/20'
                              }`}
                            >
                              <span>{formatReadableDuration(opt.value, opt.unit as any)}</span>
                              {buildMode === 'batch' && !opt.isUniversal && (
                                <span className="rounded-full bg-cyan-500/20 px-1.5 py-0.2 text-[9px] font-bold text-cyan-300" title={`Supported by ${opt.supportedCount} of ${selectedSymbols.length} selected assets`}>
                                  {opt.supportedCount}/{selectedSymbols.length}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-white/5 bg-black/30 p-3 space-y-2 text-xs text-slate-400">
              <div className="flex items-center gap-2 text-emerald-300 font-semibold">
                <ShieldCheck className="h-4 w-4" />
                Pure Tick Microstructure & Leakage-Free Guarantee
              </div>
              <p>
                Extracts raw price tick changes, tick arrival rates, velocities, accelerations, and digit frequencies. No technical indicators. 70/15/15 chronological split with protective dead-zone gap.
              </p>
            </div>

            <button
              onClick={() => void handleBuild()}
              disabled={building || !selectedSymbols.length || !horizons.length || eligibleAssets.length === 0}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-50 transition cursor-pointer"
            >
              {building ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
              {building
                ? batchProgress
                  ? `Building ${batchProgress.currentSymbol} (${batchProgress.current}/${batchProgress.total})...`
                  : 'Constructing Multi-Horizon Dataset...'
                : buildMode === 'single'
                ? `Build Dataset for ${selectedSymbols[0] || 'Asset'} (${horizons.length} Horizons)`
                : `Batch Build ${eligibleAssets.length} Datasets (${horizons.length} Selected Horizons)`}
            </button>
          </div>
        </div>

        <div className="space-y-4 lg:col-span-6">
          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2 shrink-0">
                <Database className="h-4 w-4 text-emerald-400" />
                Unified Multi-Horizon Datasets ({datasets.length})
              </h3>
              <div className="flex items-center gap-2">
                {datasets.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedDatasetIds.length === datasets.length) setSelectedDatasetIds([]);
                      else setSelectedDatasetIds(datasets.map((d) => d.datasetId));
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-bold text-slate-300 hover:bg-white/10 transition cursor-pointer"
                  >
                    {selectedDatasetIds.length === datasets.length ? (
                      <><CheckSquare className="h-3.5 w-3.5 text-cyan-400" /> Deselect All</>
                    ) : (
                      <><Square className="h-3.5 w-3.5" /> Select All</>
                    )}
                  </button>
                )}
                {selectedDatasetIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleDeleteSelected()}
                    disabled={deleting}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-bold text-red-300 hover:bg-red-500/20 transition cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete ({selectedDatasetIds.length})
                  </button>
                )}
              </div>
            </div>

            {datasets.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-xs text-slate-500">
                No unified multi-horizon datasets built yet. Select an asset and click &quot;Build Dataset&quot; to generate your first unified multi-horizon dataset.
              </div>
            ) : (
              <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
                {datasets.map((ds) => {
                  const isSelected = selectedDatasetIds.includes(ds.datasetId);
                  return (
                    <div key={ds.datasetId} className={`rounded-2xl border transition p-4 space-y-3 ${isSelected ? 'border-cyan-400/50 bg-cyan-950/20' : 'border-white/10 bg-black/30'}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2.5">
                          <button
                            type="button"
                            onClick={() => setSelectedDatasetIds((prev) => prev.includes(ds.datasetId) ? prev.filter((id) => id !== ds.datasetId) : [...prev, ds.datasetId])}
                            className="mt-0.5 text-slate-400 hover:text-cyan-300 transition"
                          >
                            {isSelected ? <CheckSquare className="h-4 w-4 text-cyan-400" /> : <Square className="h-4 w-4" />}
                          </button>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-sm text-cyan-300">{ds.symbol}</span>
                              <span className="rounded-md bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-300">
                                {ds.sampleCount.toLocaleString()} samples
                              </span>
                              <span className="rounded-md bg-emerald-400/10 text-emerald-300 border border-emerald-400/20 px-2 py-0.5 text-[10px] font-semibold">
                                Leakage Safe
                              </span>
                            </div>
                            <p className="text-xs text-slate-400 mt-1">{ds.name}</p>
                          </div>
                        </div>
                        <Link
                          href={`/admin/training-pipeline?tab=unified&datasetId=${encodeURIComponent(ds.datasetId)}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-bold text-cyan-300 hover:bg-cyan-400/20 transition cursor-pointer"
                        >
                          Train
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </div>

                      <div>
                        <span className="text-[10px] uppercase font-semibold tracking-wider text-slate-500 block mb-1.5">
                          Embedded Horizons ({ds.horizons.length}):
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {ds.horizons.map((h) => (
                            <span
                              key={h.key}
                              className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${
                                h.type === 'tick'
                                  ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/20'
                                  : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/20'
                              }`}
                            >
                              {h.key.toUpperCase()}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-white/5">
                        <span>Train: {ds.trainCount} | Val: {ds.validationCount} | Test: {ds.testCount}</span>
                        <span>{new Date(ds.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
