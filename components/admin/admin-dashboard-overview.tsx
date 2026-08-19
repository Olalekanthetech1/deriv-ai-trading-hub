'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Beaker,
  BrainCircuit,
  Database,
  Gauge,
  RefreshCw,
  Server,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import QueueScalingControlCard from './queue-scaling-control-card';
import { adminFetch } from '@/lib/admin-client-auth';

type HealthResponse = { db?: 'online' | 'offline'; dbLatencyMs?: number | null; pythonDaemon?: 'online' | 'offline'; daemonLatencyMs?: number | null; rateLimitBlocks?: number; rateLimiterStatus?: string };
type StatsResponse = { isDbConnected?: boolean; dataSource?: string; isSimulated?: boolean; realTradesOnly?: boolean; generatedAt?: string; summary?: { totalTrades?: number; wins?: number; losses?: number; winRate?: number; totalProfit?: number; totalTicks?: number; totalModels?: number; activeModel?: string; activeAccuracy?: number | null } };
type Dataset = { id?: string; asset_symbol?: string; duration_value?: number; duration_unit?: string; sample_count?: number; status?: string; leakage_check_passed?: boolean; created_at?: string };
type TrainingRun = { run_id?: string; asset_symbol?: string; duration_value?: number; duration_unit?: string; status?: string; completed_models?: number; failed_models?: number; requested_models?: string[]; created_at?: string; started_at?: string; completed_at?: string | null; strategy_key?: string | null; strategy_version?: string | null; strategy_metadata?: Record<string, unknown> | null };
type OverviewState = { health: HealthResponse | null; stats: StatsResponse | null; datasets: Dataset[]; runs: TrainingRun[]; loading: boolean; refreshing: boolean; error: string | null; refreshedAt: string | null };

