'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Activity, ArrowLeft, BrainCircuit, CheckCircle2, Database, Gauge, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';

type Health = { status?: string; services?: { database?: string; pythonDaemon?: string; dbLatencyMs?: number | null; daemonLatencyMs?: number | null } };
type Stats = { dataSource?: string; isSimulated?: boolean; realTradesOnly?: boolean; summary?: { activeModel?: string; totalTrades?: number; totalModels?: number } };
type Registry = { dataSource?: string; models?: Array<{ model_id?: string; status?: string; symbol?: string; horizon_secs?: number }> };

function Status({ ok, label }: { ok: boolean; label: string }) { return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wider ${ok ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : 'border-amber-400/20 bg-amber-400/10 text-amber-200'}`}>{ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}{label}</span>; }

export default function PredictionIntegrationPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const responses = await Promise.all([
        fetch('/api/health', { cache: 'no-store' }),
        fetch('/api/admin/stats', { cache: 'no-store' }),
        fetch('/api/ml/registry?status=production', { cache: 'no-store' }),
      ]);
      if (responses.some(r => r.status === 401)) { window.location.replace('/admin'); return; }
      const [h, s, r] = await Promise.all(responses.map(x => x.json().catch(() => null)));
      setHealth(h); setStats(s); setRegistry(r); setRefreshedAt(new Date().toISOString());
      const failed = responses.filter(r => !r.ok && r.status !== 503).map(r => r.status);
      if (failed.length) setError(`One or more integration sources returned HTTP ${failed.join(', ')}.`);
    } catch { setError('Unable to load prediction integration diagnostics.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30000); return () => window.clearInterval(timer); }, [load]);

  const db = health?.services?.database === 'connected';
  const daemon = health?.services?.pythonDaemon === 'connected';
  const live = stats?.dataSource === 'live-database' && stats?.isSimulated === false && stats?.realTradesOnly === true;
  const productionModels = registry?.models?.filter(m => String(m.status).toLowerCase() === 'production') || [];
  const ready = db && daemon && live && productionModels.length > 0;

  return <main className="min-h-screen bg-[#05070b] text-slate-100"><div className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
    <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><Gauge className="h-6 w-6 text-cyan-300" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">Production Verification · Signal Path</p><h1 className="text-2xl font-black tracking-tight sm:text-3xl">Prediction & Trading Integration</h1><p className="mt-1 text-xs text-slate-500">Readiness of the production prediction boundary, runtime, persisted model registry and live-data contract.</p></div></div><div className="flex flex-wrap gap-2"><Link href="/admin" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300"><ArrowLeft className="h-4 w-4" />Operations Center</Link><Link href="/admin/intelligence" className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200"><BrainCircuit className="h-4 w-4" />Trading Intelligence</Link><button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button></div></header>
    {error && <div className="mb-5 rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-4 text-sm text-amber-200">{error}</div>}
    <section className={`mb-6 rounded-2xl border p-5 ${ready ? 'border-emerald-400/20 bg-emerald-400/[0.04]' : 'border-amber-400/20 bg-amber-400/[0.04]'}`}><div className="flex items-start gap-3">{ready ? <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-300" /> : <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-amber-300" />}<div><h2 className="font-bold">{ready ? 'Production signal path prerequisites confirmed' : 'Production signal path requires attention'}</h2><p className="mt-1 text-xs leading-5 text-slate-500">This is a readiness assessment, not a claim that a live trade or prediction was executed. The page never invents signal results.</p></div></div></section>
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="flex items-center justify-between"><Database className="h-5 w-5 text-cyan-300" /><Status ok={db} label={db ? 'CONNECTED' : 'UNCONFIRMED'} /></div><h3 className="mt-4 font-bold">Database</h3><p className="mt-1 text-xs text-slate-500">Latency {health?.services?.dbLatencyMs != null ? `${health.services.dbLatencyMs} ms` : '—'}</p></article>
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="flex items-center justify-between"><BrainCircuit className="h-5 w-5 text-cyan-300" /><Status ok={daemon} label={daemon ? 'CONNECTED' : 'UNCONFIRMED'} /></div><h3 className="mt-4 font-bold">ML Runtime</h3><p className="mt-1 text-xs text-slate-500">Python daemon latency {health?.services?.daemonLatencyMs != null ? `${health.services.daemonLatencyMs} ms` : '—'}</p></article>
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="flex items-center justify-between"><Activity className="h-5 w-5 text-cyan-300" /><Status ok={live} label={live ? 'LIVE DATA' : 'NOT CONFIRMED'} /></div><h3 className="mt-4 font-bold">Signal Data Contract</h3><p className="mt-1 text-xs text-slate-500">{stats?.dataSource || 'Source not reported'} · simulated={String(stats?.isSimulated)}</p></article>
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="flex items-center justify-between"><Gauge className="h-5 w-5 text-cyan-300" /><Status ok={productionModels.length > 0} label={productionModels.length ? 'AVAILABLE' : 'NONE'} /></div><h3 className="mt-4 font-bold">Production Models</h3><p className="mt-1 text-xs text-slate-500">{productionModels.length} registry record{productionModels.length === 1 ? '' : 's'}</p></article>
    </section>
    <section className="mt-5 grid gap-4 lg:grid-cols-2"><article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><h2 className="font-bold">Prediction Boundary</h2><p className="mt-2 text-xs leading-5 text-slate-500">The production prediction API validates input, obtains the canonical feature window, resolves asset context, evaluates the production ensemble and returns signal, confidence, model breakdown, strategy gate and latency metadata. The admin console observes readiness without fabricating a prediction.</p><div className="mt-4 grid gap-2 sm:grid-cols-2">{['Input validation','Canonical feature context','Asset / market context','Production ensemble','Confidence + model breakdown','Strategy gate + latency'].map(item => <div key={item} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-slate-400"><CheckCircle2 className="mr-2 inline h-3.5 w-3.5 text-emerald-300" />{item}</div>)}</div></article><article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><h2 className="font-bold">Verification Trail</h2><dl className="mt-4 divide-y divide-white/5 text-sm"><div className="flex justify-between gap-4 py-3"><dt className="text-slate-500">Active model</dt><dd className="max-w-[60%] truncate font-mono text-slate-300">{stats?.summary?.activeModel || '—'}</dd></div><div className="flex justify-between gap-4 py-3"><dt className="text-slate-500">Persisted trades</dt><dd className="font-mono text-slate-300">{stats?.summary?.totalTrades ?? '—'}</dd></div><div className="flex justify-between gap-4 py-3"><dt className="text-slate-500">Registered models</dt><dd className="font-mono text-slate-300">{stats?.summary?.totalModels ?? '—'}</dd></div><div className="flex justify-between gap-4 py-3"><dt className="text-slate-500">Last refresh</dt><dd className="font-mono text-slate-300">{refreshedAt ? new Date(refreshedAt).toLocaleTimeString() : '—'}</dd></div></dl><div className="mt-4 flex gap-2 rounded-xl border border-amber-400/15 bg-amber-400/[0.03] p-3 text-xs leading-5 text-slate-500"><XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />A true end-to-end prediction execution test should be performed against a controlled test payload and explicitly logged as a diagnostic event before being treated as a production verification result.</div></article></section>
  </div></main>;
}
