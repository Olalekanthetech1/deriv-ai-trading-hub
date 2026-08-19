'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, ShieldAlert, Archive } from 'lucide-react';

type Model = {
  model_id?: string;
  model_name?: string;
  symbol?: string;
  asset_display_name?: string;
  horizon_secs?: number;
  status?: string;
};

type RegistryResponse = { success?: boolean; models?: Model[]; error?: string };

export default function ProductionModelRetirementPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/ml/registry?status=production', { cache: 'no-store' });
      const data: RegistryResponse = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.replace('/admin');
        return;
      }
      if (!response.ok || data.success === false) throw new Error(data.error || `Registry returned HTTP ${response.status}.`);
      setModels(Array.isArray(data.models) ? data.models : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load production models.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const productionModels = useMemo(() => models.filter((model) => String(model.status || '').toLowerCase() === 'production'), [models]);

  const retire = async (model: Model) => {
    if (!model.model_id) return;
    const label = `${model.model_name || 'model'} ${model.asset_display_name || model.symbol || ''} ${model.horizon_secs ?? '—'}s`;
    const confirmed = window.confirm(`Retire ${label}?\n\nThis removes the model from production eligibility but preserves its registry lineage and audit history. It does not delete the training run, dataset, or artifact records.`);
    if (!confirmed) return;

    setBusy(model.model_id);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/ml/registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retire', modelId: model.model_id }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.replace('/admin');
        return;
      }
      if (!response.ok || !data.success) throw new Error(data.error || 'Model retirement failed.');
      setMessage(`${model.model_id} retired successfully.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Model retirement failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="min-h-screen bg-[#05070b] text-slate-100">
      <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3"><Archive className="h-6 w-6 text-amber-300" /></div>
            <div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">Controlled Lifecycle</p><h1 className="text-2xl font-black">Retire Production Models</h1><p className="mt-1 text-xs text-slate-500">Retirement preserves registry lineage and removes production eligibility.</p></div>
          </div>
          <div className="flex gap-2">
            <Link href="/admin/models" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300"><ArrowLeft className="h-4 w-4" />Model Operations</Link>
            <button onClick={() => void load()} disabled={loading || !!busy} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button>
          </div>
        </header>

        <div className="mb-6 rounded-2xl border border-amber-400/20 bg-amber-400/[0.05] p-4 text-sm text-amber-100">
          <div className="flex gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" /><p><strong>Controlled operation.</strong> Retirement is intentionally not deletion. Historical model, dataset, training-run, artifact and audit lineage remains persisted.</p></div>
        </div>

        {error && <div className="mb-4 rounded-2xl border border-red-400/20 bg-red-400/[0.06] p-4 text-sm text-red-200">{error}</div>}
        {message && <div className="mb-4 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4 text-sm text-emerald-200">{message}</div>}

        <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-5"><h2 className="text-base font-bold">Current Production Registry</h2><p className="mt-1 text-xs text-slate-500">Only persisted production records returned by the live registry are shown.</p></div>
          {loading ? <div className="flex justify-center py-12 text-slate-500"><RefreshCw className="h-5 w-5 animate-spin" /></div> : productionModels.length === 0 ? <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-slate-500">No active production models.</div> : <div className="space-y-3">{productionModels.map((model) => <div key={model.model_id} className="flex flex-col gap-4 rounded-xl border border-white/10 bg-black/20 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-bold text-slate-100">{model.model_name || 'Unknown model'}</p><p className="mt-1 font-mono text-[10px] text-slate-500">{model.model_id}</p><div className="mt-1 flex items-center gap-2 text-xs text-slate-400"><span>{model.asset_display_name || model.symbol || '—'} · {model.horizon_secs ?? '—'}s</span><span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-emerald-300"><span className="h-1 w-1 rounded-full bg-emerald-400 animate-pulse" />PRODUCTION</span></div></div><button onClick={() => void retire(model)} disabled={busy === model.model_id} className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-2 text-xs font-bold text-amber-200 hover:bg-amber-400/15 disabled:opacity-50">{busy === model.model_id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}Retire</button></div>)}</div>}
        </section>
      </div>
    </main>
  );
}
