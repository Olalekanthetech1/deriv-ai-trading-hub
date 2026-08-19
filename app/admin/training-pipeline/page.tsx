'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BrainCircuit, CheckCircle2, Database, Filter, Layers, Layers3, Play, RefreshCw, ShieldCheck, Trash2, XCircle, Zap, Activity } from 'lucide-react';
import dynamic from 'next/dynamic';
import { UnifiedMultiHorizonTrainingPanel } from '@/components/admin/unified-multi-horizon-training-panel';
import { StandardMultiModelTrainingPanel } from '@/components/admin/standard-multi-model-training-panel';
import { adminFetch } from '@/lib/admin-client-auth';
const MLWorkerObservability = dynamic(() => import('@/components/admin/ml-worker-observability').then(mod => mod.MLWorkerObservability), { ssr: false });

type ModelKey = 'xgboost'|'lightgbm'|'catboost'|'tcn'|'lstm'|'hmm'|'isolation_forest';
type Dataset = { id:string; name:string; asset_symbol:string; raw_asset_symbol?:string; duration_value:number; duration_unit:string; duration_seconds:number|null; horizon_ticks:number; status:string; leakage_check_passed:boolean; sample_count:number; train_count:number };
type ModelRun = { model_type:string; status:string; model_id?:string; metrics?:Record<string,unknown>; error?:string; heartbeat_at?:string|null };
type Run = { run_id:string; dataset_id:string; asset_symbol:string; raw_asset_symbol?:string; duration_value:number; duration_unit:string; duration_seconds:number|null; horizon_ticks:number; status:string; completed_models:number; failed_models:number; requested_models:ModelKey[]; models:ModelRun[]; created_at:string; completed_at?:string|null; heartbeat_at?:string|null };
type BatchItem = { dataset_id:string; status:string; requested_models:ModelKey[]; skipped_models:ModelKey[]; completed_models:number; failed_models:number; asset_symbol?:string; duration_value?:number; duration_unit?:string; horizon_ticks?:number; run_id?:string|null; error?:string|null };
type Batch = { batch_id:string; status:string; requested_datasets:number; requested_models:number; total_jobs:number; completed_jobs:number; failed_jobs:number; skipped_jobs:number; heartbeat_at?:string|null; completed_at?:string|null; error?:string|null; items:BatchItem[] };
type HorizonOption = { key:string; value:number; unit:string; seconds:number; label:string };
type TimeframeUnit = 't'|'s'|'m'|'h';

const MODEL_LABELS: Record<ModelKey,string> = { xgboost:'XGBoost', lightgbm:'LightGBM', catboost:'CatBoost', tcn:'TCN', lstm:'LSTM / GRU', hmm:'HMM Regime', isolation_forest:'Isolation Forest' };
const ALL_MODELS = Object.keys(MODEL_LABELS) as ModelKey[];
const UNIT_LABELS: Record<string,string> = { t:'ticks', s:'seconds', m:'minutes', h:'hours', d:'days' };
const UNIT_SHORT: Record<string,string> = { t:'t', s:'s', m:'m', h:'h', d:'d' };
const TIMEFRAME_UNITS: Array<{ key:TimeframeUnit; short:string; label:string }> = [
  { key:'t', short:'T', label:'Ticks' },
  { key:'s', short:'S', label:'Seconds' },
  { key:'m', short:'M', label:'Minutes' },
  { key:'h', short:'H', label:'Hours' },
];
const durationText = (value:number, unit:string) => `${value} ${UNIT_LABELS[unit] || unit}`;
const metric = (metrics?:Record<string,unknown>) => { const value = Number(metrics?.accuracy); return Number.isFinite(value) ? `${value.toFixed(2)}%` : '—'; };
const failureStatus = (status:string) => ['failed','timed_out','cancelled'].includes(status);

function durationSeconds(dataset: Pick<Dataset,'duration_value'|'duration_unit'|'duration_seconds'>) {
  if (Number.isFinite(dataset.duration_seconds)) return Number(dataset.duration_seconds);
  const value = Number(dataset.duration_value);
  switch (dataset.duration_unit) {
    case 't': return value;
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return value;
  }
}

function statusClass(status:string) {
  if (status === 'completed') return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300';
  if (status === 'partial') return 'border-amber-400/20 bg-amber-400/10 text-amber-200';
  if (failureStatus(status)) return 'border-red-400/20 bg-red-400/10 text-red-200';
  return 'border-cyan-400/20 bg-cyan-400/10 text-cyan-200';
}

