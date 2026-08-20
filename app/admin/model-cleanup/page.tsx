'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';

type Model = {
  model_id: string;
  model_family: string;
  version: string;
  asset_symbol: string;
  asset_class: string;
  horizon_ticks: number;
  status: string;
  training_run_id?: string | null;
  metrics?: Record<string, unknown> | null;
  updated_at?: string;
};

export default function ModelCleanupPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch('/api/admin/model-cleanup', { cache: 'no-store' });
      if (response.status === 401) { window.location.replace('/admin'); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Cleanup API returned HTTP ${response.status}.`);
      setModels(Array.isArray(body.models) ? body.models : []);
      setSelected([]);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load cleanup candidates.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const allSelected = useMemo(() => models.length > 0 && selected.length === models.length, [models.length, selected.length]);

  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);

  const cleanup = async () => {
    if (!selected.length) return;
    const isAll = allSelected || selected.length === models.length;
    const chosenCount = selected.length;
    const confirmed = window.confirm(`PERMANENTLY DELETE ${chosenCount} candidate/staging model registry record(s)?\n\nProduction models cannot be selected. Database-linked child records may be cascaded or detached according to the existing schema. External artifact files will NOT be deleted.\n\nThis action is intended to clear old candidates before a new training run.`);
    if (!confirmed) return;

    setBusy(true); setError(null); setMessage(null);
    try {
      if (isAll) {
        // Fast atomic server-side purge for all candidates
        const response = await fetch('/api/admin/model-cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cleanup', purgeAllCandidates: true, confirm: true, force: true }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.success === false) throw new Error(body.error || `Cleanup returned HTTP ${response.status}.`);
        setMessage(`Successfully purged all ${body.deletedCount} old candidate/staging model record(s).`);
      } else {
        // Chunk deletions into safe batches of 500
        const CHUNK_SIZE = 500;
        let totalDeleted = 0;
        for (let i = 0; i < selected.length; i += CHUNK_SIZE) {
          const chunk = selected.slice(i, i + CHUNK_SIZE);
          const response = await fetch('/api/admin/model-cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'cleanup', modelIds: chunk, confirm: true, force: true }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || body.success === false) throw new Error(body.error || `Cleanup chunk ${Math.floor(i / CHUNK_SIZE) + 1} failed.`);
          totalDeleted += (body.deletedCount || chunk.length);
        }
        setMessage(`Successfully removed ${totalDeleted} selected candidate model registry record(s).`);
      }
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Model cleanup failed.'); }
    finally { setBusy(false); }
  };

  return <main className="min-h-screen bg-[#05070b] text-slate-100"><div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8">
    <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-3"><Trash2 className="h-6 w-6 text-rose-300" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-rose-300">Model Operations · Maintenance</p><h1 className="text-2xl font-black sm:text-3xl">Model Cleanup</h1><p className="mt-1 text-xs text-slate-500">Remove obsolete candidate/staging registry records before a clean training cycle.</p></div></div><div className="flex gap-2"><Link href="/admin/champion-challenger" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300"><ArrowLeft className="h-4 w-4" />Champion / Challenger</Link><button onClick={() => void load()} disabled={loading || busy} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button></div></header>
    <div className="mb-5 rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-4 text-sm text-amber-100"><div className="flex gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" /><div><strong>Safety boundary</strong><p className="mt-1 text-xs leading-5 text-amber-200/70">Only <b>candidate</b> and <b>staging</b> records are eligible. Production models are protected server-side. Training history is retained. Database-linked child rows follow their existing foreign-key rules. External artifact objects are intentionally not deleted by this operation.</p></div></div></div>
    {error && <div className="mb-4 rounded-2xl border border-rose-400/20 bg-rose-400/5 p-4 text-sm text-rose-200">{error}</div>}
    {message && <div className="mb-4 rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-sm text-emerald-200">{message}</div>}
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.025] p-4"><div><p className="text-xs text-slate-500">Cleanup candidates</p><p className="text-2xl font-black">{models.length}</p></div><div className="flex gap-2"><button onClick={() => setSelected(allSelected ? [] : models.map(model => model.model_id))} disabled={!models.length || busy} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300">{allSelected ? 'Clear selection' : 'Select all candidates'}</button><button onClick={() => void cleanup()} disabled={!selected.length || busy} className="rounded-xl bg-rose-500 px-4 py-2 text-xs font-bold text-white disabled:opacity-40">{busy ? 'Cleaning…' : `Delete selected (${selected.length})`}</button></div></div>
    {loading && !models.length ? <div className="p-12 text-center text-slate-500">Loading live registry…</div> : !models.length ? <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-12 text-center text-sm text-slate-500">No candidate or staging models remain.</div> : <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.025]"><table className="w-full min-w-[850px] text-left text-xs"><thead className="border-b border-white/10 text-slate-500"><tr><th className="p-4">Select</th><th className="p-4">Model</th><th className="p-4">Asset</th><th className="p-4">Horizon</th><th className="p-4">Status</th><th className="p-4">Training Run</th><th className="p-4">Updated</th></tr></thead><tbody>{models.map(model => <tr key={model.model_id} className="border-b border-white/5 last:border-0"><td className="p-4"><input type="checkbox" checked={selected.includes(model.model_id)} onChange={() => toggle(model.model_id)} disabled={busy} /></td><td className="p-4"><div className="font-semibold text-slate-200">{model.model_family}</div><div className="mt-1 font-mono text-[10px] text-slate-600">{model.model_id}</div></td><td className="p-4 text-slate-300">{model.asset_symbol}</td><td className="p-4 text-slate-300">{model.horizon_ticks} ticks</td><td className="p-4"><span className="rounded-full border border-amber-400/20 bg-amber-400/5 px-2 py-1 text-[10px] uppercase text-amber-300">{model.status}</span></td><td className="p-4 font-mono text-[10px] text-slate-600">{model.training_run_id || '—'}</td><td className="p-4 text-slate-500">{model.updated_at ? new Date(model.updated_at).toLocaleString() : '—'}</td></tr>)}</tbody></table></div>}
  </div></main>;
}
