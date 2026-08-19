'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BrainCircuit, CheckCircle2, Database, Layers3, RefreshCw, ShieldAlert, Target, TrendingUp, XCircle } from 'lucide-react';

type ConfidenceBracket = { bracket?: string; wins?: number; losses?: number; total?: number; winRate?: number };
type Strategy = { strategy?: string; trades?: number; wins?: number; losses?: number; winRate?: number };
type Stats = {
  dataSource?: string;
  isSimulated?: boolean;
  realTradesOnly?: boolean;
  summary?: { totalTrades?: number; wins?: number; losses?: number; winRate?: number; totalProfit?: number; totalTicks?: number; totalModels?: number; activeModel?: string; activeAccuracy?: number | null };
  confidenceBrackets?: ConfidenceBracket[];
  strategyBreakdown?: Strategy[];
};
type Feature = { feature?: string; importance?: number; name?: string; value?: number };
type Features = { success?: boolean; totalFeatures?: number; features?: Feature[]; dataSource?: string };
type Model = { model_id?: string; symbol?: string; horizon_secs?: number; status?: string; format?: string; accuracy?: number | null; trained_at?: string };
type Registry = { success?: boolean; models?: Model[]; count?: number; dataSource?: string };

type PageState = { stats: Stats | null; features: Features | null; registry: Registry | null; loading: boolean; error: string | null; refreshedAt: string | null };
const initial: PageState = { stats: null, features: null, registry: null, loading: true, error: null, refreshedAt: null };

