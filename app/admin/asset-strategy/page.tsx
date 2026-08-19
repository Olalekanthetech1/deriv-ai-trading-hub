'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BrainCircuit, CheckCircle2, Database, GitBranch, RefreshCw, ShieldCheck, Timer, XCircle } from 'lucide-react';

type TrainingRun = {
  run_id?: string;
  asset_symbol?: string;
  duration_value?: number;
  duration_unit?: string;
  status?: string;
  strategy_key?: string | null;
  strategy_version?: string | null;
  strategy_metadata?: Record<string, any> | null;
  created_at?: string;
  completed_models?: number;
  failed_models?: number;
};

type RegistryModel = {
  model_id?: string;
  symbol?: string;
  duration_value?: number;
  duration_unit?: string;
  duration_seconds?: number | null;
  effective_horizon_ticks?: number | null;
  status?: string;
  strategy_key?: string | null;
  strategy_version?: string | null;
  strategy_metadata?: Record<string, any> | null;
  metrics?: Record<string, any> | null;
};

function durationLabel(value: unknown, unit: unknown) {
  const numeric = Number(value);
  const labels: Record<string, string> = { t: 'ticks', s: 'seconds', m: 'minutes', h: 'hours', d: 'days' };
  return Number.isSafeInteger(numeric) && numeric > 0 ? `${numeric} ${labels[String(unit)] || String(unit || '')}`.trim() : '—';
}

function dateLabel(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function badgeClass(status?: string) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'completed' || normalized === 'production') return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300';
  if (normalized === 'running' || normalized === 'candidate' || normalized === 'staging') return 'border-cyan-400/20 bg-cyan-400/10 text-cyan-200';
  if (normalized === 'failed' || normalized === 'partial') return 'border-red-400/20 bg-red-400/10 text-red-300';
  return 'border-white/10 bg-white/5 text-slate-400';
}

