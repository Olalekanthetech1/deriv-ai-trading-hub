'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Crown,
  RefreshCw,
  ShieldAlert,
  Trophy,
  Scale,
  Activity,
  AlertTriangle,
  TrendingUp,
  X,
  Zap,
  Layers,
  Boxes,
  Award,
  Sparkles,
  LayoutGrid,
} from 'lucide-react';
import type { ShadowBenchmarkMatrixResult } from '@/lib/champion-challenger-benchmark';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';
import { EligiblePromotionsTab } from '@/components/admin/eligible-promotions-tab';
import type { EligibleCandidateModel } from '@/app/api/admin/champion-challenger/eligible/route';

type Model = {
  model_id?: string;
  symbol?: string;
  horizon_secs?: number;
  status?: string;
  model_name?: string;
  raw_model_family?: string;
  trained_at?: string;
  metrics?: Record<string, unknown> | null;
};

function metric(model: Model, key: string): number | null {
  const value = model.metrics?.[key];
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(value: number | null) { return value == null ? '—' : `${value.toFixed(2)}%`; }

export default function ChampionChallengerPage() {
  const [activeTab, setActiveTab] = useState<'suites' | 'eligible'>('suites');
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Eligible Tab State
  const [eligibleModels, setEligibleModels] = useState<EligibleCandidateModel[]>([]);
  const [ineligibleModels, setIneligibleModels] = useState<Array<EligibleCandidateModel & { rejectionReason: string }>>([]);
  const [loadingEligible, setLoadingEligible] = useState(false);

  // Benchmark Matrix State
  const [benchmarkingModelId, setBenchmarkingModelId] = useState<string | null>(null);
  const [benchmarkResult, setBenchmarkResult] = useState<ShadowBenchmarkMatrixResult | null>(null);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);

  const loadEligible = useCallback(async () => {
    setLoadingEligible(true);
    try {
      const res = await fetch('/api/admin/champion-challenger/eligible', { cache: 'no-store' });
      if (res.status === 401) { window.location.replace('/admin'); return; }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setEligibleModels(Array.isArray(data.eligible) ? data.eligible : []);
        setIneligibleModels(Array.isArray(data.ineligible) ? data.ineligible : []);
      }
    } catch {
      // safe fallback
    } finally {
      setLoadingEligible(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch('/api/ml/registry', { cache: 'no-store' });
      if (response.status === 401) { window.location.replace('/admin'); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Registry returned HTTP ${response.status}.`);
      setModels(Array.isArray(body.models) ? body.models : []);
      void loadEligible();
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load model registry.'); }
    finally { setLoading(false); }
  }, [loadEligible]);

  useEffect(() => { void load(); }, [load]);

  const activeModels = useMemo(() => {
    return models.filter(m => String(m.status || '').toLowerCase() !== 'retired');
  }, [models]);

  const { unifiedSuites, singleGroups } = useMemo(() => {
    const suitesMap = new Map<string, {
      suiteKey: string;
      symbol: string;
      framework: string;
      trainingRunId: string | null;
      overallAccuracy: number | null;
      overallF1: number | null;
      models: Model[];
      championsCount: number;
      candidateModelIds: string[];
    }>();

    const legacyMap = new Map<string, Model[]>();

    for (const model of activeModels) {
      const isUnified =
        String((model as any).strategy_key || '').toLowerCase() === 'unified_multi_horizon' ||
        Boolean((model.metrics as any)?.trainedOnceForMultiHorizon) ||
        String(model.model_id || '').toLowerCase().includes('_unified_multi_horizon_');

      if (isUnified) {
        const trId = String((model as any).training_run_id || '').trim();
        const baseId = String(model.model_id || '').replace(/_[0-9]+[ts]$/i, '');
        const suiteKey = trId ? `run:${trId}` : `base:${model.symbol || 'ASSET'}:${baseId}`;

        let suite = suitesMap.get(suiteKey);
        if (!suite) {
          const mAny = model.metrics as any;
          suite = {
            suiteKey,
            symbol: model.symbol || 'UNKNOWN',
            framework: model.raw_model_family || model.model_name || 'XGBoost',
            trainingRunId: trId || null,
            overallAccuracy: Number.isFinite(Number(mAny?.overallAccuracy)) ? Number(mAny.overallAccuracy) : null,
            overallF1: Number.isFinite(Number(mAny?.overallF1)) ? Number(mAny.overallF1) : null,
            models: [],
            championsCount: 0,
            candidateModelIds: [],
          };
          suitesMap.set(suiteKey, suite);
        }
        suite.models.push(model);
        if (model.status === 'production') suite.championsCount++;
        if (['candidate', 'staging'].includes(String(model.status).toLowerCase()) && model.model_id) {
          suite.candidateModelIds.push(model.model_id);
        }
      } else {
        const key = `${model.symbol || 'UNKNOWN'} · ${model.horizon_secs || '—'}s`;
        const list = legacyMap.get(key) || [];
        list.push(model);
        legacyMap.set(key, list);
      }
    }

    for (const suite of suitesMap.values()) {
      suite.models.sort((a, b) => (a.horizon_secs || 0) - (b.horizon_secs || 0));
    }

    return {
      unifiedSuites: Array.from(suitesMap.values()),
      singleGroups: Array.from(legacyMap.entries()),
    };
  }, [activeModels]);

  const runBenchmark = async (challenger: Model) => {
    if (!challenger.model_id || !challenger.symbol || !challenger.horizon_secs) return;
    setBenchmarkingModelId(challenger.model_id);
    setBenchmarkError(null);
    setBenchmarkResult(null);

    try {
      const res = await fetch('/api/admin/champion-challenger/benchmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengerModelId: challenger.model_id,
          symbol: challenger.symbol,
          horizonSecs: challenger.horizon_secs,
          minConfidence: 55,
          stake: 10,
          payoutRate: 0.95,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Shadow benchmark evaluation failed.');
      }
      setBenchmarkResult(data);
    } catch (err) {
      setBenchmarkError(err instanceof Error ? err.message : 'Benchmark evaluation error.');
    } finally {
      setBenchmarkingModelId(null);
    }
  };

  const promote = async (model: Model) => {
    if (!model.model_id || !model.symbol || !model.horizon_secs) return;
    const assetDisplayName = getSymbolDisplayName(model.symbol);
    if (!window.confirm(`Promote model for ${assetDisplayName} (${model.symbol}) [Horizon ${model.horizon_secs}s] to Production Champion?`)) return;
    setBusy(model.model_id); setMessage(null); setError(null);
    try {
      const response = await fetch('/api/ml/registry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'promote', modelId: model.model_id, symbol: model.symbol, horizonSecs: model.horizon_secs }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) throw new Error(body.error || `Promotion returned HTTP ${response.status}.`);
      setMessage(body.message || `Model for ${assetDisplayName} (${model.symbol}) promoted successfully to Production Champion.`);
      setBenchmarkResult(null);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Promotion failed.'); }
    finally { setBusy(null); }
  };

  const promoteSuite = async (suiteKey: string, modelIds: string[]) => {
    if (!modelIds.length) {
      setMessage('All horizons in this suite are already active Production Champions or retired.');
      return;
    }
    if (!window.confirm(`Promote all ${modelIds.length} candidate horizons in this Unified Multi-Horizon Suite to Production Champions in 1 single action?`)) return;
    setBusy(suiteKey); setMessage(null); setError(null);
    try {
      const response = await fetch('/api/ml/registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'promote_suite',
          modelIds,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) throw new Error(body.error || `Suite promotion returned HTTP ${response.status}.`);
      setMessage(body.message || `Successfully promoted ${body.promotedCount || modelIds.length} horizons to Production Champions.`);
      setBenchmarkResult(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Suite promotion failed.');
    } finally {
      setBusy(null);
    }
  };

  const handlePromoteBatchFromTab = async (modelIds: string[]) => {
    if (!modelIds.length) return;
    if (!window.confirm(`Promote all ${modelIds.length} selected eligible candidate models to Production Champions in 1 atomic action?`)) return;
    setBusy('BATCH_PROMOTION'); setMessage(null); setError(null);
    try {
      const res = await fetch('/api/admin/champion-challenger/eligible', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Batch promotion failed.');
      }
      setMessage(data.message || `Successfully promoted ${data.promotedCount} eligible models to Production Champions.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch promotion failed.');
    } finally {
      setBusy(null);
    }
  };

  const handlePromoteSingleFromTab = async (candidate: EligibleCandidateModel) => {
    await promote({
      model_id: candidate.modelId,
      symbol: candidate.symbol,
      horizon_secs: candidate.horizonSecs,
    });
  };

  return (
    <main className="min-h-screen bg-[#05070b] text-slate-100">
      <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3">
              <Trophy className="h-6 w-6 text-amber-300" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">Model Operations · Governance</p>
              <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Champion / Challenger</h1>
              <p className="mt-1 text-xs text-slate-500">
                Automated shadow backtesting benchmark matrix &amp; persisted governance before triggering champion retirement.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/tradeability" className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-400/20 transition">
              <Sparkles className="h-4 w-4 text-emerald-400" />Tradeability Matrix
            </Link>
            <Link href="/admin/models" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition">
              <ArrowLeft className="h-4 w-4" />Model Operations
            </Link>
            <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10 transition">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh
            </button>
          </div>
        </header>

        {error && <div className="mb-4 rounded-2xl border border-rose-400/20 bg-rose-400/5 p-4 text-sm text-rose-200">{error}</div>}
        {message && <div className="mb-4 rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-sm text-emerald-200">{message}</div>}

        {/* Global Summary KPIs */}
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
            <p className="text-xs text-slate-500">Active Governance Models</p>
            <p className="mt-1 text-2xl font-black">{activeModels.length}</p>
          </div>
          <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.03] p-4">
            <p className="text-xs text-slate-500">Production Champions</p>
            <p className="mt-1 text-2xl font-black text-emerald-200">{models.filter(m => m.status === 'production').length}</p>
          </div>
          <div className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.03] p-4">
            <p className="text-xs text-slate-500">Active Challengers / Staging</p>
            <p className="mt-1 text-2xl font-black text-amber-200">{models.filter(m => ['candidate','staging'].includes(String(m.status).toLowerCase())).length}</p>
          </div>
          <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.04] p-4">
            <p className="text-xs text-slate-500 flex items-center justify-between">
              <span>Ready to Promote</span>
              <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
            </p>
            <p className="mt-1 text-2xl font-black text-cyan-300">{eligibleModels.length}</p>
          </div>
        </div>

        {/* Tab Navigation Navigation Controls */}
        <div className="mb-6 flex items-center gap-2 border-b border-white/10 pb-3">
          <button
            onClick={() => setActiveTab('suites')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition cursor-pointer ${
              activeTab === 'suites'
                ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/20'
                : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10'
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
            Suites &amp; Single Models View
          </button>

          <button
            onClick={() => setActiveTab('eligible')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition cursor-pointer ${
              activeTab === 'eligible'
                ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10'
            }`}
          >
            <Sparkles className="h-4 w-4 text-emerald-300" />
            Eligible to Promote (Batch)
            {eligibleModels.length > 0 && (
              <span className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-black ${
                activeTab === 'eligible' ? 'bg-slate-950 text-emerald-300' : 'bg-emerald-500/20 text-emerald-300'
              }`}>
                {eligibleModels.length}
              </span>
            )}
          </button>
        </div>

        {/* Tab 2: Eligible to Promote Batch View */}
        {activeTab === 'eligible' && (
          <EligiblePromotionsTab
            eligibleModels={eligibleModels}
            ineligibleModels={ineligibleModels}
            loading={loadingEligible}
            onRefresh={loadEligible}
            onPromoteBatch={handlePromoteBatchFromTab}
            onPromoteSingle={handlePromoteSingleFromTab}
            busy={busy}
          />
        )}

        {/* Tab 1: Suites & Single Models View */}
        {activeTab === 'suites' && (
          <>
            {/* Shadow Benchmark Matrix Drawer Modal */}
            {benchmarkResult && (
              <section className="mb-6 rounded-2xl border border-cyan-400/30 bg-cyan-950/20 p-5 shadow-xl shadow-cyan-950/20 relative">
                <button
                  onClick={() => setBenchmarkResult(null)}
                  className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/5"
                >
                  <X className="h-5 w-5" />
                </button>

                <div className="flex items-center gap-2 mb-3">
                  <Scale className="h-5 w-5 text-cyan-300" />
                  <h2 className="text-base font-bold text-slate-100">
                    Automated Challenger Benchmark Matrix — {benchmarkResult.symbol} ({benchmarkResult.horizonSecs}s Horizon)
                  </h2>
                </div>
                <p className="text-xs text-slate-400 mb-4">
                  Side-by-side automated shadow backtesting comparison on {benchmarkResult.sampleTickCount} persisted market ticks.
                </p>

                {/* Verdict Box */}
                <div className={`p-4 rounded-xl border mb-4 flex items-start gap-3 ${
                  benchmarkResult.matrixComparison.readyForRetirement
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                }`}>
                  {benchmarkResult.matrixComparison.readyForRetirement ? (
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400 mt-0.5" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" />
                  )}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm">Verdict: {benchmarkResult.matrixComparison.verdict.replace(/_/g, ' ')}</span>
                      <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-black/40 border border-white/10">
                        {benchmarkResult.matrixComparison.readyForRetirement ? 'GATE PASSED' : 'HOLD RETIREMENT'}
                      </span>
                    </div>
                    <p className="text-xs mt-1 opacity-90">{benchmarkResult.matrixComparison.reason}</p>
                  </div>
                </div>

                {/* Comparison Matrix Table */}
                <div className="grid gap-4 md:grid-cols-2">
                  {/* Champion Card */}
                  <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                        <Crown className="h-3.5 w-3.5" /> Current Champion
                      </span>
                      <span className="text-[10px] font-mono text-slate-500">{benchmarkResult.champion?.modelId.slice(0, 10) || 'None'}</span>
                    </div>
                    <h4 className="font-bold text-slate-200 text-sm">{benchmarkResult.champion?.modelName || 'No Active Production Champion'}</h4>

                    <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                      <div className="rounded-lg bg-white/[0.02] p-2 border border-white/5">
                        <span className="text-slate-500 block text-[11px]">In-Sample Acc</span>
                        <span className="font-bold font-mono">{pct(benchmarkResult.champion?.inSampleMetrics.accuracy ?? null)}</span>
                      </div>
                      <div className="rounded-lg bg-white/[0.02] p-2 border border-white/5">
                        <span className="text-slate-500 block text-[11px]">In-Sample F1</span>
                        <span className="font-bold font-mono">{benchmarkResult.champion?.inSampleMetrics.f1?.toFixed(3) || '—'}</span>
                      </div>
                      <div className="rounded-lg bg-white/[0.02] p-2 border border-white/5">
                        <span className="text-slate-500 block text-[11px]">Backtest Win Rate</span>
                        <span className="font-bold font-mono">{pct(benchmarkResult.champion?.backtest.winRate ?? null)}</span>
                      </div>
                      <div className="rounded-lg bg-white/[0.02] p-2 border border-white/5">
                        <span className="text-slate-500 block text-[11px]">Profit Factor</span>
                        <span className="font-bold font-mono">{benchmarkResult.champion?.backtest.profitFactor?.toFixed(2) || '—'}</span>
                      </div>
                    </div>
                  </div>

                  {/* Challenger Card */}
                  <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.02] p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold uppercase tracking-wider text-amber-300 flex items-center gap-1.5">
                        <Zap className="h-3.5 w-3.5" /> Evaluated Challenger
                      </span>
                      <span className="text-[10px] font-mono text-slate-500">{benchmarkResult.challenger.modelId.slice(0, 10)}</span>
                    </div>
                    <h4 className="font-bold text-slate-200 text-sm">{benchmarkResult.challenger.modelName}</h4>

                    <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                      <div className="rounded-lg bg-white/[0.02] p-2 border border-white/5">
                        <span className="text-slate-500 block text-[11px]">In-Sample Acc</span>
                        <span className="font-bold font-mono text-amber-200">{pct(benchmarkResult.challenger.inSampleMetrics.accuracy)}</span>
                        {benchmarkResult.matrixComparison.inSampleAccuracyDelta !== null && (
                          <span className={`text-[10px] ml-1 font-mono ${benchmarkResult.matrixComparison.inSampleAccuracyDelta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            ({benchmarkResult.matrixComparison.inSampleAccuracyDelta >= 0 ? '+' : ''}{benchmarkResult.matrixComparison.inSampleAccuracyDelta.toFixed(2)}%)
                          </span>
                        )}
                      </div>
                      <div className="rounded-lg bg-white/[0.02] p-2 border border-white/5">
                        <span className="text-slate-500 block text-[11px]">In-Sample F1</span>
                        <span className="font-bold font-mono text-amber-200">{benchmarkResult.challenger.inSampleMetrics.f1?.toFixed(3) || '—'}</span>
                        {benchmarkResult.matrixComparison.inSampleF1Delta !== null && (
                          <span className={`text-[10px] ml-1 font-mono ${benchmarkResult.matrixComparison.inSampleF1Delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            ({benchmarkResult.matrixComparison.inSampleF1Delta >= 0 ? '+' : ''}{benchmarkResult.matrixComparison.inSampleF1Delta.toFixed(3)})
                          </span>
                        )}
                      </div>
                      <div className="rounded-lg bg-white/[0.02] p-2 border border-white/5">
                        <span className="text-slate-500 block text-[11px]">Shadow Backtest Win Rate</span>
                        <span className="font-bold font-mono text-cyan-300">{pct(benchmarkResult.challenger.backtest.winRate)}</span>
                        {benchmarkResult.matrixComparison.backtestWinRateDelta !== null && (
                          <span className={`text-[10px] ml-1 font-mono ${benchmarkResult.matrixComparison.backtestWinRateDelta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            ({benchmarkResult.matrixComparison.backtestWinRateDelta >= 0 ? '+' : ''}{benchmarkResult.matrixComparison.backtestWinRateDelta.toFixed(2)}%)
                          </span>
                        )}
                      </div>
                      <div className="rounded-lg bg-white/[0.02] p-2 border border-white/5">
                        <span className="text-slate-500 block text-[11px]">Shadow Profit Factor</span>
                        <span className="font-bold font-mono text-cyan-300">{benchmarkResult.challenger.backtest.profitFactor?.toFixed(2) || '—'}</span>
                        <span className="text-[10px] text-slate-500 ml-1">({benchmarkResult.challenger.backtest.trades} trades)</span>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {benchmarkError && (
              <div className="mb-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-xs text-rose-200">
                <strong>Benchmark error:</strong> {benchmarkError}
              </div>
            )}

            {loading && !models.length ? (
              <div className="p-12 text-center text-slate-500">Loading live model registry…</div>
            ) : !unifiedSuites.length && !singleGroups.length ? (
              <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-12 text-center">
                <ShieldAlert className="mx-auto h-8 w-8 text-slate-700" />
                <p className="mt-3 text-sm font-semibold text-slate-400">No persisted registry models available.</p>
                <p className="mt-1 text-xs text-slate-600">No synthetic candidates are created by this page.</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Unified Multi-Horizon Model Suites */}
                {unifiedSuites.map((suite) => (
                  <section
                    key={suite.suiteKey}
                    className="overflow-hidden rounded-3xl border border-cyan-500/30 bg-cyan-950/10 shadow-2xl shadow-cyan-950/20"
                  >
                    {/* Master Suite Banner */}
                    <div className="border-b border-cyan-500/20 bg-cyan-900/20 p-5">
                      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                        <div className="flex items-center gap-3">
                          <div className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 p-3">
                            <Zap className="h-6 w-6 text-cyan-300" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300 bg-cyan-500/20 px-2 py-0.5 rounded-full border border-cyan-500/30">
                                Unified Multi-Horizon Suite
                              </span>
                              <span className="text-xs font-mono text-slate-400 uppercase">{suite.framework}</span>
                            </div>
                            <h2 className="text-xl font-bold text-white mt-1">
                              {getSymbolDisplayName(suite.symbol)} <span className="text-xs font-mono text-cyan-300/70 font-normal">({suite.symbol})</span> · Unified Master Model
                            </h2>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Trained once across all embedded durations ({suite.models.length} horizons: tick streaking through 300s)
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                          {suite.candidateModelIds.length > 0 && (
                            <button
                              onClick={() => void promoteSuite(suite.suiteKey, suite.candidateModelIds)}
                              disabled={busy === suite.suiteKey}
                              className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-xs font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-50 transition shadow-lg shadow-cyan-500/20 cursor-pointer"
                            >
                              {busy === suite.suiteKey ? (
                                <RefreshCw className="h-4 w-4 animate-spin" />
                              ) : (
                                <Award className="h-4 w-4" />
                              )}
                              Promote Entire Suite ({suite.candidateModelIds.length} Horizons)
                            </button>
                          )}
                          {suite.championsCount === suite.models.length && (
                            <span className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-300">
                              <Crown className="h-4 w-4" /> Full Suite Active in Production ({suite.championsCount}/{suite.models.length})
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Highlight Metrics */}
                      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                        <div className="rounded-xl bg-black/40 p-3 border border-white/5">
                          <span className="text-slate-500 block text-[11px]">Total Horizons</span>
                          <span className="text-base font-bold font-mono text-cyan-200">{suite.models.length} Durations</span>
                        </div>
                        <div className="rounded-xl bg-black/40 p-3 border border-white/5">
                          <span className="text-slate-500 block text-[11px]">Active Champions</span>
                          <span className="text-base font-bold font-mono text-emerald-300">{suite.championsCount} Active</span>
                        </div>
                        <div className="rounded-xl bg-black/40 p-3 border border-white/5">
                          <span className="text-slate-500 block text-[11px]">Overall Accuracy</span>
                          <span className="text-base font-bold font-mono text-amber-200">{pct(suite.overallAccuracy)}</span>
                        </div>
                        <div className="rounded-xl bg-black/40 p-3 border border-white/5">
                          <span className="text-slate-500 block text-[11px]">Overall F1 Score</span>
                          <span className="text-base font-bold font-mono text-amber-200">{suite.overallF1 != null ? suite.overallF1.toFixed(3) : '—'}</span>
                        </div>
                      </div>
                    </div>

                    {/* Table of embedded horizon submodels */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs text-slate-300">
                        <thead className="border-b border-cyan-500/20 bg-black/30 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          <tr>
                            <th className="py-2.5 px-3">Horizon</th>
                            <th className="py-2.5 px-3">Status</th>
                            <th className="py-2.5 px-3">Validation Accuracy</th>
                            <th className="py-2.5 px-3">F1 Score</th>
                            <th className="py-2.5 px-3">Log Loss</th>
                            <th className="py-2.5 px-3 text-right">Horizon Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5 font-mono text-xs">
                          {suite.models.map((m) => {
                            const acc = metric(m, 'accuracy');
                            const f1 = metric(m, 'f1');
                            const loss = metric(m, 'logLoss') ?? metric(m, 'loss');
                            const isProd = m.status === 'production';
                            const isPromotable = ['candidate', 'staging'].includes(String(m.status).toLowerCase());

                            return (
                              <tr key={m.model_id} className={`hover:bg-white/[0.02] ${isProd ? 'bg-emerald-500/[0.02]' : ''}`}>
                                <td className="py-3 px-3 font-bold text-slate-100 font-sans">
                                  {m.horizon_secs}s
                                </td>
                                <td className="py-3 px-3 font-sans">
                                  {isProd ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300 bg-emerald-500/20 px-2 py-0.5 rounded-full border border-emerald-500/30">
                                      <Crown className="h-3 w-3" /> Champion
                                    </span>
                                  ) : isPromotable ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-300 bg-amber-500/20 px-2 py-0.5 rounded-full border border-amber-500/30">
                                      Candidate
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded-full border border-slate-700/60">
                                      Retired
                                    </span>
                                  )}
                                </td>
                                <td className="py-3 px-3 font-mono font-bold text-slate-200">
                                  {pct(acc)}
                                </td>
                                <td className="py-3 px-3 font-mono text-slate-300">
                                  {f1 != null ? f1.toFixed(3) : '—'}
                                </td>
                                <td className="py-3 px-3 font-mono text-slate-400">
                                  {loss != null ? loss.toFixed(4) : '—'}
                                </td>
                                <td className="py-3 px-3 text-right space-x-2">
                                  {isPromotable ? (
                                    <button
                                      onClick={() => void promote(m)}
                                      disabled={busy === m.model_id}
                                      className="inline-flex items-center gap-1 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-bold text-cyan-200 hover:bg-cyan-400/20 transition cursor-pointer disabled:opacity-50"
                                    >
                                      {busy === m.model_id ? 'Promoting…' : 'Promote Horizon'}
                                    </button>
                                  ) : isProd ? (
                                    <span className="text-[11px] font-semibold text-emerald-400/80">Active Champion</span>
                                  ) : (
                                    <span className="text-[11px] font-medium text-slate-500">Archived</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))}

                {/* Legacy Single-Horizon Models */}
                {singleGroups.map(([key, list]) => {
                  const rawSymbol = list[0]?.symbol || key.split('·')[0]?.trim() || 'UNKNOWN';
                  const horizonSecs = list[0]?.horizon_secs || key.split('·')[1]?.trim() || '';
                  const displayName = getSymbolDisplayName(rawSymbol);
                  const production = list.find(m => m.status === 'production');
                  const challengers = list.filter(m => ['candidate','staging'].includes(String(m.status).toLowerCase()));

                  return (
                    <section key={key} className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
                      <div className="border-b border-white/10 p-4">
                        <h2 className="font-bold text-base text-white">
                          {displayName} <span className="text-xs font-mono text-slate-400 font-normal">({rawSymbol})</span> {horizonSecs ? `· ${horizonSecs}${String(horizonSecs).endsWith('s') ? '' : 's'} Horizon` : ''}
                        </h2>
                        <p className="mt-1 text-xs text-slate-500">Single horizon model lineage comparison · shadow backtesting benchmark</p>
                      </div>
                      <div className="grid gap-4 p-4 lg:grid-cols-2">
                        {production && (
                          <article className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
                            <div className="flex items-center justify-between">
                              <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                                <Crown className="h-3.5 w-3.5" />Champion
                              </span>
                              <span className="text-[10px] text-slate-500 font-mono">{production.status}</span>
                            </div>
                            <h3 className="mt-3 font-bold">{production.model_name || production.raw_model_family || production.model_id}</h3>
                            <p className="mt-1 text-xs font-mono text-slate-600">{production.model_id}</p>
                            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                              <div className="rounded-lg bg-black/20 p-3">
                                <span className="text-slate-500">Accuracy</span>
                                <strong className="ml-2">{pct(metric(production,'accuracy'))}</strong>
                              </div>
                              <div className="rounded-lg bg-black/20 p-3">
                                <span className="text-slate-500">F1</span>
                                <strong className="ml-2">{metric(production,'f1')?.toFixed(3) || '—'}</strong>
                              </div>
                            </div>
                          </article>
                        )}
                        <div className="space-y-3">
                          {challengers.length ? challengers.map((challenger) => (
                            <article key={challenger.model_id} className="rounded-xl border border-amber-400/15 bg-amber-400/[0.025] p-4">
                              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                                <div>
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">Challenger · {challenger.status}</span>
                                  <h3 className="mt-1 font-bold text-slate-200">{challenger.model_name || challenger.raw_model_family || challenger.model_id}</h3>
                                  <p className="mt-0.5 text-xs font-mono text-slate-500">{challenger.model_id}</p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    onClick={() => void runBenchmark(challenger)}
                                    disabled={benchmarkingModelId === challenger.model_id}
                                    className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-bold text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-50 transition"
                                  >
                                    {benchmarkingModelId === challenger.model_id ? (
                                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Scale className="h-3.5 w-3.5" />
                                    )}
                                    {benchmarkingModelId === challenger.model_id ? 'Backtesting…' : 'Benchmark Matrix'}
                                  </button>
                                  <button
                                    onClick={() => void promote(challenger)}
                                    disabled={busy === challenger.model_id}
                                    className="rounded-xl bg-cyan-400 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-50 hover:bg-cyan-300 transition"
                                  >
                                    {busy === challenger.model_id ? 'Promoting…' : 'Promote'}
                                  </button>
                                </div>
                              </div>
                              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                                <div className="rounded-lg bg-black/20 p-2.5">
                                  <span className="text-slate-500">Accuracy</span>
                                  <strong className="ml-2 font-mono">{pct(metric(challenger,'accuracy'))}</strong>
                                </div>
                                <div className="rounded-lg bg-black/20 p-2.5">
                                  <span className="text-slate-500">F1</span>
                                  <strong className="ml-2 font-mono">{metric(challenger,'f1')?.toFixed(3) || '—'}</strong>
                                </div>
                              </div>
                            </article>
                          )) : (
                            <div className="rounded-xl border border-white/10 p-6 text-center text-xs text-slate-600">
                              No candidate or staging challenger for this asset/horizon.
                            </div>
                          )}
                        </div>
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}

        <footer className="mt-5 rounded-2xl border border-cyan-400/10 bg-cyan-400/[0.02] p-4 text-xs leading-5 text-slate-500">
          <strong className="text-cyan-300">Governance &amp; Benchmark Matrix:</strong> Before triggering champion retirement, the system executes side-by-side automated shadow backtesting on real out-of-sample ticks. The production API validates persisted model lineage, symbol, horizon, lifecycle tier, server-side lifecycle gates, and promotable status before changing production state.
        </footer>
      </div>
    </main>
  );
}
