'use client';

import { useEffect, useState } from 'react';
import { Activity, Cpu, Server, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface WorkerData {
  status?: string;
  telemetry?: {
    cpuPercent?: number;
    rssMb?: number;
    processedJobsCount?: number;
    uptimeSecs?: number;
  };
}

export function MLWorkerObservability() {
  const [data, setData] = useState<{ worker?: WorkerData } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await fetch('/api/admin/model-operations/summary', { cache: 'no-store' });
      const json = await res.json();
      if (json.success) {
        setData(json);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) {
    return <div className="p-4 text-sm text-slate-400">Loading worker observability...</div>;
  }

  const worker = data?.worker;
  const isOnline = worker?.status === 'online';

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold text-slate-200">
          <Server className="h-4 w-4 text-slate-400" />
          ML Native Runtime Worker
        </h3>
        <div className="flex items-center gap-2 text-xs font-medium">
          {isOnline ? (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Online
            </span>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              Offline / Stale
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-white/5 bg-black/20 p-4">
          <p className="mb-1 text-xs text-slate-500 flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5" /> CPU Usage</p>
          <p className="text-xl font-mono text-slate-200">
            {worker?.telemetry?.cpuPercent != null ? `${worker.telemetry.cpuPercent.toFixed(1)}%` : '--'}
          </p>
        </div>
        
        <div className="rounded-xl border border-white/5 bg-black/20 p-4">
          <p className="mb-1 text-xs text-slate-500 flex items-center gap-1.5"><Activity className="h-3.5 w-3.5" /> RAM (RSS)</p>
          <p className="text-xl font-mono text-slate-200">
            {worker?.telemetry?.rssMb != null ? `${worker.telemetry.rssMb.toFixed(0)} MB` : '--'}
          </p>
        </div>

        <div className="rounded-xl border border-white/5 bg-black/20 p-4">
          <p className="mb-1 text-xs text-slate-500 flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> Processed Jobs</p>
          <p className="text-xl font-mono text-slate-200">
            {worker?.telemetry?.processedJobsCount ?? '--'}
          </p>
        </div>

        <div className="rounded-xl border border-white/5 bg-black/20 p-4">
          <p className="mb-1 text-xs text-slate-500 flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> Uptime</p>
          <p className="text-xl font-mono text-slate-200">
            {worker?.telemetry?.uptimeSecs ? `${(worker.telemetry.uptimeSecs / 3600).toFixed(1)}h` : '--'}
          </p>
        </div>
      </div>
    </div>
  );
}
