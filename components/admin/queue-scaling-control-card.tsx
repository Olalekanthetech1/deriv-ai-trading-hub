'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Gauge,
  Pause,
  Play,
  RefreshCw,
  Sliders,
  ShieldCheck,
  AlertTriangle,
  Cpu,
  Layers,
  Activity,
  HardDrive,
  Clock,
  ArrowUp,
  ArrowDown,
  Zap,
  CheckCircle2,
} from 'lucide-react';
import { adminFetch } from '@/lib/admin-client-auth';
import WorkerTelemetryDashboard from './worker-telemetry-dashboard';

type QueueConfig = {
  isPaused: boolean;
  concurrencyLimit: number;
  pauseReason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  source: 'database' | 'default';
};

type WorkerTelemetryMetrics = {
  heapUsedMb?: number;
  heapTotalMb?: number;
  rssMb?: number;
  externalMb?: number;
  systemFreeMemMb?: number;
  systemTotalMemMb?: number;
  systemMemoryUsagePct?: number;
  loadAverage?: [number, number, number];
  uptimeSecs?: number;
  pid?: number;
  nodeVersion?: string;
  activeJobsCount?: number;
};

type WorkerHeartbeatInfo = {
  workerId: string;
  workerType: 'training_worker' | 'dataset_worker' | 'scheduler';
  status: 'online' | 'stale' | 'stopping';
  heartbeatAt: string;
  metrics: WorkerTelemetryMetrics | null;
  ageMs: number;
};

type QueueJob = {
  jobId: string;
  datasetId: string;
  modelTypes: string[];
  status: 'queued' | 'running' | 'completed' | 'failed';
  priority: number;
  attempts: number;
  workerId?: string | null;
  createdAt?: string;
};

type QueueStats = {
  workerStatus: {
    workerId: string | null;
    status: 'online' | 'stale' | 'offline';
    heartbeatAt: string | null;
  };
  activeRunningCount: number;
  queuedCount: number;
  totalInQueue: number;
};