function num(value: number | null | undefined, suffix = '') { return Number.isFinite(value) ? `${Number(value).toLocaleString()}${suffix}` : '—'; }
function pct(value: number | null | undefined) { return Number.isFinite(value) ? `${Number(value).toFixed(1)}%` : '—'; }
function Status({ live }: { live: boolean }) { return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wider ${live ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : 'border-amber-400/20 bg-amber-400/10 text-amber-300'}`}>{live ? <CheckCircle2 className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}{live ? 'LIVE DATA' : 'UNAVAILABLE'}</span>; }

export default function TradingIntelligencePage() {
  const [state, setState] = useState<PageState>(initial);
  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const responses = await Promise.all([
        fetch('/api/admin/stats', { cache: 'no-store' }),
        fetch('/api/ml/features', { cache: 'no-store' }),
        fetch('/api/ml/registry', { cache: 'no-store' }),
      ]);
      if (responses.some(r => r.status === 401)) { window.location.replace('/admin'); return; }
      const [stats, features, registry] = await Promise.all(responses.map(r => r.json().catch(() => null)));
      const failed = responses.filter(r => !r.ok && r.status !== 503).map(r => r.status);
      setState({ stats, features, registry, loading: false, error: failed.length ? `One or more intelligence sources returned HTTP ${failed.join(', ')}.` : null, refreshedAt: new Date().toISOString() });
    } catch { setState(s => ({ ...s, loading: false, error: 'Unable to load Trading Intelligence data.' })); }
  }, []);

  useEffect(() => { load(); const timer = window.setInterval(load, 30000); return () => window.clearInterval(timer); }, [load]);

  const stats = state.stats;
  const models = state.registry?.models || [];
  const horizons = useMemo(() => Array.from(new Set(models.map(m => Number(m.horizon_secs)).filter(Number.isFinite))).sort((a,b) => a-b), [models]);
  const formats = useMemo(() => Array.from(new Set(models.map(m => String(m.format || '').trim()).filter(Boolean))), [models]);
  const production = useMemo(() => models.filter(m => String(m.status || '').toLowerCase() === 'production'), [models]);
  const features = useMemo(() => (state.features?.features || []).slice().sort((a,b) => Number(b.importance ?? b.value ?? 0) - Number(a.importance ?? a.value ?? 0)).slice(0, 12), [state.features]);
  const confidence = stats?.confidenceBrackets || [];
  const strategies = stats?.strategyBreakdown || [];
  const live = stats?.dataSource === 'live-database' && stats?.isSimulated === false && stats?.realTradesOnly === true;

  return <main className="min-h-screen bg-[#05070b] text-slate-100">
    <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3"><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><BrainCircuit className="h-6 w-6 text-cyan-300" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">5B-3</p><h1 className="text-2xl font-black tracking-tight sm:text-3xl">Trading Intelligence</h1><p className="mt-1 text-xs text-slate-500">Persisted signal quality, confidence, strategy and model intelligence.</p></div></div>
        <div className="flex flex-wrap items-center gap-2"><Link href="/admin" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10"><ArrowLeft className="h-4 w-4" />Operations Center</Link><button onClick={load} disabled={state.loading} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${state.loading ? 'animate-spin' : ''}`} />Refresh</button></div>
      </header>

      {state.error && <div className="mb-5 rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-200">{state.error}</div>}

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-4 flex items-start justify-between"><Target className="h-5 w-5 text-cyan-300" /><Status live={live} /></div><p className="text-xs uppercase tracking-[0.15em] text-slate-500">Signal sample</p><p className="mt-2 text-2xl font-black">{num(stats?.summary?.totalTrades)}</p><p className="mt-1 text-xs text-slate-500">Persisted trades</p></article>
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-4 flex items-start justify-between"><TrendingUp className="h-5 w-5 text-cyan-300" /><Status live={live} /></div><p className="text-xs uppercase tracking-[0.15em] text-slate-500">Resolved win rate</p><p className="mt-2 text-2xl font-black">{pct(stats?.summary?.winRate)}</p><p className="mt-1 text-xs text-slate-500">Wins {num(stats?.summary?.wins)} · Losses {num(stats?.summary?.losses)}</p></article>
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-4 flex items-start justify-between"><Layers3 className="h-5 w-5 text-cyan-300" /><Status live={state.registry?.dataSource === 'live-database'} /></div><p className="text-xs uppercase tracking-[0.15em] text-slate-500">Production models</p><p className="mt-2 text-2xl font-black">{num(production.length)}</p><p className="mt-1 text-xs text-slate-500">{formats.length ? formats.join(' · ') : 'No format reported'}</p></article>
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-4 flex items-start justify-between"><Database className="h-5 w-5 text-cyan-300" /><Status live={state.features?.success === true} /></div><p className="text-xs uppercase tracking-[0.15em] text-slate-500">Feature intelligence</p><p className="mt-2 text-2xl font-black">{num(state.features?.totalFeatures)}</p><p className="mt-1 text-xs text-slate-500">Feature importance records</p></article>
      </section>

      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-5 flex items-center justify-between"><div><h2 className="font-bold">Confidence Intelligence</h2><p className="mt-1 text-xs text-slate-500">Derived only from persisted trade confidence and resolved outcomes.</p></div><Status live={live} /></div><div className="space-y-3">{confidence.length ? confidence.map((b, i) => <div key={`${b.bracket}-${i}`} className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="flex items-center justify-between"><span className="text-sm font-semibold">{b.bracket || 'Unknown'}</span><span className="text-sm font-bold text-cyan-300">{pct(b.winRate)}</span></div><div className="mt-2 flex justify-between text-xs text-slate-500"><span>{num(b.total)} records</span><span>{num(b.wins)}W · {num(b.losses)}L</span></div></div>) : <Empty text="No persisted confidence records are available." />}</div></article>
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-5 flex items-center justify-between"><div><h2 className="font-bold">Strategy Intelligence</h2><p className="mt-1 text-xs text-slate-500">Observed strategy outcomes from the live database.</p></div><Status live={live} /></div><div className="space-y-3">{strategies.length ? strategies.slice(0, 8).map((s, i) => <div key={`${s.strategy}-${i}`} className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="flex items-center justify-between gap-3"><span className="truncate text-sm font-semibold">{s.strategy || 'Unknown'}</span><span className="text-sm font-bold text-cyan-300">{pct(s.winRate)}</span></div><div className="mt-2 text-xs text-slate-500">{num(s.trades)} trades · {num(s.wins)}W · {num(s.losses)}L</div></div>) : <Empty text="No persisted strategy breakdown is available." />}</div></article>
      </section>

      <section className="mb-6 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-5 flex items-center justify-between"><div><h2 className="font-bold">Feature Intelligence</h2><p className="mt-1 text-xs text-slate-500">Current XGBoost engine feature-importance data; no fabricated heatmap values.</p></div><Status live={state.features?.success === true} /></div><div className="space-y-2">{features.length ? features.map((f, i) => { const value = Number(f.importance ?? f.value); return <div key={`${f.feature || f.name}-${i}`} className="grid grid-cols-[minmax(0,1fr)_90px] items-center gap-3"><span className="truncate text-xs text-slate-300">{f.feature || f.name || `Feature ${i + 1}`}</span><div className="text-right text-xs font-semibold text-cyan-300">{Number.isFinite(value) ? value.toFixed(4) : '—'}</div></div>; }) : <Empty text="Feature importance is unavailable from the current runtime." />}</div></article>
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-5 flex items-center justify-between"><div><h2 className="font-bold">Multi-Horizon Discovery</h2><p className="mt-1 text-xs text-slate-500">Horizons observed in the persisted model registry.</p></div><Status live={state.registry?.dataSource === 'live-database'} /></div><div className="grid grid-cols-2 gap-3">{horizons.length ? horizons.map(h => <div key={h} className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xl font-black">{h}s</p><p className="mt-1 text-xs text-slate-500">registered horizon</p></div>) : <Empty text="No registered horizons are available." />}</div><div className="mt-5 rounded-xl border border-amber-400/15 bg-amber-400/[0.04] p-4"><div className="flex gap-2"><XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><p className="text-xs leading-5 text-slate-400">Regime detection, ensemble agreement and multi-horizon edge scores are not inferred here. They require persisted evaluation records; this page intentionally reports them as unavailable until such data exists.</p></div></div></article>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold">Intelligence data contract</h2><p className="mt-1 text-xs text-slate-500">Source: {stats?.dataSource || state.registry?.dataSource || 'not confirmed'} · Refreshed: {state.refreshedAt ? new Date(state.refreshedAt).toLocaleTimeString() : '—'}</p></div><div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500"><span className="rounded-full border border-white/10 px-2.5 py-1">No mock metrics</span><span className="rounded-full border border-white/10 px-2.5 py-1">Live / unavailable separation</span><span className="rounded-full border border-white/10 px-2.5 py-1">30s refresh</span></div></div></section>
    </div>
  </main>;
}

function Empty({ text }: { text: string }) { return <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-xs text-slate-500">{text}</div>; }
