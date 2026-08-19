'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  Clock,
  Cpu,
  ExternalLink,
  Filter,
  HardDrive,
  Layers,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import { adminFetch } from '@/lib/admin-client-auth';

export type WorkerTelemetryMetrics = {
  heapUsedMb?: number;
  heapTotalMb?: number;
  rssMb?: number;
  externalMb?: number;
  systemFreeMemMb?: number;
  systemTotalMemMb?: number;
  systemMemoryUsagePct?: number;
  loadAverage?: [number, number, number];
  cpuPercent?: number;
  uptimeSecs?: number;
  pid?: number;
  nodeVersion?: string;
  activeJobsCount?: number;
  processedJobsCount?: number;
};

export type WorkerHeartbeatInfo = {
  workerId: string;
  workerType: 'training_worker' | 'dataset_worker' | 'scheduler';
  status: 'online' | 'stale' | 'stopping';
  heartbeatAt: string;
  metrics: WorkerTelemetryMetrics | null;
  ageMs: number;
};

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '0s';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function calculateEfficiencyScore(w: WorkerHeartbeatInfo): number {
  if (w.status !== 'online') return 30;
  const heapUsed = w.metrics?.heapUsedMb ?? 0;
  const heapTotal = Math.max(1, w.metrics?.heapTotalMb ?? 1);
  const rssMb = w.metrics?.rssMb ?? 0;
  const ageSecs = (w.ageMs || 0) / 1000;

  let score = 100;
  // Evaluate real physical and heap pressure
  if (rssMb > 400 || heapUsed > 300) score -= 30;
  else if (rssMb > 250 || heapUsed > 180) score -= 15;
  else if (heapUsed > 128 && (heapUsed / heapTotal) > 0.88) score -= 15;

  // Heartbeat timeliness
  if (ageSecs > 60) score -= 40;
  else if (ageSecs > 30) score -= 20;

  return Math.max(10, Math.min(100, Math.round(score)));
}

