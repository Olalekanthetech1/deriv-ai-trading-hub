'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, ServerCrash, XCircle } from 'lucide-react';

type TimingMap = Record<string, unknown>;
type LiveDiagnostics = { phase?: string; elapsedMs?: number; message?: string | null; updatedAt?: string; source?: string };
type TrainingModel = { model_type: string; status: string; metrics?: TimingMap; error?: string | null };
type TrainingRun = { run_id: string; asset_symbol: string; duration_value: number; duration_unit: string; status: string; models?: TrainingModel[]; created_at: string };
type AutoFailure = { value: number; unit: string; error: string };
type AutoJob = { id: string; symbol: string; status: string; requestedCount: number; completedCount: number; failedCount: number; failures?: AutoFailure[]; startedAt: string; finishedAt?: string };

const modelLabels: Record<string, string> = { xgboost: 'XGBoost', lightgbm: 'LightGBM', catboost: 'CatBoost', tcn: 'TCN', lstm: 'LSTM / GRU', transformer: 'Transformer', hmm: 'HMM Regime', isolation_forest: 'Isolation Forest' };
const unitLabels: Record<string, string> = { t: 'ticks', s: 'seconds', m: 'minutes', h: 'hours', d: 'days' };
const phaseLabels: Record<string, string> = {
  starting: 'Accepted by native runtime',
  train_partition_validated: 'Training partition validated',
  validation_partition_validated: 'Validation partition validated',
  model_fit_start: 'Model fit running',
  model_fit_complete: 'Model fit complete',
  prediction_complete: 'Validation prediction complete',
  artifact_save_start: 'Saving model artifact',
  artifact_save_complete: 'Artifact saved',
};