export default function QueueScalingControlCard() {
  const [config, setConfig] = useState<QueueConfig | null>(null);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [workers, setWorkers] = useState<WorkerHeartbeatInfo[]>([]);
  const [queueJobs, setQueueJobs] = useState<QueueJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionJobId, setActionJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [concurrencyInput, setConcurrencyInput] = useState<number>(2);
  const [pauseReasonInput, setPauseReasonInput] = useState<string>('');
  const [showTelemetryDetails, setShowTelemetryDetails] = useState<boolean>(true);

  const fetchScaling = useCallback(async () => {
    try {
      const res = await adminFetch('/api/admin/queue-scaling', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.success) {
        setConfig(data.config);
        setStats(data.stats);
        setWorkers(Array.isArray(data.workers) ? data.workers : []);
        setQueueJobs(Array.isArray(data.queueJobs) ? data.queueJobs : []);
        setConcurrencyInput(data.config.concurrencyLimit);
        setPauseReasonInput(data.config.pauseReason || '');
        setError(null);
      } else {
        setError(data?.error || 'Failed to load queue scaling state.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to connect to queue scaling API.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchScaling();
    const interval = setInterval(() => {
      void fetchScaling();
    }, 8000);
    return () => clearInterval(interval);
  }, [fetchScaling]);

  const handleUpdate = async (updates: { isPaused?: boolean; concurrencyLimit?: number; pauseReason?: string }) => {
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await adminFetch('/api/admin/queue-scaling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (res.ok && data?.success) {
        setConfig(data.config);
        setConcurrencyInput(data.config.concurrencyLimit);
        setSuccessMsg(data.message || 'Settings saved dynamically to database.');
        setTimeout(() => setSuccessMsg(null), 4000);
      } else {
        setError(data?.error || 'Failed to update queue settings.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error updating queue settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleJobPriority = async (jobId: string, action: 'boost_priority' | 'lower_priority' | 'set_priority', priority?: number) => {
    setActionJobId(jobId);
    setError(null);
    try {
      const res = await adminFetch('/api/admin/queue-scaling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, jobId, priority }),
      });
      const data = await res.json();
      if (res.ok && data?.success) {
        setSuccessMsg(data.message || 'Priority updated.');
        await fetchScaling();
        setTimeout(() => setSuccessMsg(null), 3000);
      } else {
        setError(data?.error || 'Failed to update job priority.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Priority update failed.');
    } finally {
      setActionJobId(null);
    }
  };

  const handleTogglePause = () => {
    if (!config) return;
    const nextState = !config.isPaused;
    void handleUpdate({
      isPaused: nextState,
      pauseReason: nextState ? (pauseReasonInput.trim() || 'Manual operations pause') : '',
    });
  };

  const handleSaveConcurrency = () => {
    if (!config) return;
    void handleUpdate({
      concurrencyLimit: concurrencyInput,
    });
  };

  if (loading && !config) {
    return (
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <RefreshCw className="h-4 w-4 animate-spin text-cyan-300" />
          Loading dynamic queue and auto-worker scaling controls…
        </div>
      </article>
    );
  }

  const isPaused = config?.isPaused ?? false;
  const currentConcurrency = config?.concurrencyLimit ?? 2;
  const workerStatus = stats?.workerStatus?.status || 'offline';
  const workerTone = workerStatus === 'online' ? 'text-emerald-400' : workerStatus === 'stale' ? 'text-amber-400' : 'text-slate-500';

  const formatDuration = (secs?: number) => {
    if (!secs || secs <= 0) return '0s';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (m === 0) return `${s}s`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    if (h === 0) return `${remM}m ${s}s`;
    return `${h}h ${remM}m`;
  };

  const getPriorityBadge = (p: number) => {
    if (p <= 2) return <span className="inline-flex items-center gap-1 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 px-1.5 py-0.5 text-[10px] font-bold"><Zap className="h-2.5 w-2.5" /> P{p} URGENT</span>;
    if (p <= 4) return <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-bold">P{p} HIGH</span>;
    if (p <= 6) return <span className="inline-flex items-center gap-1 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 px-1.5 py-0.5 text-[10px] font-medium">P{p} NORMAL</span>;
    return <span className="inline-flex items-center gap-1 rounded bg-slate-700/40 text-slate-400 border border-slate-700/60 px-1.5 py-0.5 text-[10px] font-medium">P{p} LOW</span>;
  };

  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 shadow-lg shadow-black/10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 p-2.5">
            <Sliders className="h-5 w-5 text-cyan-300" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold tracking-tight text-slate-100">Queue &amp; Auto-Worker Scaling</h3>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${
                isPaused
                  ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                  : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
              }`}>
                {isPaused ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}
                {isPaused ? 'QUEUE PAUSED' : 'QUEUE ACTIVE'}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Dynamic DB-persisted concurrency throttling, priority re-ordering, and real-time worker memory/CPU telemetry.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTelemetryDetails((prev) => !prev)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition"
          >
            <Activity className="h-3.5 w-3.5 text-cyan-400" />
            {showTelemetryDetails ? 'Hide Telemetry' : 'Worker Telemetry'}
          </button>

          <button
            onClick={handleTogglePause}
            disabled={saving}
            className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition disabled:opacity-60 ${
              isPaused
                ? 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'
                : 'border border-amber-400/30 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20'
            }`}
          >
            {isPaused ? <Play className="h-3.5 w-3.5 fill-current" /> : <Pause className="h-3.5 w-3.5 fill-current" />}
            {isPaused ? 'Resume All Workers' : 'Pause Queue Intake'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/10 px-3.5 py-2 text-xs text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {successMsg && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3.5 py-2 text-xs text-emerald-300">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          {successMsg}
        </div>
      )}

      {/* Main KPI Row */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 pt-1">
        <div className="rounded-xl border border-white/5 bg-black/20 p-3">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-[11px] uppercase tracking-wider font-semibold">Active Workers</span>
            <Cpu className="h-3.5 w-3.5" />
          </div>
          <p className="text-sm font-bold text-slate-200 truncate">
            {workers.length > 0 ? `${workers.filter(w => w.status === 'online').length} online (${workers.length} registered)` : 'No active workers'}
          </p>
          <p className={`text-[11px] mt-1 font-medium ${workerTone}`}>
            Primary: {workerStatus.toUpperCase()}
          </p>
        </div>

        <div className="rounded-xl border border-white/5 bg-black/20 p-3">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-[11px] uppercase tracking-wider font-semibold">Running / Queued</span>
            <Layers className="h-3.5 w-3.5" />
          </div>
          <p className="text-lg font-black text-slate-100">
            {stats?.activeRunningCount ?? 0} <span className="text-xs font-normal text-slate-500">running</span>
          </p>
          <p className="text-[11px] text-cyan-300 mt-0.5">
            {stats?.queuedCount ?? 0} queued waiting in order
          </p>
        </div>

        <div className="rounded-xl border border-white/5 bg-black/20 p-3 sm:col-span-2">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-[11px] uppercase tracking-wider font-semibold flex items-center gap-1.5">
              <Gauge className="h-3.5 w-3.5 text-cyan-300" />
              Dynamic Concurrency Throttle
            </span>
            <span className="text-xs font-mono font-bold text-cyan-300">
              {concurrencyInput} {concurrencyInput === 1 ? 'Job' : 'Jobs'} Limit
            </span>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={concurrencyInput}
              onChange={(e) => setConcurrencyInput(Number(e.target.value))}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-400"
            />
            {concurrencyInput !== currentConcurrency && (
              <button
                onClick={handleSaveConcurrency}
                disabled={saving}
                className="shrink-0 rounded-lg bg-cyan-400 px-2.5 py-1 text-[11px] font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-50"
              >
                Apply
              </button>
            )}
          </div>
          <div className="flex justify-between text-[10px] text-slate-500 mt-1.5 font-mono">
            <span>1 (Gentle)</span>
            <span>4 (Standard)</span>
            <span>8 (High-Parallel)</span>
          </div>
        </div>
      </div>

      {/* Compact Fleet Telemetry Summary Section with Link to Infrastructure Page */}
      {showTelemetryDetails && (
        <div className="mt-4">
          <WorkerTelemetryDashboard compactView={true} />
        </div>
      )}

      {/* Queue Job Prioritization & Live Ordering */}
      <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-cyan-300" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">Active Queue Pipeline &amp; Priority Management</h4>
          </div>
          <span className="text-[10px] text-slate-500">Ordered by Priority $\to$ Submission Time</span>
        </div>

        {queueJobs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/10 p-4 text-center text-xs text-slate-500">
            Queue is currently empty. No active training runs or pending model builds.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-white/10 text-slate-500 text-[11px] font-semibold uppercase">
                  <th className="pb-2">Priority</th>
                  <th className="pb-2">Job ID / Dataset</th>
                  <th className="pb-2">Models</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2 text-right">Priority Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-mono">
                {queueJobs.map((job) => {
                  const isQueued = job.status === 'queued';
                  const isRunning = job.status === 'running';

                  return (
                    <tr key={job.jobId} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 pr-3">
                        {getPriorityBadge(job.priority)}
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="font-bold text-slate-200">{job.jobId.slice(0, 8)}</div>
                        <div className="text-[10px] text-slate-500 truncate max-w-[140px]">{job.datasetId.slice(0, 13)}…</div>
                      </td>
                      <td className="py-2.5 pr-3 text-[11px] text-slate-300">
                        {job.modelTypes && job.modelTypes.length > 0 ? job.modelTypes.join(', ') : 'All Standard'}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          isRunning ? 'bg-cyan-400/20 text-cyan-300 border border-cyan-400/30' :
                          isQueued ? 'bg-amber-400/20 text-amber-300 border border-amber-400/30' :
                          job.status === 'completed' ? 'bg-emerald-400/20 text-emerald-300' : 'bg-rose-400/20 text-rose-300'
                        }`}>
                          {isRunning ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : isQueued ? <Clock className="h-2.5 w-2.5" /> : <CheckCircle2 className="h-2.5 w-2.5" />}
                          {job.status.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-2.5 text-right space-x-1">
                        {isQueued && (
                          <>
                            <button
                              onClick={() => void handleJobPriority(job.jobId, 'boost_priority')}
                              disabled={actionJobId === job.jobId || job.priority === 1}
                              title="Set to Urgent Priority (P1) - Jumps to Front of Queue"
                              className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-300 hover:bg-rose-500/20 transition disabled:opacity-40"
                            >
                              <Zap className="h-2.5 w-2.5" /> Urgent
                            </button>
                            <button
                              onClick={() => void handleJobPriority(job.jobId, 'set_priority', Math.max(1, job.priority - 2))}
                              disabled={actionJobId === job.jobId || job.priority <= 1}
                              title="Increase Priority"
                              className="inline-flex items-center rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-slate-300 hover:bg-white/10 transition disabled:opacity-40"
                            >
                              <ArrowUp className="h-3 w-3" />
                            </button>
                            <button
                              onClick={() => void handleJobPriority(job.jobId, 'set_priority', Math.min(10, job.priority + 2))}
                              disabled={actionJobId === job.jobId || job.priority >= 9}
                              title="Lower Priority"
                              className="inline-flex items-center rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-slate-400 hover:bg-white/10 transition disabled:opacity-40"
                            >
                              <ArrowDown className="h-3 w-3" />
                            </button>
                          </>
                        )}
                        {isRunning && (
                          <span className="text-[10px] text-cyan-400/80 font-mono">Running on {job.workerId ? job.workerId.slice(0, 14) : 'worker'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isPaused && (
        <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-3 text-xs text-amber-200/90 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-300" />
          <div>
            <span className="font-semibold text-amber-300">Intake paused:</span> Workers will not claim new jobs from the queue until resumed. Running jobs will gracefully run to completion.
            {config?.pauseReason && (
              <span className="block mt-1 text-slate-400 font-mono text-[11px]">
                Reason: &ldquo;{config.pauseReason}&rdquo; (updated by {config.updatedBy || 'admin'})
              </span>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