export default function WorkerTelemetryDashboard({ compactView = false }: { compactView?: boolean }) {
  const [workers, setWorkers] = useState<WorkerHeartbeatInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Filter & Sorting state
  const [roleFilter, setRoleFilter] = useState<'all' | 'dataset_worker' | 'training_worker' | 'high_memory'>('all');
  const [sortBy, setSortBy] = useState<'heap' | 'rss' | 'load' | 'uptime' | 'id'>('heap');
  const [searchQuery, setSearchQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchWorkers = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const res = await adminFetch('/api/admin/queue-scaling', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.success) {
        setWorkers(Array.isArray(data.workers) ? data.workers : []);
        setError(null);
      } else {
        setError(data?.error || 'Failed to load telemetry data.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reach worker telemetry endpoint.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchWorkers();
  }, [fetchWorkers]);

  useEffect(() => {
    if (!autoRefresh || compactView) return;
    const interval = setInterval(() => {
      void fetchWorkers();
    }, 6000);
    return () => clearInterval(interval);
  }, [autoRefresh, compactView, fetchWorkers]);

  const handleFlushStale = async () => {
    setFlushing(true);
    setSuccessMsg(null);
    try {
      const res = await adminFetch('/api/admin/queue-scaling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'flush_stale_workers' }),
      });
      const data = await res.json();
      if (res.ok && data?.success) {
        setSuccessMsg(data.message || 'Stale heartbeats flushed.');
        await fetchWorkers(true);
        setTimeout(() => setSuccessMsg(null), 4000);
      } else {
        setError(data?.error || 'Failed to flush stale workers.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error flushing stale workers.');
    } finally {
      setFlushing(false);
    }
  };

  // Fleet Statistics
  const fleetStats = useMemo(() => {
    const totalCount = workers.length;
    const onlineCount = workers.filter((w) => w.status === 'online').length;
    const datasetWorkersCount = workers.filter((w) => w.workerType === 'dataset_worker').length;
    const trainingWorkersCount = workers.filter((w) => w.workerType === 'training_worker').length;
    const staleCount = workers.filter((w) => w.status !== 'online').length;

    let totalRss = 0;
    let totalHeapUsed = 0;
    let totalHeapAllocated = 0;
    let totalLoad = 0;

    workers.forEach((w) => {
      const m = w.metrics;
      if (m) {
        totalRss += m.rssMb ?? 0;
        totalHeapUsed += m.heapUsedMb ?? 0;
        totalHeapAllocated += m.heapTotalMb ?? 0;
        if (m.loadAverage && m.loadAverage[0]) {
          totalLoad += m.loadAverage[0];
        }
      }
    });

    const avgHeapPct = totalHeapAllocated > 0 ? Math.round((totalHeapUsed / totalHeapAllocated) * 100) : 0;
    const avgLoad = totalCount > 0 ? (totalLoad / totalCount).toFixed(2) : '0.00';
    const fleetRssGb = (totalRss / 1024).toFixed(2);

    const highMemCount = workers.filter((w) => {
      const u = w.metrics?.heapUsedMb ?? 0;
      const rss = w.metrics?.rssMb ?? 0;
      const t = w.metrics?.heapTotalMb ?? 1;
      return u > 256 || rss > 400 || (u > 128 && u / t > 0.88);
    }).length;

    return {
      totalCount,
      onlineCount,
      datasetWorkersCount,
      trainingWorkersCount,
      staleCount,
      totalRss,
      fleetRssGb,
      totalHeapUsed,
      totalHeapAllocated,
      avgHeapPct,
      avgLoad,
      highMemCount,
    };
  }, [workers]);

  // Filtered and Sorted Workers
  const processedWorkers = useMemo(() => {
    return workers
      .filter((w) => {
        if (roleFilter === 'dataset_worker') return w.workerType === 'dataset_worker';
        if (roleFilter === 'training_worker') return w.workerType === 'training_worker';
        if (roleFilter === 'high_memory') {
          const u = w.metrics?.heapUsedMb ?? 0;
          const rss = w.metrics?.rssMb ?? 0;
          const t = w.metrics?.heapTotalMb ?? 1;
          return u > 256 || rss > 400 || (u > 128 && u / t > 0.88) || w.status !== 'online';
        }
        return true;
      })
      .filter((w) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
          w.workerId.toLowerCase().includes(q) ||
          w.workerType.toLowerCase().includes(q) ||
          (w.metrics?.pid && String(w.metrics.pid).includes(q))
        );
      })
      .sort((a, b) => {
        if (sortBy === 'heap') {
          const pctA = (a.metrics?.heapUsedMb ?? 0) / Math.max(1, a.metrics?.heapTotalMb ?? 1);
          const pctB = (b.metrics?.heapUsedMb ?? 0) / Math.max(1, b.metrics?.heapTotalMb ?? 1);
          return pctB - pctA;
        }
        if (sortBy === 'rss') {
          return (b.metrics?.rssMb ?? 0) - (a.metrics?.rssMb ?? 0);
        }
        if (sortBy === 'load') {
          return (b.metrics?.loadAverage?.[0] ?? 0) - (a.metrics?.loadAverage?.[0] ?? 0);
        }
        if (sortBy === 'uptime') {
          return (b.metrics?.uptimeSecs ?? 0) - (a.metrics?.uptimeSecs ?? 0);
        }
        return a.workerId.localeCompare(b.workerId);
      });
  }, [workers, roleFilter, searchQuery, sortBy]);

  if (compactView) {
    return (
      <article className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-3">
              <Activity className="h-6 w-6 text-emerald-300 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-400">Worker Fleet Telemetry</span>
                <span className="rounded-full bg-emerald-400/10 border border-emerald-400/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                  {fleetStats.onlineCount} / {fleetStats.totalCount} Online
                </span>
              </div>
              <h3 className="text-xl font-black text-white mt-0.5">Real-Time Process &amp; Resource Footprint</h3>
              <p className="mt-1 text-xs text-slate-400">
                {fleetStats.datasetWorkersCount} Dataset Builders · {fleetStats.trainingWorkersCount} ML Trainers · Total Physical RAM: {fleetStats.fleetRssGb} GB
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin/infrastructure"
              className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-xs font-extrabold text-slate-950 transition hover:bg-cyan-300 shadow-lg shadow-cyan-400/20"
            >
              <Server className="h-4 w-4" />
              Inspect Full Telemetry Fleet ({fleetStats.totalCount})
            </Link>
          </div>
        </div>

        {/* Quick Compact Fleet Metrics Strip */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-white/5 bg-black/30 p-3.5">
            <p className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Fleet RAM Footprint</p>
            <p className="mt-1 text-lg font-black text-white">{fleetStats.fleetRssGb} GB</p>
            <p className="text-[10px] font-mono text-slate-500">{fleetStats.totalRss} MB RSS</p>
          </div>
          <div className="rounded-2xl border border-white/5 bg-black/30 p-3.5">
            <p className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Avg Heap Utilization</p>
            <p className="mt-1 text-lg font-black text-emerald-300">{fleetStats.avgHeapPct}%</p>
            <p className="text-[10px] font-mono text-slate-500">{fleetStats.totalHeapUsed} / {fleetStats.totalHeapAllocated} MB</p>
          </div>
          <div className="rounded-2xl border border-white/5 bg-black/30 p-3.5">
            <p className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Avg Host CPU Load</p>
            <p className="mt-1 text-lg font-black text-cyan-300">{fleetStats.avgLoad}</p>
            <p className="text-[10px] font-mono text-slate-500">1m Load Average</p>
          </div>
          <div className="rounded-2xl border border-white/5 bg-black/30 p-3.5">
            <p className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Warnings / Stale</p>
            <p className={`mt-1 text-lg font-black ${fleetStats.staleCount > 0 ? 'text-amber-300' : 'text-slate-400'}`}>
              {fleetStats.staleCount} Instance{fleetStats.staleCount === 1 ? '' : 's'}
            </p>
            <p className="text-[10px] font-mono text-slate-500">{fleetStats.highMemCount} High Memory</p>
          </div>
        </div>
      </article>
    );
  }

  return (
    <section className="space-y-6">
      {/* Fleet Overview Telemetry Header Banner */}
      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-3">
              <Activity className="h-6 w-6 text-emerald-300 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-400">Production Worker Telemetry</p>
                <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-0.5 text-[10px] font-bold text-emerald-300">
                  {fleetStats.onlineCount} / {fleetStats.totalCount} Active
                </span>
              </div>
              <h2 className="text-2xl font-black tracking-tight text-white sm:text-3xl">Worker Memory &amp; Resource Telemetry</h2>
              <p className="mt-1 text-xs text-slate-400">
                Live heartbeat monitoring, V8 JavaScript heap metrics, RSS physical memory, host CPU load, and worker process lifecycle.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={() => setAutoRefresh((prev) => !prev)}
              className={`rounded-xl border px-3.5 py-2 text-xs font-semibold transition ${
                autoRefresh
                  ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
                  : 'border-white/10 bg-white/5 text-slate-400 hover:bg-white/10'
              }`}
            >
              {autoRefresh ? 'Live Polling ON (6s)' : 'Live Polling Paused'}
            </button>
            <button
              onClick={() => void fetchWorkers(true)}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 disabled:opacity-50 transition"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {fleetStats.staleCount > 0 && (
              <button
                onClick={handleFlushStale}
                disabled={flushing}
                className="inline-flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/10 px-3.5 py-2 text-xs font-bold text-amber-200 hover:bg-amber-400/20 transition disabled:opacity-50"
              >
                {flushing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Flush Stale ({fleetStats.staleCount})
              </button>
            )}
          </div>
        </div>

        {/* Dynamic Fleet Stat Cards */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-black/40 p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs">
              <span className="font-semibold uppercase text-[10px] tracking-wider text-slate-500">Active Workers</span>
              <Server className="h-4 w-4 text-cyan-300" />
            </div>
            <p className="mt-2 text-2xl font-black text-white">{fleetStats.totalCount}</p>
            <p className="mt-1 text-[11px] text-slate-400">
              <span className="text-purple-300 font-bold">{fleetStats.datasetWorkersCount}</span> Dataset ·{' '}
              <span className="text-cyan-300 font-bold">{fleetStats.trainingWorkersCount}</span> Training
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/40 p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs">
              <span className="font-semibold uppercase text-[10px] tracking-wider text-slate-500">Total Physical RAM</span>
              <HardDrive className="h-4 w-4 text-purple-300" />
            </div>
            <p className="mt-2 text-2xl font-black text-white">{fleetStats.fleetRssGb} GB</p>
            <p className="mt-1 text-[11px] text-slate-400 font-mono">{fleetStats.totalRss} MB Total RSS Footprint</p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/40 p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs">
              <span className="font-semibold uppercase text-[10px] tracking-wider text-slate-500">Avg Heap Utilization</span>
              <Activity className="h-4 w-4 text-emerald-300" />
            </div>
            <p className="mt-2 text-2xl font-black text-emerald-300">{fleetStats.avgHeapPct}%</p>
            <p className="mt-1 text-[11px] text-slate-400 font-mono">
              {fleetStats.totalHeapUsed} / {fleetStats.totalHeapAllocated} MB Heap
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/40 p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs">
              <span className="font-semibold uppercase text-[10px] tracking-wider text-slate-500">Fleet Host CPU Load</span>
              <Cpu className="h-4 w-4 text-cyan-300" />
            </div>
            <p className="mt-2 text-2xl font-black text-cyan-300">{fleetStats.avgLoad}</p>
            <p className="mt-1 text-[11px] text-slate-400 font-mono">1-min average host CPU</p>
          </div>
        </div>
      </div>

      {error && <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-xs font-semibold text-rose-200">{error}</div>}
      {successMsg && <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-xs font-semibold text-emerald-200">{successMsg}</div>}

      {/* Filter, Sort & Search Bar */}
      <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#080b11]/90 p-4 shadow-xl backdrop-blur-md lg:flex-row lg:items-center lg:justify-between">
        {/* Role Filters */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <button
            onClick={() => setRoleFilter('all')}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition ${
              roleFilter === 'all'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/20'
                : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            All Workers ({workers.length})
          </button>
          <button
            onClick={() => setRoleFilter('dataset_worker')}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
              roleFilter === 'dataset_worker'
                ? 'bg-purple-400 text-slate-950 shadow-md shadow-purple-400/20'
                : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
            }`}
          >
            Dataset Builders ({fleetStats.datasetWorkersCount})
          </button>
          <button
            onClick={() => setRoleFilter('training_worker')}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
              roleFilter === 'training_worker'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/20'
                : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
            }`}
          >
            ML Trainers ({fleetStats.trainingWorkersCount})
          </button>
          {fleetStats.highMemCount > 0 && (
            <button
              onClick={() => setRoleFilter('high_memory')}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition ${
                roleFilter === 'high_memory'
                  ? 'bg-rose-500 text-white shadow-md shadow-rose-500/20'
                  : 'border border-rose-400/30 bg-rose-400/10 text-rose-300 hover:bg-rose-400/20'
              }`}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              High Memory ({fleetStats.highMemCount})
            </button>
          )}
        </div>

        {/* Sort & Search Inputs */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 border border-white/10 bg-black/40 rounded-xl px-3 py-1.5 text-xs">
            <ArrowUpDown className="h-3.5 w-3.5 text-slate-400" />
            <span className="text-slate-500 text-[11px]">Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-transparent text-slate-200 outline-none font-semibold cursor-pointer"
            >
              <option value="heap" className="bg-slate-900">Highest Heap %</option>
              <option value="rss" className="bg-slate-900">Highest RSS RAM</option>
              <option value="load" className="bg-slate-900">Highest Host CPU</option>
              <option value="uptime" className="bg-slate-900">Longest Uptime</option>
              <option value="id" className="bg-slate-900">Worker ID (A-Z)</option>
            </select>
          </div>

          <div className="relative w-full sm:w-56">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search worker ID / PID..."
              className="w-full rounded-xl border border-white/10 bg-black/40 pl-8 pr-3 py-1.5 text-xs text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/50"
            />
          </div>
        </div>
      </div>

      {/* Upgraded Worker Cards Grid */}
      {processedWorkers.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-white/10 p-12 text-center text-slate-500 text-xs">
          No worker heartbeats match the active filter or search criteria.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
          {processedWorkers.map((w) => {
            const isOnline = w.status === 'online';
            const m = w.metrics;
            const heapUsed = m?.heapUsedMb ?? 0;
            const heapTotal = Math.max(1, m?.heapTotalMb ?? 1);
            const heapPct = Math.min(100, Math.round((heapUsed / heapTotal) * 100));
            const rssMb = m?.rssMb ?? 0;
            const efficiency = calculateEfficiencyScore(w);
            const ageSecs = ((w.ageMs || 0) / 1000).toFixed(1);

            return (
              <article
                key={w.workerId}
                className="group relative flex flex-col justify-between rounded-2xl border border-white/10 bg-white/[0.025] p-5 transition duration-200 hover:-translate-y-0.5 hover:border-cyan-400/30 hover:bg-white/[0.04] hover:shadow-xl hover:shadow-black/40"
              >
                <div>
                  {/* Card Header */}
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                          isOnline
                            ? 'bg-emerald-400 shadow-sm shadow-emerald-400 animate-pulse'
                            : 'bg-amber-400 shadow-sm shadow-amber-400'
                        }`}
                      />
                      <span className="font-mono text-xs font-extrabold text-slate-100 truncate max-w-[180px]" title={w.workerId}>
                        {w.workerId}
                      </span>
                    </div>

                    <span
                      className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${
                        w.workerType === 'training_worker'
                          ? 'border-cyan-400/20 bg-cyan-400/10 text-cyan-300'
                          : 'border-purple-400/20 bg-purple-400/10 text-purple-300'
                      }`}
                    >
                      {w.workerType === 'training_worker' ? 'ML Training' : 'Dataset Builder'}
                    </span>
                  </div>

                  {/* Efficiency & Resource Score Gauge */}
                  <div className="mb-4 flex items-center justify-between rounded-xl border border-white/5 bg-black/30 px-3 py-2 text-xs">
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-slate-400">
                      <Sparkles className="h-3.5 w-3.5 text-amber-300" /> Worker Efficiency
                    </span>
                    <span
                      className={`font-mono text-xs font-bold ${
                        efficiency >= 85 ? 'text-emerald-300' : efficiency >= 60 ? 'text-amber-300' : 'text-rose-400'
                      }`}
                    >
                      {efficiency}% Optimal
                    </span>
                  </div>

                  {/* Heap Memory Footprint & Visual Gauge */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] font-mono text-slate-300">
                      <span className="flex items-center gap-1 text-slate-400">
                        <HardDrive className="h-3.5 w-3.5 text-slate-500" /> V8 Heap Memory
                      </span>
                      <span className="font-bold">
                        {heapUsed} / {heapTotal} MB <span className="text-slate-500">({heapPct}%)</span>
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-slate-800/80 overflow-hidden p-0.5 border border-white/5">
                      <div
                        className={`h-full transition-all duration-500 rounded-full ${
                          heapUsed > 256 || (heapPct > 88 && heapUsed > 128)
                            ? 'bg-rose-500 shadow-sm shadow-rose-500'
                            : heapUsed > 180 || (heapPct > 75 && heapUsed > 96)
                            ? 'bg-amber-400'
                            : 'bg-emerald-400'
                        }`}
                        style={{ width: `${heapPct}%` }}
                      />
                    </div>
                  </div>

                  {/* RSS & Host Resource Grid */}
                  <div className="mt-4 grid grid-cols-3 gap-2 border-t border-white/5 pt-3 text-[10px] font-mono">
                    <div className="rounded-lg border border-white/5 bg-black/20 p-2">
                      <span className="text-slate-500 block uppercase tracking-wider text-[9px]">Physical RSS</span>
                      <span className="font-bold text-slate-200">{rssMb ? `${rssMb} MB` : '—'}</span>
                    </div>
                    <div className="rounded-lg border border-white/5 bg-black/20 p-2">
                      <span className="text-slate-500 block uppercase tracking-wider text-[9px]">Host Load</span>
                      <span className="font-bold text-cyan-300">{m?.loadAverage ? m.loadAverage[0].toFixed(2) : '—'}</span>
                    </div>
                    <div className="rounded-lg border border-white/5 bg-black/20 p-2">
                      <span className="text-slate-500 block uppercase tracking-wider text-[9px]">Process Uptime</span>
                      <span className="font-bold text-slate-200">{formatDuration(m?.uptimeSecs)}</span>
                    </div>
                  </div>
                </div>

                {/* Card Footer: Metadata & Quick Action Traces */}
                <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3 text-[11px] text-slate-500">
                  <div className="flex items-center gap-2 font-mono text-[10px]">
                    {m?.pid && <span className="text-slate-400">PID: {m.pid}</span>}
                    <span className="text-slate-600">·</span>
                    <span>{ageSecs}s ago</span>
                  </div>

                  <Link
                    href={`/admin/observability?search=${encodeURIComponent(w.workerId)}`}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-cyan-300 hover:text-cyan-200 transition"
                  >
                    Log trace <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