const initialState: OverviewState = { health: null, stats: null, datasets: [], runs: [], loading: true, refreshing: false, error: null, refreshedAt: null };
function formatNumber(value: number | null | undefined) { return Number.isFinite(value) ? Number(value).toLocaleString() : '—'; }
function formatTime(value?: string | null) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString(); }
function formatDuration(value: unknown, unit: unknown) { const numeric = Number(value); if (!Number.isSafeInteger(numeric) || numeric <= 0) return '—'; const labels: Record<string, string> = { t: 'ticks', s: 'seconds', m: 'minutes', h: 'hours', d: 'days' }; return `${numeric} ${labels[String(unit)] || String(unit || '')}`.trim(); }
function normalizedRunStatus(run?: TrainingRun) { return String(run?.status || '').trim().toLowerCase(); }
function isTerminalIssue(run?: TrainingRun) { return ['failed', 'partial', 'timed_out', 'cancelled'].includes(normalizedRunStatus(run)); }
function strategyContextComplete(run?: TrainingRun) { if (!run?.strategy_key) return false; const key = String(run.strategy_key).toLowerCase(); return !key.startsWith('unknown:') && key !== 'unknown'; }
function StatusPill({ status, label }: { status: 'healthy' | 'warning' | 'offline' | 'unknown'; label: string }) { const tone = { healthy: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300', warning: 'border-amber-400/20 bg-amber-400/10 text-amber-300', offline: 'border-red-400/20 bg-red-400/10 text-red-300', unknown: 'border-white/10 bg-white/5 text-slate-400' }[status]; return <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wider ${tone}`}>{label}</span>; }
function MetricCard({ title, value, detail, icon: Icon, status = 'healthy' }: { title: string; value: string; detail: string; icon: typeof Activity; status?: 'healthy' | 'warning' | 'offline' | 'unknown' }) { return <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 sm:p-5"><div className="mb-4 flex items-start justify-between gap-3"><div className="rounded-xl border border-white/10 bg-black/20 p-2.5"><Icon className="h-5 w-5 text-cyan-300" /></div><StatusPill status={status} label={status === 'healthy' ? 'HEALTHY' : status === 'warning' ? 'ATTENTION' : status === 'offline' ? 'OFFLINE' : 'UNKNOWN'} /></div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{title}</p><p className="mt-1 truncate text-xl font-black text-slate-100">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></article>; }

export default function AdminDashboardOverview() {
  const [state, setState] = useState<OverviewState>(initialState);
  const load = useCallback(async (showSpinner = false) => {
    setState((current) => ({ ...current, ...(showSpinner ? { refreshing: true } : {}), error: null }));
    try {
      const requests = [
        { name: 'health', promise: adminFetch('/api/admin/health', { cache: 'no-store' }) },
        { name: 'stats', promise: adminFetch('/api/admin/stats', { cache: 'no-store' }) },
        { name: 'datasets', promise: adminFetch('/api/admin/datasets?eligibleForTraining=1', { cache: 'no-store' }) },
        { name: 'model training', promise: adminFetch('/api/admin/model-training', { cache: 'no-store' }) },
      ];
      const responses = await Promise.all(requests.map(({ promise }) => promise));
      const unauth = responses.find((response) => response.status === 401);
      if (unauth) {
        setState((current) => ({
          ...current,
          loading: false,
          refreshing: false,
          error: 'Admin session expired or unauthenticated. Please re-authenticate.',
        }));
        return;
      }
      const payloads = await Promise.all(responses.map((response) => response.json().catch(() => ({}))));
      const [health, stats, datasetPayload, trainingPayload] = payloads as [HealthResponse, StatsResponse, { datasets?: Dataset[]; error?: string }, { runs?: TrainingRun[]; error?: string }];
      const endpointErrors = responses.map((response, index) => ({ response, name: requests[index].name })).filter(({ response }) => !response.ok).map(({ response, name }) => `${name}: HTTP ${response.status}`);
      setState({ health, stats, datasets: Array.isArray(datasetPayload?.datasets) ? datasetPayload.datasets : [], runs: Array.isArray(trainingPayload?.runs) ? trainingPayload.runs : [], loading: false, refreshing: false, error: endpointErrors.length ? `Dashboard source failure — ${endpointErrors.join('; ')}.` : datasetPayload?.error || trainingPayload?.error || null, refreshedAt: new Date().toISOString() });
    } catch { setState((current) => ({ ...current, loading: false, refreshing: false, error: 'Unable to load the live admin dashboard.' })); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30000); return () => window.clearInterval(timer); }, [load]);

  const runningRuns = useMemo(() => state.runs.filter((run) => normalizedRunStatus(run) === 'running'), [state.runs]);
  const completedRuns = useMemo(() => state.runs.filter((run) => normalizedRunStatus(run) === 'completed'), [state.runs]);
  const terminalIssueRuns = useMemo(() => state.runs.filter((run) => isTerminalIssue(run)), [state.runs]);
  const timedOutRuns = useMemo(() => state.runs.filter((run) => normalizedRunStatus(run) === 'timed_out'), [state.runs]);
  const latestRun = state.runs[0];
  const latestStrategyRun = state.runs.find((run) => strategyContextComplete(run));
  const latestStrategyContextIssue = state.runs.find((run) => Boolean(run.strategy_key) && !strategyContextComplete(run));
  const systemStatus = state.health?.db === 'online' && state.health?.pythonDaemon === 'online' ? 'healthy' : state.health ? 'warning' : 'unknown';
  const dbStatus = state.health?.db === 'online' ? 'healthy' : state.health?.db === 'offline' ? 'offline' : 'unknown';
  const daemonStatus = state.health?.pythonDaemon === 'online' ? 'healthy' : state.health?.pythonDaemon === 'offline' ? 'offline' : 'unknown';
  const trainingStatus = runningRuns.length ? 'warning' : terminalIssueRuns.length ? 'warning' : 'healthy';
  const productionModel = state.stats?.summary?.activeModel;
  const hasProductionModel = Boolean(productionModel && !String(productionModel).toLowerCase().includes('unavailable'));
  const alerts = useMemo(() => {
    const items: string[] = [];
    if (dbStatus !== 'healthy') items.push('Database connectivity is not confirmed.');
    if (daemonStatus !== 'healthy') items.push('Native ML runtime is not confirmed online.');
    if (runningRuns.length) items.push(`${runningRuns.length} training run${runningRuns.length === 1 ? '' : 's'} currently active.`);
    if (terminalIssueRuns.length) items.push(`${terminalIssueRuns.length} recent training run${terminalIssueRuns.length === 1 ? '' : 's'} ended with a terminal issue${timedOutRuns.length ? `, including ${timedOutRuns.length} timeout${timedOutRuns.length === 1 ? '' : 's'}` : ''}.`);
    if (latestStrategyContextIssue) items.push(`Training lineage ${latestStrategyContextIssue.strategy_key} has incomplete asset context and is not treated as active strategy lineage.`);
    if (!hasProductionModel) items.push('No production model is reported by the persisted registry; candidate training models are not production models.');
    return items;
  }, [dbStatus, daemonStatus, runningRuns.length, terminalIssueRuns.length, timedOutRuns.length, latestStrategyContextIssue, hasProductionModel]);
  const latestStatus = normalizedRunStatus(latestRun);
  const latestStatusTone = latestStatus === 'completed' ? 'healthy' : latestStatus === 'running' ? 'warning' : isTerminalIssue(latestRun) ? 'offline' : 'unknown';
  const latestStatusLabel = latestStatus ? latestStatus.replace('_', ' ').toUpperCase() : 'UNKNOWN';

  return <section className="mb-6">
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300">Live Admin Dashboard</p><h2 className="mt-1 text-xl font-black tracking-tight">Operational Snapshot</h2><p className="mt-1 text-xs leading-5 text-slate-500">Runtime-backed state from the existing admin APIs. No synthetic or client-only metrics are used.</p></div><button onClick={() => void load(true)} disabled={state.refreshing} className="inline-flex w-fit items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${state.refreshing ? 'animate-spin' : ''}`} />Refresh</button></div>
    {state.error && <div className="mb-4 flex items-start gap-2 rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{state.error}</div>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard title="System" value={systemStatus === 'healthy' ? 'Operational' : systemStatus === 'warning' ? 'Attention required' : 'Awaiting data'} detail={`Last refresh ${formatTime(state.refreshedAt)}`} icon={Activity} status={systemStatus} /><MetricCard title="Database" value={state.health?.db || 'Not reported'} detail={`Latency ${state.health?.dbLatencyMs ?? '—'} ms`} icon={Database} status={dbStatus} /><MetricCard title="ML Runtime" value={state.health?.pythonDaemon || 'Not reported'} detail={`Daemon latency ${state.health?.daemonLatencyMs ?? '—'} ms`} icon={BrainCircuit} status={daemonStatus} /><MetricCard title="Production Model" value={hasProductionModel ? String(productionModel) : 'None reported'} detail={`${formatNumber(state.stats?.summary?.totalModels)} registered production models`} icon={Server} status={hasProductionModel ? 'healthy' : 'warning'} /></div>
    <div className="mt-3 grid gap-3 lg:grid-cols-3">
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2"><Beaker className="h-4 w-4 text-cyan-300" /><h3 className="text-sm font-bold">Dataset Readiness</h3></div><StatusPill status={state.datasets.length ? 'healthy' : 'warning'} label={state.datasets.length ? 'READY' : 'EMPTY'} /></div><div className="grid grid-cols-2 gap-3"><div><p className="text-xs text-slate-500">Training-ready</p><p className="mt-1 text-lg font-black">{formatNumber(state.datasets.length)}</p></div><div><p className="text-xs text-slate-500">Stored ticks</p><p className="mt-1 text-lg font-black">{formatNumber(state.stats?.summary?.totalTicks)}</p></div></div><Link href="/admin/dataset-builder" className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-cyan-300 hover:text-cyan-200">Open Dataset Builder <ArrowRight className="h-3.5 w-3.5" /></Link></article>
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2"><Gauge className="h-4 w-4 text-cyan-300" /><h3 className="text-sm font-bold">Training Pipeline</h3></div><StatusPill status={trainingStatus} label={runningRuns.length ? 'RUNNING' : terminalIssueRuns.length ? 'ATTENTION' : 'STABLE'} /></div><div className="grid grid-cols-3 gap-2"><div><p className="text-[11px] text-slate-500">Running</p><p className="mt-1 font-bold">{runningRuns.length}</p></div><div><p className="text-[11px] text-slate-500">Completed</p><p className="mt-1 font-bold">{completedRuns.length}</p></div><div><p className="text-[11px] text-slate-500">Terminal issues</p><p className="mt-1 font-bold">{terminalIssueRuns.length}</p></div></div><Link href="/admin/training-pipeline" className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-cyan-300 hover:text-cyan-200">Open Training Pipeline <ArrowRight className="h-3.5 w-3.5" /></Link></article>
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-300" /><h3 className="text-sm font-bold">Asset-Aware Strategy</h3></div><StatusPill status={latestStrategyRun ? 'healthy' : 'warning'} label={latestStrategyRun ? 'LINEAGE ACTIVE' : latestStrategyContextIssue ? 'CONTEXT INCOMPLETE' : 'AWAITING TRAINING'} /></div><p className="text-xs text-slate-500">{latestStrategyRun ? `${latestStrategyRun.strategy_key} · v${latestStrategyRun.strategy_version || '—'}` : latestStrategyContextIssue ? `${latestStrategyContextIssue.strategy_key} · v${latestStrategyContextIssue.strategy_version || '—'}` : 'Strategy metadata will appear here after a persisted training run uses the runtime strategy resolver.'}</p><p className="mt-2 text-xs text-slate-500">Latest horizon: {latestStrategyRun ? formatDuration(latestStrategyRun.duration_value, latestStrategyRun.duration_unit) : latestStrategyContextIssue ? formatDuration(latestStrategyContextIssue.duration_value, latestStrategyContextIssue.duration_unit) : '—'}</p><Link href="/admin/asset-strategy" className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-cyan-300 hover:text-cyan-200">Open Strategy Dashboard <ArrowRight className="h-3.5 w-3.5" /></Link></article>
    </div>
    <div className="mt-3">
      <QueueScalingControlCard />
    </div>
    <div className="mt-3 grid gap-3 lg:grid-cols-[1.35fr_0.65fr]"><article className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><div className="mb-4 flex items-center justify-between"><div><h3 className="text-sm font-bold">Latest Training Activity</h3><p className="mt-1 text-[11px] text-slate-500">Persisted run history, not browser-local state.</p></div><Timer className="h-4 w-4 text-slate-500" /></div>{state.loading ? <div className="flex items-center gap-2 py-8 text-xs text-slate-500"><RefreshCw className="h-4 w-4 animate-spin" />Loading training activity…</div> : latestRun ? <div className="rounded-xl border border-white/10 bg-black/20 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-mono text-xs font-bold text-cyan-200">{latestRun.run_id || 'Unknown run'}</p><p className="mt-1 text-xs text-slate-400">{latestRun.asset_symbol || 'Unknown asset'} · {formatDuration(latestRun.duration_value, latestRun.duration_unit)}</p></div><StatusPill status={latestStatusTone} label={latestStatusLabel} /></div><div className="mt-3 grid gap-2 sm:grid-cols-4"><div><p className="text-[10px] text-slate-500">Requested</p><p className="mt-1 text-xs font-bold">{formatNumber(latestRun.requested_models?.length)}</p></div><div><p className="text-[10px] text-slate-500">Completed</p><p className="mt-1 text-xs font-bold">{formatNumber(latestRun.completed_models)}</p></div><div><p className="text-[10px] text-slate-500">Failed</p><p className="mt-1 text-xs font-bold">{formatNumber(latestRun.failed_models)}</p></div><div><p className="text-[10px] text-slate-500">{latestStatus === 'running' ? 'Started' : 'Finished'}</p><p className="mt-1 text-xs font-bold">{formatTime(latestStatus === 'running' ? latestRun.started_at : latestRun.completed_at)}</p></div></div>{latestStatus === 'timed_out' && <p className="mt-3 rounded-lg border border-red-400/10 bg-red-400/[0.04] px-3 py-2 text-[10px] text-red-200">Native training timeout is terminal. The run is no longer active.</p>}{latestStatus === 'cancelled' && <p className="mt-3 rounded-lg border border-amber-400/10 bg-amber-400/[0.04] px-3 py-2 text-[10px] text-amber-200">Training was cancelled before completion; this history record does not represent an active worker.</p>}</div> : <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-xs text-slate-600">No training runs are persisted yet.</div>}</article>
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><div className="mb-4 flex items-center gap-2"><Activity className="h-4 w-4 text-cyan-300" /><h3 className="text-sm font-bold">Trading Evidence</h3></div><div className="space-y-3"><div className="flex items-center justify-between"><span className="text-xs text-slate-500">Persisted trades</span><span className="text-sm font-bold">{formatNumber(state.stats?.summary?.totalTrades)}</span></div><div className="flex items-center justify-between"><span className="text-xs text-slate-500">Resolved win rate</span><span className="text-sm font-bold">{Number.isFinite(state.stats?.summary?.winRate) ? `${state.stats?.summary?.winRate}%` : '—'}</span></div><div className="flex items-center justify-between"><span className="text-xs text-slate-500">Persisted P&amp;L</span><span className="text-sm font-bold">{Number.isFinite(state.stats?.summary?.totalProfit) ? state.stats?.summary?.totalProfit : '—'}</span></div></div><p className="mt-4 text-[11px] leading-5 text-slate-600">Dashboard metrics remain blank when the database has no real trade evidence. Synthetic/demo trades are not substituted.</p></article></div>
    {alerts.length > 0 && <div className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-4"><div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><div><p className="text-xs font-bold text-amber-200">Attention</p><ul className="mt-1 space-y-1 text-xs text-slate-400">{alerts.map((item) => <li key={item}>• {item}</li>)}</ul></div></div></div>}
  </section>;
}
