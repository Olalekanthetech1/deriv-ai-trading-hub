'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, GitBranch, History, RefreshCw, Save, ShieldCheck, SlidersHorizontal, Database, AlertTriangle, Cpu, Layers, Power, ToggleLeft, ToggleRight, Check } from 'lucide-react';

type PipelineConfig = {
  pipelineVersion: string;
  canonicalFeatureWindowTicks: number;
  defaultHorizonTicks: number;
  maxHorizonTicks: number;
  featureWindows: { micro: number; short: number; medium: number; macro: number };
  regimeThreshold: number;
  digitPrecision: number;
  syntheticSymbolPrefixes: string[];
  featureOrder: string[];
  splitRatios: { train: number; validation: number; test: number };
  splitGapMultiplier: number;
  normalizationMethod: 'zscore';
  normalizationEpsilon: number;
};

type StoredConfig = {
  id: string;
  version: number;
  status: string;
  config: PipelineConfig;
  configHash: string;
  featureSchemaVersion: string;
  createdBy: string | null;
  createdAt: string;
  activatedAt: string | null;
};

type DurationFeaturePolicy = {
  mode: string;
  baselineTopology: PipelineConfig['featureWindows'];
  examples: Array<{ value: number; unit: 't' | 's' | 'm' | 'h' | 'd'; durationSeconds: number | null; featureWindows: PipelineConfig['featureWindows'] }>;
};

type EnsembleControls = {
  enableRegimeModel: boolean;
  enableAnomalyModel: boolean;
  enableDeepSequentialModels: boolean;
  fallbackBehavior: 'graceful_degrade' | 'strict_require';
  updatedAt: string | null;
  updatedBy: string | null;
  source: 'database' | 'default';
};

type ApiResponse = {
  success?: boolean;
  active?: { config: PipelineConfig; source: string; version: number | null; configHash: string; featureSchemaVersion: string };
  ensembleControls?: EnsembleControls;
  history?: StoredConfig[];
  durationFeaturePolicy?: DurationFeaturePolicy;
  canonical?: { featureCount: number; featureOrder: string[]; featureWindows: PipelineConfig['featureWindows']; canonicalFeatureWindowTicks: number };
  error?: string;
};

function numberValue(value: string, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function formatDate(value: string | null) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(); }
function durationLabel(value: number, unit: DurationFeaturePolicy['examples'][number]['unit']) { return `${value} ${unit === 't' ? 'tick' : unit === 's' ? 'seconds' : unit === 'm' ? 'minute' : unit === 'h' ? 'hour' : 'day'}${value === 1 ? '' : unit === 't' ? 's' : 's'}`; }

