'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AssetBatchPresets } from './asset-batch-presets';
import {
  Layers,
  Sparkles,
  CheckCircle2,
  XCircle,
  Clock,
  ShieldCheck,
  RefreshCw,
  Loader2,
  BrainCircuit,
  Zap,
  Check,
  BarChart3,
  Award,
  Play,
  ArrowRight,
  SlidersHorizontal,
} from 'lucide-react';
import {
  type UnifiedMultiHorizonDatasetSummary,
  type UnifiedModelTrainingResult,
  type HorizonValidationMetric,
} from '@/lib/ml-unified-horizon-contract';
import { adminFetch } from '@/lib/admin-client-auth';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';

export function UnifiedMultiHorizonTrainingPanel({ initialDatasetId }: { initialDatasetId?: string }) {
  const [datasets, setDatasets] = useState<UnifiedMultiHorizonDatasetSummary[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>(initialDatasetId || '');
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<string[]>([]);
  const [trainingMode, setTrainingMode] = useState<'single' | 'batch'>('single');
  const [modelType, setModelType] = useState<'xgboost' | 'lightgbm' | 'catboost' | 'suite'>('suite');
  const [autoPromoteSuite, setAutoPromoteSuite] = useState(true);
  const [training, setTraining] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; currentSymbol: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UnifiedModelTrainingResult | null>(null);
  const [recentRuns, setRecentRuns] = useState<any[]>([]);
  const [availableAssets, setAvailableAssets] = useState<any[]>([]);

  async function loadState() {
    setLoading(true);
    setError(null);
    try {
      const [symRes, dsRes, runsRes] = await Promise.all([
        adminFetch('/api/symbols', { cache: 'no-store' }),
        adminFetch('/api/admin/datasets/unified-multi-horizon', { cache: 'no-store' }),
        adminFetch('/api/admin/model-training/unified-multi-horizon', { cache: 'no-store' }),
      ]);

      const symData = await symRes.json();
      if (symData?.success && Array.isArray(symData?.symbols)) {
        setAvailableAssets(symData.symbols.filter((s: any) => s.isAvailable));
      }
      const dsData = await dsRes.json();
      if (dsData?.success && Array.isArray(dsData?.datasets)) {
        setDatasets(dsData.datasets);
        if (!selectedDatasetId && dsData.datasets.length > 0) {
          setSelectedDatasetId(dsData.datasets[0].datasetId);
        }
        if (selectedDatasetIds.length === 0 && dsData.datasets.length > 0) {
          setSelectedDatasetIds(dsData.datasets.map((d: any) => d.datasetId));
        }
      }

      const runsData = await runsRes.json();
      if (runsData?.success && Array.isArray(runsData?.runs)) {
        setRecentRuns(runsData.runs);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load unified training state.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadState();
  }, []);

  const selectedDataset = datasets.find((d) => d.datasetId === selectedDatasetId);

  async function handleTrain() {
    if (training) return;
    setTraining(true);
    setError(null);
    setResult(null);

    const targetDatasetIds = trainingMode === 'single' ? [selectedDatasetId] : selectedDatasetIds;
    if (targetDatasetIds.length === 0) {
      setError('Please select at least one dataset to train.');
      setTraining(false);
      return;
    }

    let lastResult: UnifiedModelTrainingResult | null = null;
    const errors: string[] = [];

    for (let i = 0; i < targetDatasetIds.length; i++) {
      const dsId = targetDatasetIds[i];
      const ds = datasets.find((d) => d.datasetId === dsId);
      setBatchProgress({
        current: i + 1,
        total: targetDatasetIds.length,
        currentSymbol: ds?.symbol || dsId,
      });

      try {
        const res = await adminFetch('/api/admin/model-training/unified-multi-horizon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            datasetId: dsId,
            modelType,
            autoPromoteSuite,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || `Failed for ${ds?.symbol || dsId}`);
        }

        lastResult = data.result;
      } catch (err: any) {
        errors.push(`${ds?.symbol || dsId}: ${err?.message || 'Training failed'}`);
      }
    }

    setBatchProgress(null);
    setTraining(false);

    if (lastResult) {
      setResult(lastResult);
    }

    if (errors.length > 0) {
      setError(`Some models failed: ${errors.join('; ')}`);
    }

    await loadState();
  }

  return (
    <div className="space-y-6">
      {/* Banner & Architecture Overview */}
      <div className="rounded-3xl border border-cyan-500/20 bg-cyan-950/10 p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-cyan-400 font-bold text-sm">
              <Zap className="h-4 w-4" />
              Unified Single-Pass Multi-Horizon Conditioning & Duration-Aware Ensemble
            </div>
            <p className="mt-1 text-xs text-slate-400 max-w-3xl">
              Embeds duration vectors <code className="text-cyan-300 font-mono text-[11px]">τ = [H_ticks, H_seconds, Unit_encoding]</code> directly into tree-based gradient boosted models (XGBoost, CatBoost, LightGBM). A single promoted champion model dynamically evaluates any trade duration horizon (1t, 2t, 5t, 15s, 60s, etc.) with duration-aware tree branching.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/admin/champion-challenger"
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-400/20 transition cursor-pointer"
            >
              <Award className="h-3.5 w-3.5" />
              Governance & Promotion
            </Link>
            <button
              onClick={() => void loadState()}
              disabled={loading || training}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold hover:bg-white/10 transition cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Dynamic Architectural Conditioning Diagram */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-3 border-t border-cyan-500/10 text-xs">
          <div className="rounded-2xl border border-cyan-500/15 bg-black/40 p-3 space-y-1">
            <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider block">1. Microstructure Features</span>
            <p className="text-[11px] text-slate-400">Pure raw tick velocities, inter-arrival time deltas, direction streaks, micro-volatility, and tick accelerations without indicators.</p>
          </div>
          <div className="rounded-2xl border border-cyan-500/15 bg-black/40 p-3 space-y-1">
            <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider block">2. Horizon Vector Conditioning</span>
            <p className="text-[11px] text-slate-400">Joint training conditions tree split decisions on the contract horizon vector <code className="text-cyan-300 font-mono text-[10px]">τ</code>, enabling zero-latency multi-duration inference.</p>
          </div>
          <div className="rounded-2xl border border-cyan-500/15 bg-black/40 p-3 space-y-1">
            <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider block">3. Duration-Aware Ensemble</span>
            <p className="text-[11px] text-slate-400">Live trading resolves the active asset (e.g. 1HZ100V, R_100) and duration, weighting predictions by per-horizon validation accuracy.</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-400/20 bg-red-400/5 p-4 text-sm text-red-200">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Main Grid */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left Form: Dataset & Model Selector */}
        <div className="space-y-4 lg:col-span-5">
          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-5 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <BrainCircuit className="h-4 w-4 text-cyan-400" />
                Training Configuration
              </h3>
              <div className="flex rounded-lg border border-white/10 bg-black/40 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setTrainingMode('single')}
                  className={`px-2.5 py-1 rounded-md transition ${trainingMode === 'single' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Single
                </button>
                <button
                  type="button"
                  onClick={() => setTrainingMode('batch')}
                  className={`px-2.5 py-1 rounded-md transition ${trainingMode === 'batch' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Batch
                </button>
              </div>
            </div>

            {/* Dataset Selection */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                {trainingMode === 'single' ? 'Unified Multi-Horizon Dataset' : `Batch Datasets (${selectedDatasetIds.length} Selected)`}
              </label>
              {datasets.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-slate-400">
                  No unified datasets available yet. Build one in the Dataset Builder under the &quot;Unified Multi-Horizon Mode&quot; tab.
                </div>
              ) : trainingMode === 'single' ? (
                <select
                  value={selectedDatasetId}
                  onChange={(e) => setSelectedDatasetId(e.target.value)}
                  disabled={training}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm font-semibold text-slate-100 focus:border-cyan-400 focus:outline-none"
                >
                  {datasets.map((d) => (
                    <option key={d.datasetId} value={d.datasetId}>
                      {d.symbol} — {d.name} ({d.sampleCount} samples)
                    </option>
                  ))}
                </select>
              ) : (
                <div className="space-y-2 max-h-40 overflow-y-auto rounded-xl border border-white/10 bg-black/30 p-2.5">
                  <AssetBatchPresets
                    availableAssets={availableAssets}
                    onSelectSymbols={(symbols) => {
                      const ids = datasets
                        .filter(d => symbols.includes(d.symbol))
                        .map(d => d.datasetId);
                      setSelectedDatasetIds(prev => Array.from(new Set([...prev, ...ids])));
                    }}
                    onClear={() => setSelectedDatasetIds([])}
                    selectedCount={selectedDatasetIds.length}
                  />
                  {datasets.map((d) => {
                    const sel = selectedDatasetIds.includes(d.datasetId);
                    return (
                      <button
                        key={d.datasetId}
                        type="button"
                        onClick={() =>
                          setSelectedDatasetIds((prev) =>
                            prev.includes(d.datasetId) ? prev.filter((id) => id !== d.datasetId) : [...prev, d.datasetId]
                          )
                        }
                        disabled={training}
                        className={`w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition cursor-pointer ${
                          sel ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/40' : 'bg-white/5 text-slate-400 hover:bg-white/10 border border-transparent'
                        }`}
                      >
                        <span className="font-bold">{getSymbolDisplayName(d.symbol)} <span className="text-[10px] font-mono font-normal text-cyan-300/80">({d.symbol})</span> <span className="text-[10px] font-normal text-slate-400">({new Date(d.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})</span></span>
                        <span className="text-[10px] text-slate-400">{d.sampleCount.toLocaleString()} samples</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Selected Dataset Details */}
            {trainingMode === 'single' && selectedDataset && (
              <div className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-2.5 text-xs text-slate-300">
                <div className="flex items-center justify-between text-slate-400">
                  <span>Symbol:</span>
                  <span className="font-bold text-cyan-300">{getSymbolDisplayName(selectedDataset.symbol)} ({selectedDataset.symbol})</span>
                </div>
                <div className="flex items-center justify-between text-slate-400">
                  <span>Total Samples:</span>
                  <span>{selectedDataset.sampleCount.toLocaleString()} ({selectedDataset.trainCount} train / {selectedDataset.validationCount} val)</span>
                </div>
                <div>
                  <span className="text-slate-400 block mb-1">Embedded Horizons ({selectedDataset.horizons.length}):</span>
                  <div className="flex flex-wrap gap-1">
                    {selectedDataset.horizons.map((h) => (
                      <span
                        key={h.key}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          h.type === 'tick'
                            ? 'bg-cyan-500/20 text-cyan-300'
                            : 'bg-emerald-500/20 text-emerald-300'
                        }`}
                      >
                        {h.key.toUpperCase()}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Model Algorithm Selector */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Algorithm Selection
                </label>
                <span className="text-[10px] text-slate-400">
                  Tabular Conditioned Tree Suite
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { id: 'suite', label: 'Full Fleet', desc: 'XGB + LGB + CatBoost' },
                  { id: 'xgboost', label: 'XGBoost', desc: 'Fast Gradient Boosting' },
                  { id: 'catboost', label: 'CatBoost', desc: 'Symmetric Robustness' },
                  { id: 'lightgbm', label: 'LightGBM', desc: 'Leaf-Wise Histogram' },
                ].map((item) => {
                  const sel = modelType === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setModelType(item.id as any)}
                      disabled={training}
                      className={`flex flex-col items-center justify-center p-3 rounded-2xl border transition cursor-pointer ${
                        sel
                          ? 'border-cyan-400 bg-cyan-400/15 text-cyan-200 shadow-sm shadow-cyan-500/20'
                          : 'border-white/10 bg-black/20 text-slate-400 hover:border-white/20'
                      }`}
                    >
                      <span className="font-bold text-xs">{item.label}</span>
                      <span className="text-[9px] text-slate-500 text-center mt-1">{item.desc}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2.5 text-[11px] text-slate-400 leading-relaxed bg-white/[0.02] border border-white/5 p-2.5 rounded-xl">
                💡 <span className="font-semibold text-slate-300">Why 3 algorithms here?</span> Unified multi-horizon conditioning embeds duration vectors directly into tree-based gradient boosted models. To train all <span className="font-semibold text-cyan-300">8 platform models</span> (including TCN, LSTM, Transformer, HMM Regime, and Isolation Forest), use the{' '}
                <Link href="/admin/training-pipeline?tab=standard" className="text-cyan-400 font-semibold underline hover:text-cyan-300">
                  Standard Training Pipeline
                </Link>.
              </p>
            </div>

            {/* Guarantees */}
            <div className="rounded-xl border border-white/5 bg-black/30 p-3 space-y-1.5 text-xs text-slate-400">
              <div className="flex items-center gap-2 text-emerald-300 font-semibold">
                <ShieldCheck className="h-4 w-4" />
                Pure Tick Microstructure & Strict Governance
              </div>
              <p>
                Strictly uses pure tick dynamic properties. Single model trained once and benchmarked against all horizons out-of-sample.
              </p>
            </div>

            {/* Auto-Promote Suite Toggle */}
            <label className="flex items-center justify-between rounded-xl border border-cyan-500/20 bg-cyan-950/20 p-3 text-xs text-slate-300 cursor-pointer hover:bg-cyan-950/30 transition">
              <div className="flex items-center gap-2">
                <Award className="h-4 w-4 text-cyan-400 shrink-0" />
                <div>
                  <span className="font-bold text-slate-200">Auto-Promote Entire Suite</span>
                  <p className="text-[10px] text-slate-400">Promote all horizons to Production Champions automatically upon training validation</p>
                </div>
              </div>
              <input
                type="checkbox"
                checked={autoPromoteSuite}
                onChange={(e) => setAutoPromoteSuite(e.target.checked)}
                disabled={training}
                className="h-4 w-4 rounded border-slate-700 bg-black/50 text-cyan-400 focus:ring-cyan-400/50 accent-cyan-400 shrink-0"
              />
            </label>

            {/* Execute Button */}
            <button
              onClick={() => void handleTrain()}
              disabled={training || (trainingMode === 'single' ? !selectedDatasetId : !selectedDatasetIds.length)}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-50 transition cursor-pointer"
            >
              {training ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-slate-950" />}
              {training
                ? batchProgress
                  ? `Training ${batchProgress.currentSymbol} (${batchProgress.current}/${batchProgress.total})...`
                  : modelType === 'suite'
                  ? 'Training & Promoting Full Fleet (XGB+LGB+CatBoost)...'
                  : 'Training Model for All Horizons...'
                : trainingMode === 'single'
                ? modelType === 'suite'
                  ? '⚡ Train & Promote Full Fleet (XGB+LGB+CatBoost)'
                  : `Train Once for All Horizons (${modelType.toUpperCase()})`
                : modelType === 'suite'
                ? `⚡ Batch Train Full Fleet for ${selectedDatasetIds.length} Datasets`
                : `Batch Train ${selectedDatasetIds.length} Models (${modelType.toUpperCase()})`}
            </button>
          </div>
        </div>

        {/* Right Panel: Results & Horizon Validation Matrix */}
        <div className="space-y-4 lg:col-span-7">
          {result ? (
            <div className="rounded-3xl border border-emerald-500/30 bg-emerald-950/10 p-5 space-y-5 animate-in fade-in duration-300">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <div>
                  <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                    <CheckCircle2 className="h-5 w-5" />
                    Unified Multi-Horizon Training Complete
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Model <span className="font-mono text-cyan-300">{result.modelId}</span> trained in {result.fitMs}ms across {result.trainingSamples.toLocaleString()} samples.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    href="/admin/model-deployment"
                    className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-bold text-cyan-300 transition hover:bg-cyan-400/20"
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                    Activate in Hub
                  </Link>
                  <span className="rounded-full bg-emerald-400/20 border border-emerald-400/30 px-3 py-1 text-xs font-bold text-emerald-200">
                    {result.modelType.toUpperCase()}
                  </span>
                </div>
              </div>

              {/* Overall KPIs */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-2xl border border-white/10 bg-black/40 p-3.5 text-center">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block">
                    Overall Accuracy
                  </span>
                  <span className="text-xl font-black text-emerald-400 mt-1 block">
                    {result.overallAccuracy.toFixed(2)}%
                  </span>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/40 p-3.5 text-center">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block">
                    Overall F1 Score
                  </span>
                  <span className="text-xl font-black text-cyan-400 mt-1 block">
                    {result.overallF1.toFixed(4)}
                  </span>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/40 p-3.5 text-center">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block">
                    Log Loss
                  </span>
                  <span className="text-xl font-black text-slate-200 mt-1 block">
                    {result.overallLogLoss.toFixed(4)}
                  </span>
                </div>
              </div>

              {/* Multi-Horizon Validation Matrix */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-cyan-400" />
                  Multi-Horizon Validation Breakdown (1 Model across all Horizons)
                </h4>
                <div className="overflow-x-auto rounded-2xl border border-white/10 bg-black/30">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-white/10 bg-white/[0.02] text-slate-400 font-semibold">
                      <tr>
                        <th className="px-3.5 py-2.5">Horizon</th>
                        <th className="px-3.5 py-2.5">Type</th>
                        <th className="px-3.5 py-2.5 text-right">Val Samples</th>
                        <th className="px-3.5 py-2.5 text-right">Accuracy</th>
                        <th className="px-3.5 py-2.5 text-right">F1 Score</th>
                        <th className="px-3.5 py-2.5 text-right">Log Loss</th>
                        <th className="px-3.5 py-2.5 text-right">Win Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-slate-200">
                      {Object.values(result.horizonMetrics || {}).map((m) => (
                        <tr key={m.horizonKey} className="hover:bg-white/[0.02]">
                          <td className="px-3.5 py-2 font-mono font-bold text-cyan-300">
                            {m.horizonKey.toUpperCase()}
                          </td>
                          <td className="px-3.5 py-2">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                m.horizonType === 'tick'
                                  ? 'bg-cyan-500/20 text-cyan-300'
                                  : 'bg-emerald-500/20 text-emerald-300'
                              }`}
                            >
                              {m.horizonType.toUpperCase()}
                            </span>
                          </td>
                          <td className="px-3.5 py-2 text-right text-slate-400 font-mono">
                            {m.samples.toLocaleString()}
                          </td>
                          <td className="px-3.5 py-2 text-right font-mono font-bold text-emerald-400">
                            {m.accuracy.toFixed(2)}%
                          </td>
                          <td className="px-3.5 py-2 text-right font-mono text-cyan-300">
                            {m.f1.toFixed(4)}
                          </td>
                          <td className="px-3.5 py-2 text-right font-mono text-slate-400">
                            {m.logLoss.toFixed(4)}
                          </td>
                          <td className="px-3.5 py-2 text-right font-mono font-bold text-emerald-400">
                            {m.winRate.toFixed(2)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-5 space-y-4">
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <Award className="h-4 w-4 text-cyan-400" />
                Recent Unified Multi-Horizon Models ({recentRuns.length})
              </h3>

              {recentRuns.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-xs text-slate-500">
                  No unified models trained yet. Select a unified dataset on the left and click &quot;Train Once for All Horizons&quot;.
                </div>
              ) : (
                <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
                  {recentRuns.map((r) => (
                    <div
                      key={r.run_id}
                      className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-cyan-300">{getSymbolDisplayName(r.symbol)} ({r.symbol})</span>
                          <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-300 uppercase">
                            {r.model_type}
                          </span>
                          <span
                            className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                              r.status === 'completed'
                                ? 'bg-emerald-400/10 text-emerald-300 border border-emerald-400/20'
                                : 'bg-red-400/10 text-red-300'
                            }`}
                          >
                            {r.status.toUpperCase()}
                          </span>
                        </div>
                        {r.overall_accuracy != null && (
                          <span className="font-mono font-black text-emerald-400 text-sm">
                            {Number(r.overall_accuracy).toFixed(2)}% Acc
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span>Horizons: {Array.isArray(r.horizons) ? r.horizons.map((h: any) => h.key?.toUpperCase()).join(', ') : '—'}</span>
                        <span>{new Date(r.created_at).toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