function TrainingPipelineContent() {
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get('tab') as 'standard' | 'unified' | 'worker') || 'unified';
  const initialDatasetId = searchParams.get('datasetId') || '';

  const [pipelineTab, setPipelineTab] = useState<'standard' | 'unified' | 'worker'>(initialTab);
  const [datasets,setDatasets] = useState<Dataset[]>([]);
  const [runs,setRuns] = useState<Run[]>([]);
  const [selectedDataset,setSelectedDataset] = useState('');
  const [selectedDatasets,setSelectedDatasets] = useState<string[]>([]);
  const [models,setModels] = useState<ModelKey[]>(ALL_MODELS);
  const [skipCompleted,setSkipCompleted] = useState(true);
  const [retryFailed,setRetryFailed] = useState(false);
  const [batch,setBatch] = useState<Batch|null>(null);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [message,setMessage] = useState<string|null>(null);
  const [assetFilter,setAssetFilter] = useState('all');
  const [timeframeUnit,setTimeframeUnit] = useState<TimeframeUnit>('s');
  const [horizonFilter,setHorizonFilter] = useState('all');

  const readyDatasets = useMemo(() => datasets.filter((d) => d.status === 'completed' && d.leakage_check_passed), [datasets]);
  const assetOptions = useMemo(() => Array.from(new Map(readyDatasets.map((d) => [d.asset_symbol, d])).values()).sort((a,b) => a.asset_symbol.localeCompare(b.asset_symbol)), [readyDatasets]);
  const horizonOptions = useMemo<HorizonOption[]>(() => {
    const map = new Map<string,HorizonOption>();
    for (const dataset of readyDatasets) {
      const unit = String(dataset.duration_unit || '').toLowerCase();
      if (!['t','s','m','h'].includes(unit)) continue;
      const value = Number(dataset.duration_value);
      if (!Number.isFinite(value) || value <= 0) continue;
      const seconds = durationSeconds(dataset);
      const key = `${unit}:${value}`;
      if (!map.has(key)) map.set(key, { key, value, unit, seconds, label: `${value}${UNIT_SHORT[unit] || unit}` });
    }
    return [...map.values()].sort((a,b) => a.seconds - b.seconds || a.label.localeCompare(b.label));
  }, [readyDatasets]);
  const availableUnits = useMemo(() => new Set(horizonOptions.map((option) => option.unit)), [horizonOptions]);
  const visibleHorizonOptions = useMemo(() => horizonOptions.filter((option) => option.unit === timeframeUnit), [horizonOptions, timeframeUnit]);
  const filteredDatasets = useMemo(() => readyDatasets.filter((dataset) => {
    const assetMatch = assetFilter === 'all' || dataset.asset_symbol === assetFilter;
    const unitMatch = String(dataset.duration_unit || '').toLowerCase() === timeframeUnit;
    const exactHorizonMatch = horizonFilter === 'all' || `${String(dataset.duration_unit || '').toLowerCase()}:${Number(dataset.duration_value)}` === horizonFilter;
    return assetMatch && unitMatch && exactHorizonMatch;
  }), [readyDatasets, assetFilter, timeframeUnit, horizonFilter]);
  const selected = useMemo(() => datasets.find((d) => d.id === selectedDataset), [datasets, selectedDataset]);
  const runningRuns = useMemo(() => runs.filter((run) => run.status === 'running'), [runs]);
  const failedRunCount = useMemo(() => runs.filter((run) => failureStatus(run.status)).length, [runs]);
  const batchActive = !!batch && ['queued','running','partial'].includes(batch.status);
  const estimatedJobs = selectedDatasets.length * models.length;
  const allFilteredSelected = filteredDatasets.length > 0 && filteredDatasets.every((dataset) => selectedDatasets.includes(dataset.id));

  async function load() {
    setLoading(true); setError(null);
    try {
      const [datasetsRes,runsRes] = await Promise.all([adminFetch('/api/admin/datasets?eligibleForTraining=1',{cache:'no-store'}),adminFetch('/api/admin/model-training',{cache:'no-store'})]);
      const datasetsData = await datasetsRes.json().catch(() => ({}));
      const runsData = await runsRes.json().catch(() => ({}));
      const next = Array.isArray(datasetsData?.datasets) ? datasetsData.datasets as Dataset[] : [];
      const runList = Array.isArray(runsData?.runs) ? runsData.runs as Run[] : [];
      if (datasetsRes.ok) {
        setDatasets(next);
        setSelectedDataset((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id || '');
        setSelectedDatasets((current) => current.filter((id) => next.some((item) => item.id === id)));
      }
      if (runsRes.ok) setRuns(runList);
      const failures:string[] = [];
      if (!datasetsRes.ok) failures.push(`Datasets: ${datasetsData?.error || 'unable to load training datasets.'}`);
      if (!runsRes.ok) failures.push(`Training runs: ${runsData?.error || 'unable to load training run diagnostics.'}`);
      setError(failures.length ? failures.join(' ') : null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load model training operations.'); }
    finally { setLoading(false); }
  }

  async function loadBatch(batchId:string) {
    const response = await adminFetch(`/api/admin/model-training/batch?batchId=${encodeURIComponent(batchId)}`,{cache:'no-store'});
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || 'Unable to load training batch.');
    setBatch(data.batch as Batch);
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!runningRuns.length && !batchActive) return;
    const timer = setInterval(() => { void load(); if (batch?.batch_id) void loadBatch(batch.batch_id).catch(() => undefined); }, 5000);
    return () => clearInterval(timer);
  }, [runningRuns.length, batchActive, batch?.batch_id]);
  useEffect(() => {
    if (selectedDataset && filteredDatasets.some((dataset) => dataset.id === selectedDataset)) return;
    setSelectedDataset(filteredDatasets[0]?.id || '');
  }, [filteredDatasets, selectedDataset]);
  useEffect(() => {
    if (!availableUnits.has(timeframeUnit)) {
      const fallback = (['t','s','m','h'] as TimeframeUnit[]).find((unit) => availableUnits.has(unit));
      if (fallback) setTimeframeUnit(fallback);
    }
    if (horizonFilter !== 'all' && !visibleHorizonOptions.some((option) => option.key === horizonFilter)) setHorizonFilter('all');
    if (assetFilter !== 'all' && !assetOptions.some((option) => option.asset_symbol === assetFilter)) setAssetFilter('all');
  }, [availableUnits, timeframeUnit, horizonFilter, visibleHorizonOptions, assetFilter, assetOptions]);

  function selectTimeframe(unit:TimeframeUnit) { setTimeframeUnit(unit); setHorizonFilter('all'); }
  function toggleDataset(id:string) { setSelectedDatasets((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current,id]); }
  function toggleModel(model:ModelKey) { setModels((current) => current.includes(model) ? current.filter((item) => item !== model) : [...current,model]); }
  function selectFilteredDatasets() {
    if (allFilteredSelected) {
      const visibleIds = new Set(filteredDatasets.map((dataset) => dataset.id));
      setSelectedDatasets((current) => current.filter((id) => !visibleIds.has(id)));
      return;
    }
    setSelectedDatasets((current) => Array.from(new Set([...current, ...filteredDatasets.map((dataset) => dataset.id)])));
  }
  function clearDatasetSelection() { setSelectedDatasets([]); }
  function selectAllModels() { setModels(models.length === ALL_MODELS.length ? [] : ALL_MODELS); }

  async function startSingle() {
    if (!selectedDataset || !models.length || runningRuns.length || batchActive) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await adminFetch('/api/admin/model-training',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({datasetId:selectedDataset,modelTypes:models})});
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || 'Unable to queue model training.');
      setMessage(`Training job ${data.jobId} queued. The dedicated ML worker will execute it outside the web service.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to queue model training.'); }
    finally { setBusy(false); }
  }

  async function startBatch() {
    if (!selectedDatasets.length || !models.length || runningRuns.length || batchActive) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await adminFetch('/api/admin/model-training/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({datasetIds:selectedDatasets,modelTypes:models,skipCompleted,retryFailed})});
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || 'Unable to start training batch.');
      await loadBatch(String(data.batchId));
      setMessage(`Training plan queued: ${Number(data.totalJobs).toLocaleString()} jobs, ${Number(data.skippedJobs).toLocaleString()} already satisfied.`);
      setSelectedDatasets([]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to start training batch.'); }
    finally { setBusy(false); }
  }

  async function resumeBatch() {
    if (!batch?.batch_id) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch('/api/admin/model-training/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'resume',batchId:batch.batch_id})});
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || 'Unable to resume training batch.');
      setBatch(data.batch as Batch);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to resume training batch.'); }
    finally { setBusy(false); }
  }

  async function clearFailedHistory() {
    if (runningRuns.length || batchActive || busy || !failedRunCount) return;
    if (!window.confirm('Clear failed training history only? Completed and partial runs, datasets, registered models and artifacts will be preserved.')) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await adminFetch('/api/admin/model-training',{method:'DELETE',headers:{'x-confirm-training-history-reset':'DELETE_TRAINING_HISTORY'}});
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || 'Unable to clear failed training history.');
      setRuns((current) => current.filter((run) => !failureStatus(run.status)));
      setMessage(`Cleared ${Number(data.deletedRuns || 0).toLocaleString()} failed/timed-out training runs and ${Number(data.deletedRunModels || 0).toLocaleString()} failed model-run records. Completed history was preserved.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to clear failed training history.'); }
    finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-[#05070b] px-4 py-5 text-slate-100 sm:px-6 lg:px-8"><div className="mx-auto max-w-[1500px]">
    <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 sm:flex-row sm:items-center sm:justify-between"><div><Link href="/admin" className="mb-3 inline-flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300"><ArrowLeft className="h-3.5 w-3.5"/>Back to Operations</Link><div className="flex items-center gap-3"><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><BrainCircuit className="h-6 w-6 text-cyan-300"/></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-300">Agenda 6</p><h1 className="text-2xl font-black sm:text-3xl">Model Training Pipeline</h1><p className="mt-1 text-sm text-slate-500">Native training from persisted, leakage-validated datasets.</p></div></div></div><div className="flex gap-2"><button onClick={() => void load()} disabled={loading || busy} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}/>Refresh</button><button onClick={() => void clearFailedHistory()} disabled={busy || loading || runningRuns.length > 0 || batchActive || failedRunCount === 0} className="inline-flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-400/[0.06] px-4 py-2.5 text-sm font-semibold text-red-200 disabled:opacity-40"><Trash2 className="h-4 w-4"/>Clear Failed{failedRunCount > 0 ? ` (${failedRunCount})` : ''}</button></div></header>

    {/* Mode Selector Tabs */}
    <div className="mb-6 flex flex-col xl:flex-row items-stretch xl:items-center gap-3">
      <div className="flex rounded-2xl border border-white/10 bg-black/40 p-1.5 max-w-2xl overflow-x-auto">
        <button
          type="button"
          onClick={() => setPipelineTab('unified')}
          className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2.5 px-4 text-xs font-bold transition cursor-pointer min-w-max ${
            pipelineTab === 'unified'
              ? 'bg-cyan-400 text-slate-950 shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Zap className="h-4 w-4" />
          Unified Multi-Horizon Engine
        </button>
        <button
          type="button"
          onClick={() => setPipelineTab('standard')}
          className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2.5 px-4 text-xs font-bold transition cursor-pointer min-w-max ${
            pipelineTab === 'standard'
              ? 'bg-cyan-400 text-slate-950 shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers3 className="h-4 w-4" />
          Deep Sequence & Specialized Models
        </button>
        <button
          type="button"
          onClick={() => setPipelineTab('worker')}
          className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2.5 px-4 text-xs font-bold transition cursor-pointer min-w-max ${
            pipelineTab === 'worker'
              ? 'bg-purple-400 text-slate-950 shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Activity className="h-4 w-4" />
          ML Worker Observability
        </button>
      </div>

      {pipelineTab === 'standard' && (
        <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3.5 py-2 text-xs text-cyan-300 flex items-center gap-2">
          <span>Dedicated pipeline for Sequential Neural Networks (LSTM, TCN, Transformer) and Anomaly models.</span>
        </div>
      )}
      {pipelineTab === 'worker' && (
        <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 px-3.5 py-2 text-xs text-purple-300 flex items-center gap-2">
          <span>Live telemetry, bottlenecks, and terminal streams directly from the ML execution nodes.</span>
        </div>
      )}
    </div>

    {pipelineTab === 'unified' && <UnifiedMultiHorizonTrainingPanel initialDatasetId={initialDatasetId} />}
    {pipelineTab === 'standard' && <StandardMultiModelTrainingPanel initialDatasetId={initialDatasetId} />}
    {pipelineTab === 'worker' && <MLWorkerObservability />}
  </div></main>;
}

export default function TrainingPipelinePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#05070b] p-8 text-slate-400">Loading pipeline...</div>}>
      <TrainingPipelineContent />
    </Suspense>
  );
}
