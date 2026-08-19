'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type SecurityData = { checks: Array<{ id: string; label: string; configured: boolean; severity: string }>; posture: Record<string, any>; integrity: Record<string, any>; environment: string | null };

export default function SecurityConfigurationPage() {
  const [data, setData] = useState<SecurityData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError(null);
    try {
      const response = await fetch('/api/admin/security', { cache: 'no-store' });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error || 'Security diagnostics unavailable.');
      setData(json);
    } catch (err: any) { setError(err?.message || 'Security diagnostics unavailable.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  return <main className="min-h-screen bg-[#05070b] px-4 py-6 text-slate-100 sm:px-6 lg:px-8"><div className="mx-auto max-w-6xl">
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><Link href="/admin" className="text-xs text-cyan-300 hover:text-cyan-200">← Admin Operations</Link><h1 className="mt-2 text-2xl font-black">Security & Configuration</h1><p className="mt-1 text-sm text-slate-500">Runtime-derived security posture. Secrets are never returned to the browser.</p></div><button onClick={load} className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold hover:bg-white/10">Refresh</button></header>
    {loading && <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-8 text-center text-sm text-slate-400">Running live security diagnostics…</div>}
    {error && <div className="rounded-2xl border border-red-400/20 bg-red-400/5 p-5 text-sm text-red-200">{error}</div>}
    {data && <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/5 p-4"><span className="text-xs text-slate-500">Configuration coverage</span><p className="mt-2 text-2xl font-black">{data.posture.configurationCoveragePercent}%</p></div><div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><span className="text-xs text-slate-500">Environment</span><p className="mt-2 text-lg font-bold">{data.environment || 'UNKNOWN'}</p></div><div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><span className="text-xs text-slate-500">Public secret risks</span><p className="mt-2 text-2xl font-black">{data.posture.publicSecretRiskCount}</p></div><div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><span className="text-xs text-slate-500">Secure cookies</span><p className="mt-2 text-lg font-bold">{data.posture.secureCookiePolicy ? 'ENFORCED' : 'NON-PRODUCTION'}</p></div></section>
      <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><h2 className="mb-4 text-sm font-bold">Runtime configuration checks</h2><div className="grid gap-3 md:grid-cols-2">{data.checks.map((check) => <div key={check.id} className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 p-4"><div><p className="text-sm font-semibold">{check.label}</p><p className="mt-1 text-[11px] uppercase tracking-wider text-slate-600">{check.severity}</p></div><span className={`rounded-full px-3 py-1 text-[10px] font-bold ${check.configured ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-300'}`}>{check.configured ? 'CONFIGURED' : 'MISSING'}</span></div>)}</div></section>
      <section className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.03] p-5 text-xs leading-6 text-slate-400"><strong className="text-amber-200">Integrity rule:</strong> this page reports configuration posture only. A configured credential is not declared healthy until its owning service performs a real runtime verification. Secret values and credentials are intentionally never exposed.</section>
    </div>}
  </div></main>;
}