export default function AssetStrategyPage() {
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [models, setModels] = useState<RegistryModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [symbolFilter, setSymbolFilter] = useState('ALL');

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    setError(null);
    try {
      const runResponse = await fetch('/api/admin/model-training', { cache: 'no-store' });
      if (runResponse.status === 401) {
        window.location.replace('/admin');
        return;
      }
      const runPayload = await runResponse.json().catch(() => ({}));
      if (!runResponse.ok || runPayload?.success === false) throw new Error(runPayload?.error || `Training API returned HTTP ${runResponse.status}.`);
      const loadedRuns: TrainingRun[] = Array.isArray(runPayload?.runs) ? runPayload.runs : [];
      setRuns(loadedRuns);
      const extractedModels: RegistryModel[] = loadedRuns.flatMap((r: any) =>
        (Array.isArray(r.models) ? r.models : []).map((m: any) => ({
          model_id: m.model_id,
          symbol: r.raw_asset_symbol || r.asset_symbol,
          duration_value: r.duration_value,
          duration_unit: r.duration_unit,
          duration_seconds: r.duration_seconds,
          effective_horizon_ticks: r.horizon_ticks,
          status: m.status,
          strategy_key: r.strategy_key,
          strategy_version: r.strategy_version,
          strategy_metadata: r.strategy_metadata,
          metrics: m.metrics,
        }))
      );
      setModels(extractedModels);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load asset-aware strategy lineage.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  const symbols = useMemo(() => Array.from(new Set([...runs.map((run) => run.asset_symbol), ...models.map((model) => model.symbol)].filter(Boolean) as string[])).sort(), [runs, models]);
  const filteredRuns = useMemo(() => runs.filter((run) => symbolFilter === 'ALL' || run.asset_symbol === symbolFilter), [runs, symbolFilter]);
  const strategyRuns = filteredRuns.filter((run) => Boolean(run.strategy_key));
  const strategyModels = models.filter((model) => Boolean(model.strategy_key) && (symbolFilter === 'ALL' || model.symbol === symbolFilter));
  const latest = strategyRuns[0];
  const strategyVersion = latest?.strategy_version || strategyModels[0]?.strategy_version || 'Not observed yet';

  const strategyContexts = useMemo(() => {
    const map = new Map<string, { key: string; symbol: string; duration: string; version: string; status: string; createdAt?: string; sequenceLength?: number; effectiveTicks?: number | null }>();
    for (const run of strategyRuns) {
      const key = `${run.asset_symbol}|${run.duration_value}|${run.duration_unit}|${run.strategy_key}`;
      if (map.has(key)) continue;
      const metadata = run.strategy_metadata || {};
      map.set(key, {
        key,
        symbol: String(run.asset_symbol || 'Unknown'),
        duration: durationLabel(run.duration_value, run.duration_unit),
        version: String(run.strategy_version || '—'),
        status: String(run.status || 'unknown'),
        createdAt: run.created_at,
        sequenceLength: Number.isFinite(Number(metadata.sequenceLength)) ? Number(metadata.sequenceLength) : undefined,
        effectiveTicks: Number.isFinite(Number(metadata?.horizon?.effectiveTicks)) ? Number(metadata.horizon.effectiveTicks) : null,
      });
    }
    return Array.from(map.values());
  }, [strategyRuns]);

  return <main className="min-h-screen bg-[#05070b] text-slate-100">
    <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3"><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><BrainCircuit className="h-6 w-6 text-cyan-300" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">Agenda 7</p><h1 className="text-2xl font-black tracking-tight sm:text-3xl">Asset-Aware Model Strategy</h1><p className="mt-1 text-xs text-slate-500">Runtime strategy selection, duration lineage and persisted training evidence.</p></div></div>
        <div className="flex flex-wrap items-center gap-2"><Link href="/admin" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10"><ArrowLeft className="h-4 w-4" />Operations Center</Link><button onClick={() => void load(true)} disabled={refreshing} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh</button></div>
      </header>

      {error && <div className="mb-5 rounded-2xl border border-red-400/20 bg-red-400/[0.06] px-4 py-3 text-sm text-red-200">{error}</div>}

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-3 flex items-center justify-between"><BrainCircuit className="h-5 w-5 text-cyan-300" /><span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-1 text-[10px] font-bold text-cyan-200">RUNTIME</span></div><p className="text-xs uppercase tracking-wider text-slate-500">Strategy version observed</p><p className="mt-1 text-2xl font-black">{strategyVersion}</p></article>
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-3 flex items-center justify-between"><GitBranch className="h-5 w-5 text-emerald-300" /><span className="text-[10px] font-bold tracking-wider text-slate-500">PERSISTED</span></div><p className="text-xs uppercase tracking-wider text-slate-500">Strategy-backed runs</p><p className="mt-1 text-2xl font-black">{strategyRuns.length.toLocaleString()}</p></article>
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-3 flex items-center justify-between"><Database className="h-5 w-5 text-cyan-300" /><span className="text-[10px] font-bold tracking-wider text-slate-500">LINEAGE</span></div><p className="text-xs uppercase tracking-wider text-slate-500">Strategy-tagged models</p><p className="mt-1 text-2xl font-black">{strategyModels.length.toLocaleString()}</p></article>
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-3 flex items-center justify-between"><Timer className="h-5 w-5 text-slate-300" /><span className="text-[10px] font-bold tracking-wider text-slate-500">DYNAMIC</span></div><p className="text-xs uppercase tracking-wider text-slate-500">Latest duration</p><p className="mt-1 text-lg font-black">{latest ? durationLabel(latest.duration_value, latest.duration_unit) : 'Awaiting training'}</p></article>
      </section>

      <section className="mb-6 rounded-2xl border border-white/10 bg-white/[0.025] p-5">
        <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><h2 className="text-base font-bold">Strategy Contract</h2><p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">The strategy derives asset class, market type, broker duration, effective horizon and dataset size at training time. It adjusts model context and hyperparameters without replacing the registered model families.</p></div><select value={symbolFilter} onChange={(event) => setSymbolFilter(event.target.value)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-slate-200 outline-none"><option value="ALL">All assets</option>{symbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}</select></div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs font-semibold text-slate-400">Asset context</p><p className="mt-2 text-xs leading-5 text-slate-500">Asset class and market type come from persisted market asset metadata.</p></div><div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs font-semibold text-slate-400">Duration context</p><p className="mt-2 text-xs leading-5 text-slate-500">Seconds, minutes, hours and days are retained as their native duration units and converted to effective ticks by the training contract.</p></div><div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs font-semibold text-slate-400">Model adaptation</p><p className="mt-2 text-xs leading-5 text-slate-500">Sequence length, tree estimators, neural epochs, anomaly estimators and regime components scale from runtime context.</p></div><div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs font-semibold text-slate-400">Governance</p><p className="mt-2 text-xs leading-5 text-slate-500">Strategy key, version, metadata and feature topology are persisted with training lineage.</p></div></div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
        <div className="mb-5 flex items-center justify-between gap-3"><div><h2 className="text-base font-bold">Observed Strategy Contexts</h2><p className="mt-1 text-xs text-slate-500">Only persisted training evidence is listed below.</p></div><span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-bold text-emerald-300">NO SYNTHETIC STATE</span></div>
        {loading ? <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500"><RefreshCw className="h-4 w-4 animate-spin" />Loading strategy lineage…</div> : strategyContexts.length === 0 ? <div className="rounded-xl border border-dashed border-white/10 px-5 py-14 text-center"><XCircle className="mx-auto h-7 w-7 text-slate-600" /><p className="mt-3 text-sm font-semibold text-slate-400">No persisted strategy lineage yet.</p><p className="mt-1 text-xs text-slate-600">Run native training against a valid duration-aware dataset and the resolved strategy will appear here.</p></div> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{strategyContexts.map((context) => <article key={context.key} className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs font-bold text-cyan-200">{context.symbol}</p><p className="mt-1 text-sm font-bold">{context.duration}</p></div><span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${badgeClass(context.status)}`}>{context.status.toUpperCase()}</span></div><div className="mt-4 space-y-2 text-xs"><div className="flex items-center justify-between"><span className="text-slate-500">Strategy</span><span className="max-w-[65%] truncate font-mono text-slate-300">{context.key.split('|').slice(3).join('|')}</span></div><div className="flex items-center justify-between"><span className="text-slate-500">Version</span><span className="text-slate-300">{context.version}</span></div><div className="flex items-center justify-between"><span className="text-slate-500">Sequence length</span><span className="text-slate-300">{context.sequenceLength ?? '—'}</span></div><div className="flex items-center justify-between"><span className="text-slate-500">Effective ticks</span><span className="text-slate-300">{context.effectiveTicks ?? '—'}</span></div><div className="flex items-center justify-between"><span className="text-slate-500">Observed</span><span className="text-slate-300">{dateLabel(context.createdAt)}</span></div></div></article>)}</div>}
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-3"><article className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.04] p-4"><div className="flex items-center gap-2 text-xs font-bold text-emerald-300"><CheckCircle2 className="h-4 w-4" />Leakage boundary preserved</div><p className="mt-2 text-xs leading-5 text-slate-500">The strategy consumes persisted dataset metadata after dataset validation; it does not create a parallel training path.</p></article><article className="rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.04] p-4"><div className="flex items-center gap-2 text-xs font-bold text-cyan-300"><ShieldCheck className="h-4 w-4" />Lineage preserved</div><p className="mt-2 text-xs leading-5 text-slate-500">Strategy key/version and strategy metadata are stored with training runs and registered candidate models.</p></article><article className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><div className="flex items-center gap-2 text-xs font-bold text-slate-300"><GitBranch className="h-4 w-4" />Next gate</div><p className="mt-2 text-xs leading-5 text-slate-500">Agenda 7 still requires runtime acceptance testing before being promoted to a completed roadmap gate.</p></article></section>
    </div>
  </main>;
}
