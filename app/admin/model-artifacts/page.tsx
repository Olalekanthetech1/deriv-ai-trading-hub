'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Database, FileCheck2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';

type ArtifactModel = {
  modelId: string;
  modelKey: string;
  symbol: string;
  durationValue: number;
  durationUnit: string;
  trainingRunId: string | null;
  datasetId: string | null;
  featureSchemaVersion: string;
  artifactPresent: boolean;
  healthy: boolean;
  updatedAt?: string;
};
type Job = { jobId: string; status: string; attempts: number; workerId?: string | null; heartbeatAt?: string | null; error?: string | null; summary?: Record<string, unknown> | null } | null;

type Data = { totalProduction?: number; healthy?: number; missing?: number; models?: ArtifactModel[]; job?: Job; error?: string; success?: boolean };

function statusMeta(model: ArtifactModel) {
  if (model.healthy) return { label: 'HEALTHY', className: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300', icon: CheckCircle2 };
  if (model.artifactPresent) return { label: 'DEGRADED', className: 'border-amber-400/20 bg-amber-400/10 text-amber-300', icon: ShieldAlert };
  return { label: 'MISSING', className: 'border-red-400/20 bg-red-400/10 text-red-300', icon: XCircle };
}

export default function ModelArtifactsPage() {
  const [data, setData] = useState<Data>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/model-artifacts', { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.replace('/admin'); return; }
      if (!response.ok || !body.success) throw new Error(body.error || 'Unable to inspect artifact integrity.');
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to inspect artifact integrity.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!data.job || !['queued', 'running'].includes(data.job.status)) return;
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(timer);
  }, [data.job?.status, load]);

  async function runBackfill() {
    setRunning(true); setMessage(null); setError(null);
    try {
      const response = await fetch('/api/admin/model-artifacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'backfill' }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success) throw new Error(body.error || 'Unable to queue artifact backfill.');
      setMessage(`Backfill queued as ${body.job?.jobId || 'a maintenance job'}. The existing ML Worker will execute it.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to queue artifact backfill.');
    } finally {
      setRunning(false);
    }
  }

  const activeJob = data.job && ['queued', 'running'].includes(data.job.status) ? data.job : null;
  return <main className="min-h-screen bg-[#05070b] px-4 py-5 text-slate-100 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-[1500px]">
      <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link href="/admin" className="mb-3 inline-flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300"><ArrowLeft className="h-3.5 w-3.5" />Back to Operations</Link>
          <div className="flex items-center gap-3"><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><FileCheck2 className="h-6 w-6 text-cyan-300" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-300">Model Operations</p><h1 className="text-2xl font-black tracking-tight sm:text-3xl">Artifact Integrity & Migration</h1><p className="mt-1 text-xs text-slate-500">Durable production artifacts, lineage and controlled migration.</p></div></div>
        </div>
        <div className="flex flex-wrap gap-2"><button onClick={() => void load()} disabled={loading || running} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button><button onClick={() => void runBackfill()} disabled={running || Boolean(activeJob)} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-xs font-bold text-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"><Database className="h-4 w-4" />{activeJob ? 'Backfill Active' : 'Run Controlled Backfill'}</button></div>
      </header>

      {message && <div className="mb-5 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3 text-sm text-emerald-200">{message}</div>}
      {error && <div className="mb-5 rounded-2xl border border-red-400/20 bg-red-400/[0.06] px-4 py-3 text-sm text-red-200">{error}</div>}

      <section className="mb-6 grid gap-4 sm:grid-cols-3"><article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><p className="text-xs uppercase tracking-wider text-slate-500">Production Models</p><p className="mt-2 text-3xl font-black">{data.totalProduction ?? '—'}</p></article><article className="rounded-2xl border border-emerald-400/10 bg-emerald-400/[0.03] p-5"><p className="text-xs uppercase tracking-wider text-slate-500">Healthy Artifacts</p><p className="mt-2 text-3xl font-black text-emerald-300">{data.healthy ?? '—'}</p></article><article className="rounded-2xl border border-red-400/10 bg-red-400/[0.03] p-5"><p className="text-xs uppercase tracking-wider text-slate-500">Missing Artifacts</p><p className="mt-2 text-3xl font-black text-red-300">{data.missing ?? '—'}</p></article></section>

      {activeJob && <section className="mb-6 rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.04] p-5"><div className="flex items-center justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-cyan-300">Controlled Backfill</p><p className="mt-1 text-sm text-slate-300">Job {activeJob.jobId}</p></div><span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[10px] font-bold tracking-wider text-cyan-200">{activeJob.status.toUpperCase()}</span></div><p className="mt-3 text-xs text-slate-500">Execution boundary: existing ML Worker. No additional Render worker is required.</p></section>}

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]"><div className="border-b border-white/10 px-5 py-4"><h2 className="font-bold">Production Artifact Inventory</h2><p className="mt-1 text-xs text-slate-500">A model is healthy only when the durable artifact and required lineage metadata are present.</p></div><div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="border-b border-white/10 text-xs uppercase tracking-wider text-slate-500"><tr><th className="px-5 py-3">Model</th><th className="px-5 py-3">Asset</th><th className="px-5 py-3">Duration</th><th className="px-5 py-3">Artifact</th><th className="px-5 py-3">Lineage</th><th className="px-5 py-3">Status</th></tr></thead><tbody>{(data.models || []).map((model) => { const meta = statusMeta(model); const Icon = meta.icon; return <tr key={model.modelId} className="border-b border-white/5 last:border-0"><td className="px-5 py-4"><p className="font-semibold text-slate-200">{model.modelKey}</p><p className="text-[11px] text-slate-600">{model.modelId}</p></td><td className="px-5 py-4 text-slate-300">{model.symbol}</td><td className="px-5 py-4 text-slate-300">{model.durationValue}{model.durationUnit}</td><td className="px-5 py-4">{model.artifactPresent ? <span className="text-emerald-300">Present</span> : <span className="text-red-300">Missing</span>}</td><td className="px-5 py-4 text-xs text-slate-500"><div>run: {model.trainingRunId || '—'}</div><div>dataset: {model.datasetId || '—'}</div></td><td className="px-5 py-4"><span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wider ${meta.className}`}><Icon className="h-3.5 w-3.5" />{meta.label}</span></td></tr>; })}</tbody></table></div>{!data.models?.length && !loading && <div className="px-5 py-10 text-center text-sm text-slate-500">No production models were returned.</div>}</section>
    </div>
  </main>;
}