export default function MlConfigPage() {
  const [config, setConfig] = useState<PipelineConfig | null>(null);
  const [ensembleControls, setEnsembleControls] = useState<EnsembleControls>({
    enableRegimeModel: false,
    enableAnomalyModel: false,
    enableDeepSequentialModels: true,
    fallbackBehavior: 'graceful_degrade',
    updatedAt: null,
    updatedBy: null,
    source: 'default',
  });
  const [history, setHistory] = useState<StoredConfig[]>([]);
  const [policy, setPolicy] = useState<DurationFeaturePolicy | null>(null);
  const [source, setSource] = useState<string>('');
  const [version, setVersion] = useState<number | null>(null);
  const [hash, setHash] = useState('');
  const [schemaVersion, setSchemaVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ensembleSaving, setEnsembleSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch('/api/admin/ml-config', { cache: 'no-store' });
      const data: ApiResponse = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.replace('/admin'); return; }
      if (!response.ok || data.success === false || !data.active?.config) throw new Error(data.error || 'Unable to load ML configuration.');
      setConfig(data.active.config); 
      setHistory(Array.isArray(data.history) ? data.history : []); 
      setPolicy(data.durationFeaturePolicy ?? null);
      if (data.ensembleControls) {
        setEnsembleControls(data.ensembleControls);
      }
      setSource(data.active.source || ''); 
      setVersion(data.active.version ?? null); 
      setHash(data.active.configHash || ''); 
      setSchemaVersion(data.active.featureSchemaVersion || '');
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load ML configuration.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const saveEnsembleControls = async (patch: Partial<EnsembleControls>) => {
    const updatedPayload = { ...ensembleControls, ...patch };
    setEnsembleControls(updatedPayload);
    setEnsembleSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/ml-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_ensemble_controls',
          enableRegimeModel: updatedPayload.enableRegimeModel,
          enableAnomalyModel: updatedPayload.enableAnomalyModel,
          enableDeepSequentialModels: updatedPayload.enableDeepSequentialModels,
          fallbackBehavior: updatedPayload.fallbackBehavior,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.replace('/admin'); return; }
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to update ensemble analysis controls.');
      if (data.ensembleControls) {
        setEnsembleControls(data.ensembleControls);
      }
      setMessage('Ensemble Analysis Controls saved dynamically! Changes take effect immediately across inference pipelines.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update ensemble analysis controls.');
    } finally {
      setEnsembleSaving(false);
    }
  };

  const generate = async () => {
    if (!config) return; setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch('/api/admin/ml-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'generate', config }) });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.replace('/admin'); return; }
      if (!response.ok || !data.success) throw new Error(data.error || 'Configuration generation failed.');
      setMessage(`Generated version ${data.generated?.version ?? '—'} and stored it as a draft. Activate it from the version history.`); await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Configuration generation failed.'); }
    finally { setBusy(false); }
  };

  const activate = async (id: string) => {
    if (!window.confirm('Activate this ML pipeline configuration? The current active version will be archived.')) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch('/api/admin/ml-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'activate', id }) });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.replace('/admin'); return; }
      if (!response.ok || !data.success) throw new Error(data.error || 'Configuration activation failed.');
      setMessage(`Activated configuration version ${data.activated?.version ?? '—'}. Runtime cache was reloaded.`); await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Configuration activation failed.'); }
    finally { setBusy(false); }
  };

  const update = (patch: Partial<PipelineConfig>) => setConfig((current) => current ? { ...current, ...patch } : current);
  const updateSplit = (key: keyof PipelineConfig['splitRatios'], value: string) => setConfig((current) => current ? { ...current, splitRatios: { ...current.splitRatios, [key]: numberValue(value, current.splitRatios[key]) } } : current);

  return <main className="min-h-screen bg-[#05070b] text-slate-100">
    <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3"><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><SlidersHorizontal className="h-6 w-6 text-cyan-300" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">Operations Center · ML</p><h1 className="text-2xl font-black tracking-tight sm:text-3xl">ML Pipeline & Ensemble Controls</h1><p className="mt-1 text-xs text-slate-500">Dynamically activate or deactivate models (Regime HMM, Anomaly Forest, Deep Seq) and configure pipeline parameters.</p></div></div>
        <div className="flex flex-wrap gap-2"><Link href="/admin" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10"><ArrowLeft className="h-4 w-4" />Operations Center</Link><button onClick={() => load()} disabled={loading || busy} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button></div>
      </header>

      {error && <div className="mb-5 flex items-start gap-3 rounded-2xl border border-red-400/20 bg-red-400/[0.06] px-4 py-3 text-sm text-red-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
      {message && <div className="mb-5 flex items-start gap-3 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3 text-sm text-emerald-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{message}</div>}

      {/* Model Activation & Ensemble Analysis Controls */}
      <section className="mb-6 rounded-3xl border border-cyan-500/20 bg-cyan-950/10 p-6 backdrop-blur-xl">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 p-2.5">
              <Cpu className="h-5 w-5 text-cyan-300" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-100">Ensemble Analysis Model Activation Toggles</h2>
              <p className="text-xs text-slate-400">Control which specialized sub-models are required or bypassed during real-time signal analysis & prediction.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono text-slate-500">
              Source: <span className="text-cyan-300 font-semibold">{ensembleControls.source}</span>
            </span>
            {ensembleControls.updatedAt && (
              <span className="text-[10px] text-slate-600">
                · Updated {new Date(ensembleControls.updatedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* Regime Model (HMM) Toggle */}
          <div className={`flex flex-col justify-between rounded-2xl border p-5 transition-all ${ensembleControls.enableRegimeModel ? 'border-emerald-500/30 bg-emerald-500/[0.04]' : 'border-amber-500/20 bg-amber-500/[0.03]'}`}>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Regime Classification</span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold ${ensembleControls.enableRegimeModel ? 'bg-emerald-400/15 text-emerald-300 border border-emerald-400/30' : 'bg-amber-400/15 text-amber-300 border border-amber-400/30'}`}>
                  {ensembleControls.enableRegimeModel ? 'REQUIRED & ACTIVE' : 'BYPASSED (DEACTIVATED)'}
                </span>
              </div>
              <h3 className="mt-2 text-base font-bold text-slate-100">Gaussian HMM Regime Model</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {ensembleControls.enableRegimeModel
                  ? 'Ensemble strictly enforces an authoritative trained HMM artifact. If missing, analysis is halted.'
                  : 'Regime model requirement is bypassed. Analysis executes smoothly using directional models with neutral regime routing.'}
              </p>
            </div>
            <div className="mt-5 pt-4 border-t border-white/10 flex items-center justify-between">
              <span className="text-xs text-slate-400">Model Requirement:</span>
              <button
                type="button"
                onClick={() => void saveEnsembleControls({ enableRegimeModel: !ensembleControls.enableRegimeModel })}
                disabled={ensembleSaving}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                  ensembleControls.enableRegimeModel
                    ? 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'
                    : 'bg-amber-400/20 text-amber-300 border border-amber-400/30 hover:bg-amber-400/30'
                }`}
              >
                {ensembleControls.enableRegimeModel ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                {ensembleControls.enableRegimeModel ? 'Active (Strict)' : 'Deactivated (Bypass)'}
              </button>
            </div>
          </div>

          {/* Anomaly Model (Isolation Forest) Toggle */}
          <div className={`flex flex-col justify-between rounded-2xl border p-5 transition-all ${ensembleControls.enableAnomalyModel ? 'border-emerald-500/30 bg-emerald-500/[0.04]' : 'border-slate-500/20 bg-slate-500/[0.03]'}`}>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Anomaly Detection</span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold ${ensembleControls.enableAnomalyModel ? 'bg-emerald-400/15 text-emerald-300 border border-emerald-400/30' : 'bg-slate-400/15 text-slate-300 border border-slate-400/30'}`}>
                  {ensembleControls.enableAnomalyModel ? 'REQUIRED & ACTIVE' : 'BYPASSED (DEACTIVATED)'}
                </span>
              </div>
              <h3 className="mt-2 text-base font-bold text-slate-100">Isolation Forest Anomaly Model</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {ensembleControls.enableAnomalyModel
                  ? 'Ensemble strictly enforces an authoritative trained Isolation Forest artifact to gate anomalous market states.'
                  : 'Anomaly detection requirement is bypassed. Anomaly score defaults to nominal low risk (0%).'}
              </p>
            </div>
            <div className="mt-5 pt-4 border-t border-white/10 flex items-center justify-between">
              <span className="text-xs text-slate-400">Model Requirement:</span>
              <button
                type="button"
                onClick={() => void saveEnsembleControls({ enableAnomalyModel: !ensembleControls.enableAnomalyModel })}
                disabled={ensembleSaving}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                  ensembleControls.enableAnomalyModel
                    ? 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'
                    : 'bg-white/10 text-slate-300 border border-white/20 hover:bg-white/20'
                }`}
              >
                {ensembleControls.enableAnomalyModel ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                {ensembleControls.enableAnomalyModel ? 'Active (Strict)' : 'Deactivated (Bypass)'}
              </button>
            </div>
          </div>

          {/* Deep Sequential Models Toggle */}
          <div className={`flex flex-col justify-between rounded-2xl border p-5 transition-all ${ensembleControls.enableDeepSequentialModels ? 'border-cyan-500/30 bg-cyan-500/[0.04]' : 'border-slate-500/20 bg-slate-500/[0.03]'}`}>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Sequential Architectures</span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold ${ensembleControls.enableDeepSequentialModels ? 'bg-cyan-400/15 text-cyan-300 border border-cyan-400/30' : 'bg-slate-400/15 text-slate-300 border border-slate-400/30'}`}>
                  {ensembleControls.enableDeepSequentialModels ? 'ENABLED' : 'DISABLED'}
                </span>
              </div>
              <h3 className="mt-2 text-base font-bold text-slate-100">Deep Sequential (TCN / LSTM / Trans.)</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {ensembleControls.enableDeepSequentialModels
                  ? 'Sequential deep learning models are evaluated when promoted artifacts exist.'
                  : 'Sequential deep models are omitted from ensemble inference; only tabular models (CatBoost, XGBoost, etc.) are polled.'}
              </p>
            </div>
            <div className="mt-5 pt-4 border-t border-white/10 flex items-center justify-between">
              <span className="text-xs text-slate-400">Sequential Inference:</span>
              <button
                type="button"
                onClick={() => void saveEnsembleControls({ enableDeepSequentialModels: !ensembleControls.enableDeepSequentialModels })}
                disabled={ensembleSaving}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                  ensembleControls.enableDeepSequentialModels
                    ? 'bg-cyan-400 text-slate-950 hover:bg-cyan-300'
                    : 'bg-white/10 text-slate-300 border border-white/20 hover:bg-white/20'
                }`}
              >
                {ensembleControls.enableDeepSequentialModels ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                {ensembleControls.enableDeepSequentialModels ? 'Enabled' : 'Disabled'}
              </button>
            </div>
          </div>
        </div>
      </section>

      {loading || !config ? <div className="flex items-center justify-center py-20 text-sm text-slate-500"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading persistent configuration…</div> : <>
        <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><p className="text-xs uppercase tracking-wider text-slate-500">Active version</p><p className="mt-1 text-2xl font-black">{version ?? '—'}</p><p className="mt-2 text-[11px] text-slate-500">Source: {source || '—'}</p></article>
          <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><p className="text-xs uppercase tracking-wider text-slate-500">Feature schema</p><p className="mt-1 text-2xl font-black">{config.featureOrder.length}</p><p className="mt-2 font-mono text-[10px] text-slate-500 break-all">{schemaVersion}</p></article>
          <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><p className="text-xs uppercase tracking-wider text-slate-500">Base topology</p><p className="mt-1 text-2xl font-black">5 → 25 → 100 → 300</p><p className="mt-2 text-[11px] text-slate-500">Baseline only. Training resolves the actual topology from the Deriv duration.</p></article>
          <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><p className="text-xs uppercase tracking-wider text-slate-500">Configuration fingerprint</p><p className="mt-1 font-mono text-xs break-all text-cyan-200">{hash || '—'}</p><p className="mt-2 text-[11px] text-slate-500">Used for reproducibility and lineage.</p></article>
        </section>

        {policy && <section className="mb-6 rounded-2xl border border-cyan-400/10 bg-cyan-400/[0.025] p-5"><div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-base font-bold">Resolved duration-aware feature topology</h2><p className="mt-1 text-xs leading-5 text-slate-500">The 300-tick value is no longer treated as universal. The resolver scales the four feature windows deterministically from the selected Deriv duration and persists the resolved topology with each dataset/model lineage.</p></div><span className="font-mono text-[10px] text-cyan-300">{policy.mode}</span></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">{policy.examples.map((example) => <div key={`${example.value}${example.unit}`} className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-[11px] font-semibold text-slate-300">{durationLabel(example.value, example.unit)}</p><p className="mt-2 font-mono text-xs text-cyan-200">{example.featureWindows.micro} → {example.featureWindows.short} → {example.featureWindows.medium} → {example.featureWindows.macro}</p><p className="mt-1 text-[9px] text-slate-600">micro · short · medium · macro</p></div>)}</div></section>}

        <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
          <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <div className="mb-5 flex items-center justify-between"><div><h2 className="text-base font-bold">Operational Controls</h2><p className="mt-1 text-xs text-slate-500">Only operational parameters are editable. Feature definitions, ordering and duration-aware feature topology remain code-registry controlled.</p></div><ShieldCheck className="h-5 w-5 text-emerald-300" /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-xs text-slate-400">Default horizon (ticks)<input type="number" min="1" value={config.defaultHorizonTicks} onChange={(e) => update({ defaultHorizonTicks: numberValue(e.target.value, config.defaultHorizonTicks) })} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40" /></label>
              <label className="text-xs text-slate-400">Maximum horizon (ticks)<input type="number" min={config.defaultHorizonTicks} value={config.maxHorizonTicks} onChange={(e) => update({ maxHorizonTicks: numberValue(e.target.value, config.maxHorizonTicks) })} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40" /></label>
              <label className="text-xs text-slate-400">Regime threshold<input type="number" step="0.0001" value={config.regimeThreshold} onChange={(e) => update({ regimeThreshold: numberValue(e.target.value, config.regimeThreshold) })} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40" /></label>
              <label className="text-xs text-slate-400">Digit precision<input type="number" min="0" value={config.digitPrecision} onChange={(e) => update({ digitPrecision: numberValue(e.target.value, config.digitPrecision) })} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40" /></label>
              <label className="text-xs text-slate-400">Split gap multiplier<input type="number" min="1" value={config.splitGapMultiplier} onChange={(e) => update({ splitGapMultiplier: numberValue(e.target.value, config.splitGapMultiplier) })} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40" /></label>
              <label className="text-xs text-slate-400">Normalization epsilon<input type="number" step="any" min="0.000000000001" value={config.normalizationEpsilon} onChange={(e) => update({ normalizationEpsilon: numberValue(e.target.value, config.normalizationEpsilon) })} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40" /></label>
            </div>
            <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs font-semibold text-slate-300">Chronological split ratios</p><div className="mt-3 grid gap-3 sm:grid-cols-3"><label className="text-[11px] text-slate-500">Train<input type="number" step="0.01" min="0.01" max="0.99" value={config.splitRatios.train} onChange={(e) => updateSplit('train', e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-xs text-slate-100" /></label><label className="text-[11px] text-slate-500">Validation<input type="number" step="0.01" min="0.01" max="0.99" value={config.splitRatios.validation} onChange={(e) => updateSplit('validation', e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-xs text-slate-100" /></label><label className="text-[11px] text-slate-500">Test<input type="number" step="0.01" min="0.01" max="0.99" value={config.splitRatios.test} onChange={(e) => updateSplit('test', e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-xs text-slate-100" /></label></div></div>
            <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs font-semibold text-slate-300">Synthetic symbol prefixes</p><input value={config.syntheticSymbolPrefixes.join(', ')} onChange={(e) => update({ syntheticSymbolPrefixes: e.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} className="mt-3 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-xs text-slate-100" /><p className="mt-2 text-[10px] text-slate-600">Comma-separated. These are operational routing rules, not feature definitions.</p></div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-[10px] uppercase tracking-wider text-slate-500">Active config baseline</p><p className="mt-2 font-mono text-sm text-cyan-200">micro={config.featureWindows.micro} · short={config.featureWindows.short} · medium={config.featureWindows.medium} · macro={config.featureWindows.macro}</p><p className="mt-1 text-[10px] text-slate-600">This is the persisted base config; duration datasets carry their resolved topology separately.</p></div><div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-[10px] uppercase tracking-wider text-slate-500">Normalization</p><p className="mt-2 text-sm font-semibold text-emerald-300">{config.normalizationMethod.toUpperCase()}</p></div></div>
            <div className="mt-6 flex flex-wrap gap-2"><button onClick={() => void generate()} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-xs font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-60"><Save className="h-4 w-4" />{busy ? 'Processing…' : 'Generate Draft Configuration'}</button></div>
          </section>
          <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-5 flex items-center gap-2"><History className="h-5 w-5 text-cyan-300" /><div><h2 className="text-base font-bold">Version History</h2><p className="mt-1 text-xs text-slate-500">Every generated configuration is immutable. Activation changes only the active pointer.</p></div></div><div className="space-y-3">{history.length === 0 ? <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-xs text-slate-600">No persisted versions yet.</div> : history.map((item) => <article key={item.id} className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-bold">Version {item.version}</p><p className="mt-1 font-mono text-[10px] text-slate-600 break-all">{item.configHash}</p></div><span className={`rounded-full border px-2 py-1 text-[9px] font-bold tracking-wider ${item.status === 'active' ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : item.status === 'draft' ? 'border-cyan-400/20 bg-cyan-400/10 text-cyan-200' : 'border-white/10 bg-white/5 text-slate-500'}`}>{item.status.toUpperCase()}</span></div><div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-500"><span>Created: {formatDate(item.createdAt)}</span><span>Activated: {formatDate(item.activatedAt)}</span><span>Schema: {item.featureSchemaVersion}</span><span>By: {item.createdBy || '—'}</span></div>{item.status !== 'active' && <button onClick={() => void activate(item.id)} disabled={busy} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-[10px] font-bold text-emerald-300 hover:bg-emerald-400/10 disabled:opacity-50"><GitBranch className="h-3.5 w-3.5" />Activate Version</button>}</article>)}</div></section>
        </div>
        <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="flex items-start gap-3"><Database className="mt-0.5 h-5 w-5 text-cyan-300" /><div><h2 className="text-sm font-bold">Deterministic schema boundary</h2><p className="mt-1 text-xs leading-5 text-slate-500">The dashboard cannot edit the 37 feature definitions or their order. Those remain owned by the canonical feature-definition registry. Duration-aware windows are resolved by a single code-owned policy and included in dataset/training lineage, while the active configuration controls validated operational parameters.</p></div></div></section>
      </>}
    </div>
  </main>;
}