function seconds(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n / 1000).toFixed(1)}s` : '—';
}
function timing(metrics: TimingMap | undefined, key: string): number | null {
  const direct = Number(metrics?.[key]);
  if (Number.isFinite(direct)) return direct;
  const nested = metrics?.timings;
  const value = nested && typeof nested === 'object' ? Number((nested as Record<string, unknown>)[key]) : NaN;
  return Number.isFinite(value) ? value : null;
}
function liveDiagnostics(metrics: TimingMap | undefined): LiveDiagnostics | null {
  const value = metrics?.liveDiagnostics;
  return value && typeof value === 'object' ? value as LiveDiagnostics : null;
}
function classify(metrics: TimingMap | undefined): { label: string; tone: 'warn' | 'danger' | 'info' } | null {
  const roundTrip = timing(metrics, 'clientRoundTripMs');
  const dispatch = timing(metrics, 'daemonDispatchMs');
  const fit = timing(metrics, 'fitMs');
  const partition = timing(metrics, 'trainPartitionMs');
  const artifact = timing(metrics, 'artifactSaveMs');
  if (roundTrip == null) return null;
  if (dispatch != null && roundTrip > Math.max(30000, dispatch * 5)) return { label: 'IPC / daemon transport suspected', tone: 'warn' };
  if (fit != null && roundTrip > 30000 && fit / roundTrip > 0.7) return { label: 'Native model computation suspected', tone: 'danger' };
  if (partition != null && fit != null && partition > Math.max(30000, fit * 3)) return { label: 'Dataset preparation suspected', tone: 'warn' };
  if (artifact != null && artifact > Math.max(30000, roundTrip * 0.3)) return { label: 'Artifact/storage suspected', tone: 'warn' };
  return { label: 'No dominant bottleneck detected', tone: 'info' };
}

function ErrorBox({ message }: { message: string }) {
  return <div className="mt-3 rounded-xl border border-red-400/20 bg-red-400/[0.05] p-3 text-xs leading-5 text-red-200"><div className="mb-1 flex items-center gap-2 font-bold"><XCircle className="h-3.5 w-3.5" />Exact error</div><pre className="whitespace-pre-wrap break-words font-sans">{message}</pre></div>;
}

export default function AdminMlDiagnostics({ children }: { children: ReactNode }) {
  const [path, setPath] = useState('');
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [autoJob, setAutoJob] = useState<AutoJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);

  useEffect(() => { setPath(window.location.pathname); }, []);
  const isTraining = path === '/admin/training-pipeline';
  const isDatasetBuilder = path === '/admin/dataset-builder';
  const enabled = isTraining || isDatasetBuilder;

  async function refresh() {
    if (!enabled) return;
    setLoading(true);
    try {
      if (isTraining) {
        const response = await fetch('/api/admin/model-training', { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (response.ok) setRuns(Array.isArray(data?.runs) ? data.runs : []);
      } else {
        const response = await fetch('/api/admin/datasets?latestAutoJob=1', { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (response.ok) setAutoJob(data?.job ?? null);
      }
      setLastRefresh(Date.now());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), isDatasetBuilder ? 2500 : 2500);
    return () => window.clearInterval(timer);
  }, [enabled, isTraining, isDatasetBuilder]);

  const latestRun = runs[0];
  const latestModelFailures = useMemo(() => latestRun?.models?.filter((model) => model.status === 'failed') ?? [], [latestRun]);

  if (!enabled) return <>{children}</>;

  return <>
    <section className="mx-auto mb-4 max-w-[1500px] px-4 pt-4 sm:px-6 lg:px-8">
      <div className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.025] p-4 shadow-xl shadow-black/10">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-amber-200"><AlertTriangle className="h-4 w-4" />{isTraining ? 'Training Diagnostics' : 'Dataset Build Diagnostics'}</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">Live runtime evidence from the native daemon and persisted training state. Exact errors remain visible; live phase telemetry never converts a running/failed job into success.</p>
          </div>
          <button onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Refresh</button>
        </div>

        {isTraining ? <>
          {!latestRun ? <p className="mt-4 text-xs text-slate-600">No persisted training run is available yet.</p> : <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs"><span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-bold">{latestRun.status.toUpperCase()}</span><span className="font-semibold text-slate-300">{latestRun.asset_symbol} · {latestRun.duration_value} {unitLabels[latestRun.duration_unit] || latestRun.duration_unit}</span><span className="font-mono text-[10px] text-slate-600">{latestRun.run_id}</span></div>
            {latestRun.models?.map((model) => {
              const metrics = model.metrics;
              const live = liveDiagnostics(metrics);
              const roundTrip = timing(metrics, 'clientRoundTripMs');
              const dispatch = timing(metrics, 'daemonDispatchMs');
              const partition = timing(metrics, 'trainPartitionMs');
              const validation = timing(metrics, 'validationPartitionMs');
              const fit = timing(metrics, 'fitMs');
              const prediction = timing(metrics, 'predictionMs');
              const artifact = timing(metrics, 'artifactSaveMs');
              const total = timing(metrics, 'totalMs');
              const diagnosis = classify(metrics);
              const isRunning = model.status === 'running';
              return <div key={model.model_type} className="rounded-xl border border-white/10 bg-black/20 p-3">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between"><div className="flex items-center gap-2 text-xs font-bold"><span>{modelLabels[model.model_type] || model.model_type}</span><span className={model.status === 'completed' ? 'text-emerald-300' : model.status === 'failed' ? 'text-red-300' : 'text-cyan-300'}>{model.status}</span></div>{diagnosis && <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold ${diagnosis.tone === 'danger' ? 'border-red-400/20 bg-red-400/10 text-red-200' : diagnosis.tone === 'warn' ? 'border-amber-400/20 bg-amber-400/10 text-amber-200' : 'border-cyan-400/20 bg-cyan-400/10 text-cyan-200'}`}>{diagnosis.tone === 'danger' ? <ServerCrash className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}{diagnosis.label}</span>}</div>
                {isRunning && live && <div className="mt-3 rounded-lg border border-cyan-400/15 bg-cyan-400/[0.03] px-3 py-2"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[10px] font-bold uppercase tracking-wider text-cyan-200">Live phase: {phaseLabels[live.phase || ''] || live.phase || 'Running'}</span><span className="font-mono text-[10px] text-cyan-300">Elapsed {seconds(live.elapsedMs)}</span></div>{live.message && <p className="mt-1 text-[10px] leading-4 text-slate-400">{live.message}</p>}<p className="mt-1 text-[9px] text-slate-600">Native runtime source · updated {live.updatedAt ? new Date(live.updatedAt).toLocaleTimeString() : '—'}</p></div>}
                {metrics ? <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">{[['Round trip',roundTrip],['Daemon',dispatch],['Train partition',partition],['Validation',validation],['Model fit',fit],['Prediction',prediction],['Artifact',artifact],['Python total',total]].map(([label,value]) => <div key={String(label)} className="rounded-lg border border-white/5 bg-white/[0.02] p-2"><span className="block text-[9px] uppercase tracking-wider text-slate-600">{String(label)}</span><span className="mt-1 block text-xs font-bold text-slate-300">{seconds(value)}</span></div>)}</div> : <p className="mt-2 text-[10px] text-slate-600">No timing metrics persisted for this attempt.</p>}
                {model.error && <ErrorBox message={model.error} />}
              </div>;
            })}
            {latestModelFailures.length > 0 && <div className="rounded-xl border border-red-400/20 bg-red-400/[0.03] p-3 text-xs text-red-200"><div className="flex items-center gap-2 font-bold"><Clock3 className="h-3.5 w-3.5" />Failure evidence is preserved in the run history; no timeout is being hidden.</div></div>}
          </div>}
        </> : <>
          {!autoJob ? <p className="mt-4 text-xs text-slate-600">No persisted AUTO / Build All horizon job is available yet.</p> : <div className="mt-4">
            <div className="flex flex-wrap items-center gap-2 text-xs"><span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-bold">{autoJob.status.toUpperCase()}</span><span className="font-semibold text-slate-300">{autoJob.symbol}</span><span className="text-slate-500">{autoJob.completedCount}/{autoJob.requestedCount} completed · {autoJob.failedCount} failed</span><span className="font-mono text-[10px] text-slate-600">{autoJob.id}</span></div>
            {autoJob.failures?.length ? <div className="mt-3 space-y-2">{autoJob.failures.map((failure, index) => <div key={`${failure.value}:${failure.unit}:${index}`} className="rounded-xl border border-red-400/20 bg-red-400/[0.04] p-3"><div className="flex items-center gap-2 text-xs font-bold text-red-200"><XCircle className="h-3.5 w-3.5" />{failure.value} {unitLabels[failure.unit] || failure.unit}</div><ErrorBox message={failure.error} /></div>)}</div> : <div className="mt-3 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.03] p-3 text-xs text-emerald-200"><div className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-3.5 w-3.5" />No failed horizons recorded for the latest AUTO job.</div></div>}
          </div>}
        </>}
        {lastRefresh && <p className="mt-3 text-[10px] text-slate-700">Last diagnostic refresh: {new Date(lastRefresh).toLocaleTimeString()}</p>}
      </div>
    </section>
    {children}
  </>;
}