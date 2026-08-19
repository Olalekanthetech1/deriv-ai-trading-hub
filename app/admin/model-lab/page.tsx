'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, Beaker, BrainCircuit, CheckCircle2, FlaskConical, Gauge, RefreshCw, Rocket, ShieldAlert } from 'lucide-react';

type Model = { key: string; displayName: string; family: string; predictive: boolean; lifecycleTier: string; defaultEnabled: boolean };
type Runtime = { key: string; name: string; status: string; purpose: string };
type Catalog = { productionCandidates: Model[]; experimental: Model[]; runtimes: Runtime[] };

const tierLabel = (tier: string) => tier === 'experimental' ? 'EXPERIMENTAL' : 'PRODUCTION CANDIDATE';

export default function ModelLabPage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/ml/model-catalog', { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (response.status === 401) { window.location.replace('/admin'); return; }
      if (!response.ok || !data?.success) throw new Error(data?.error || 'Unable to load model catalog.');
      setCatalog(data);
    } catch (err: any) {
      setError(err?.message || 'Unable to load model catalog.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  return <main className="min-h-screen bg-[#05070b] px-4 py-5 text-slate-100 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Link href="/admin" className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 hover:bg-white/10"><ArrowLeft className="h-5 w-5" /></Link>
          <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><BrainCircuit className="h-6 w-6 text-cyan-300" /></div>
          <div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">ML CONTROL</p><h1 className="text-2xl font-black sm:text-3xl">Model Lab</h1><p className="mt-1 text-xs text-slate-500">Dynamic model lifecycle, experimental isolation, and runtime boundaries.</p></div>
        </div>
        <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button>
      </header>

      {error && <div className="mb-5 flex items-center gap-2 rounded-2xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-200"><ShieldAlert className="h-4 w-4" />{error}</div>}

      <section className="mb-6 grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.04] p-5"><div className="flex items-center gap-2 text-xs font-bold text-emerald-300"><Rocket className="h-4 w-4" />PRODUCTION CANDIDATES</div><p className="mt-2 text-3xl font-black">{catalog?.productionCandidates.length ?? '—'}</p><p className="mt-1 text-xs text-slate-500">Eligible for evaluation and explicit promotion.</p></div>
        <div className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.04] p-5"><div className="flex items-center gap-2 text-xs font-bold text-amber-300"><FlaskConical className="h-4 w-4" />EXPERIMENTAL LAB</div><p className="mt-2 text-3xl font-black">{catalog?.experimental.length ?? '—'}</p><p className="mt-1 text-xs text-slate-500">Excluded from default production training.</p></div>
        <div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.04] p-5"><div className="flex items-center gap-2 text-xs font-bold text-cyan-300"><Gauge className="h-4 w-4" />RUNTIMES</div><p className="mt-2 text-3xl font-black">{catalog?.runtimes.length ?? '—'}</p><p className="mt-1 text-xs text-slate-500">Training/inference runtime boundaries.</p></div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-4 flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-300" /><h2 className="font-bold">Production Candidate Models</h2></div><div className="space-y-2">{catalog?.productionCandidates.map(model => <div key={model.key} className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 p-3"><div><p className="text-sm font-bold">{model.displayName}</p><p className="text-[11px] text-slate-500">{model.family} · {model.predictive ? 'predictive' : 'supporting model'}</p></div><span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[9px] font-bold text-emerald-300">{tierLabel(model.lifecycleTier)}</span></div>)}</div></section>

        <section className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.025] p-5"><div className="mb-4 flex items-center gap-2"><Beaker className="h-5 w-5 text-amber-300" /><h2 className="font-bold">Experimental Models</h2></div><div className="space-y-2">{catalog?.experimental.map(model => <div key={model.key} className="flex items-center justify-between rounded-xl border border-amber-400/10 bg-black/20 p-3"><div><p className="text-sm font-bold">{model.displayName}</p><p className="text-[11px] text-slate-500">{model.family} · manual/explicit training only</p></div><span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[9px] font-bold text-amber-300">EXPERIMENTAL</span></div>)}</div><Link href="/admin/experiments" className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10">Open Experimental Lab <FlaskConical className="h-4 w-4" /></Link></section>
      </div>

      <section className="mt-5 rounded-2xl border border-white/10 bg-white/[0.025] p-5"><h2 className="mb-4 font-bold">Runtime Boundary</h2><div className="grid gap-3 md:grid-cols-2">{catalog?.runtimes.map(runtime => <div key={runtime.key} className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="flex items-center justify-between gap-3"><p className="text-sm font-bold">{runtime.name}</p><span className={`rounded-full border px-2 py-1 text-[9px] font-bold ${runtime.status === 'active' ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : 'border-slate-400/20 bg-slate-400/10 text-slate-300'}`}>{runtime.status.toUpperCase()}</span></div><p className="mt-2 text-xs text-slate-500">{runtime.purpose}</p></div>)}</div></section>
    </div>
  </main>;
}
