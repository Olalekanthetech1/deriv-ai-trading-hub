'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowLeft, CheckCircle2, Clock3, Cpu, Database, Gauge, RefreshCw, Server, Wifi, XCircle } from 'lucide-react';
import WorkerTelemetryDashboard from '@/components/admin/worker-telemetry-dashboard';

type Status = 'healthy' | 'degraded' | 'unavailable' | 'configured' | 'not-configured';
type InfrastructureData = {
  generatedAt: string;
  api: { status: Status; httpStatus: number | null; healthRttMs: number; error: string | null };
  database: { status: Status; configured: boolean; source: string; latencyMs: number | null; error: string | null; healthEndpointStatus: Status };
  mlRuntime: { status: Status; configured: boolean; source: string };
  websocket: { status: Status; source: string };
  cron: { status: Status; scheduleSource: string; nextRun: string | null };
  process: { status: Status; uptimeSeconds: number; nodeVersion: string; memory: NodeJS.MemoryUsage };
  health: Record<string, unknown>;
};

const statusText: Record<Status, string> = {
  healthy: 'HEALTHY', degraded: 'DEGRADED', unavailable: 'UNAVAILABLE', configured: 'CONFIGURED', 'not-configured': 'NOT CONFIGURED',
};

function StatusPill({ status }: { status: Status }) {
  const healthy = status === 'healthy' || status === 'configured';
  const degraded = status === 'degraded';
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wider ${healthy ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : degraded ? 'border-amber-400/20 bg-amber-400/10 text-amber-300' : 'border-rose-400/20 bg-rose-400/10 text-rose-300'}`}>{healthy ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}{statusText[status]}</span>;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes}m`;
}

function Panel({ title, icon: Icon, status, children }: { title: string; icon: typeof Server; status: Status; children: React.ReactNode }) {
  return <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-4 flex items-start justify-between gap-3"><div className="flex items-center gap-3"><div className="rounded-xl border border-white/10 bg-black/20 p-2.5"><Icon className="h-5 w-5 text-cyan-300" /></div><div><h2 className="font-bold">{title}</h2><p className="mt-0.5 text-[11px] text-slate-600">LIVE RUNTIME DATA</p></div></div><StatusPill status={status} /></div>{children}</article>;
}

export default function RuntimeInfrastructurePage() {
  const [data, setData] = useState<InfrastructureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/infrastructure', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Infrastructure diagnostics unavailable.');
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Infrastructure diagnostics unavailable.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  const healthyDomains = useMemo(() => data ? [data.api.status, data.database.status, data.mlRuntime.status, data.websocket.status, data.process.status].filter(s => s === 'healthy').length : 0, [data]);

  return <main className="min-h-screen bg-[#05070b] px-4 py-5 text-slate-100 sm:px-6 lg:px-8"><div className="mx-auto max-w-[1500px]">
    <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><Link href="/admin" className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 hover:bg-white/10"><ArrowLeft className="h-5 w-5" /></Link><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><Server className="h-6 w-6 text-cyan-300" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">5B-6</p><h1 className="text-2xl font-black sm:text-3xl">Runtime & Infrastructure</h1><p className="mt-1 text-xs text-slate-500">Live service health, latency and runtime diagnostics. No synthetic metrics.</p></div></div><div className="flex flex-wrap items-center gap-2"><button onClick={() => setAutoRefresh(v => !v)} className={`rounded-xl border px-3 py-2 text-xs font-semibold ${autoRefresh ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : 'border-white/10 bg-white/5 text-slate-400'}`}>{autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF'}</button><button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button></div></header>

    {error && <div className="mb-5 rounded-2xl border border-rose-400/20 bg-rose-400/5 px-4 py-3 text-sm text-rose-200">{error}</div>}

    <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.04] p-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-300">Health domains</p><p className="mt-1 text-2xl font-black">{data ? `${healthyDomains}/5` : '—'}</p><p className="mt-1 text-xs text-slate-500">Observed from the live runtime.</p></div><div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.04] p-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Health RTT</p><p className="mt-1 text-2xl font-black">{data ? `${data.api.healthRttMs} ms` : '—'}</p><p className="mt-1 text-xs text-slate-500">Server-side health probe.</p></div><div className="rounded-2xl border border-purple-400/15 bg-purple-400/[0.04] p-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-purple-300">Process uptime</p><p className="mt-1 text-2xl font-black">{data ? formatUptime(data.process.uptimeSeconds) : '—'}</p><p className="mt-1 text-xs text-slate-500">Current application process.</p></div><div className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.04] p-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-amber-300">Last sample</p><p className="mt-1 text-sm font-bold">{data ? new Date(data.generatedAt).toLocaleTimeString() : '—'}</p><p className="mt-1 text-xs text-slate-500">Automatically refreshed every 15s when enabled.</p></div></section>

    <section className="grid gap-5 lg:grid-cols-2">
      <Panel title="API Health" icon={Activity} status={data?.api.status || 'unavailable'}><div className="grid grid-cols-2 gap-3"><Metric label="HTTP" value={data?.api.httpStatus ?? '—'} /><Metric label="Health RTT" value={data ? `${data.api.healthRttMs} ms` : '—'} /></div>{data?.api.error && <p className="mt-4 text-xs text-rose-300">{data.api.error}</p>}</Panel>
      <Panel title="Database" icon={Database} status={data?.database.status || 'unavailable'}><div className="grid grid-cols-2 gap-3"><Metric label="Connection" value={data ? (data.database.configured ? 'CONFIGURED' : 'NOT CONFIGURED') : '—'} /><Metric label="DB probe" value={data?.database.latencyMs != null ? `${data.database.latencyMs} ms` : '—'} /></div><Row label="Live evidence" value={data?.database.source || '—'} /><Row label="Health endpoint" value={data ? statusText[data.database.healthEndpointStatus] : '—'} />{data?.database.error && <p className="mt-4 break-words text-xs text-rose-300">{data.database.error}</p>}<p className="mt-4 text-xs leading-5 text-slate-500">The dashboard now runs a real lightweight PostgreSQL probe. A configured DATABASE_URL is shown as configured, while HEALTHY requires a successful live query.</p></Panel>
      <Panel title="Python ML Runtime" icon={Cpu} status={data?.mlRuntime.status || 'unavailable'}><Row label="Service URL configured" value={data ? (data.mlRuntime.configured ? 'YES' : 'NO') : '—'} /><Row label="Health evidence" value={data?.mlRuntime.source || '—'} /><p className="mt-4 text-xs leading-5 text-slate-500">This panel distinguishes configuration from actual runtime health and does not invent engine availability.</p></Panel>
      <Panel title="Deriv WebSocket" icon={Wifi} status={data?.websocket.status || 'unavailable'}><Row label="Observed status" value={data ? statusText[data.websocket.status] : '—'} /><Row label="Evidence source" value={data?.websocket.source || '—'} /><p className="mt-4 text-xs leading-5 text-slate-500">If the health service does not publish a WebSocket state, the dashboard intentionally shows UNAVAILABLE rather than assuming connectivity.</p></Panel>
      <Panel title="Process Runtime" icon={Gauge} status={data?.process.status || 'unavailable'}><Row label="Node.js" value={data?.process.nodeVersion || '—'} /><Row label="Uptime" value={data ? formatUptime(data.process.uptimeSeconds) : '—'} /><Row label="RSS" value={data ? `${Math.round(data.process.memory.rss / 1024 / 1024)} MB` : '—'} /><Row label="Heap used" value={data ? `${Math.round(data.process.memory.heapUsed / 1024 / 1024)} MB` : '—'} /></Panel>
      <Panel title="Cron / Scheduled Runtime" icon={Clock3} status={data?.cron.status || 'not-configured'}><Row label="Scheduler credential" value={data ? statusText[data.cron.status] : '—'} /><Row label="Schedule source" value={data?.cron.scheduleSource || '—'} /><Row label="Next run" value={data?.cron.nextRun || 'Not exposed by runtime'} /><p className="mt-4 text-xs leading-5 text-slate-500">No next-run time is fabricated. It will remain unavailable until the runtime exposes a verifiable schedule.</p></Panel>
    </section>

    {/* Dedicated Worker Telemetry Section */}
    <div className="mt-8">
      <WorkerTelemetryDashboard />
    </div>

    <section className="mt-5 rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="flex items-center gap-2 text-sm font-bold"><Server className="h-4 w-4 text-cyan-300" />Runtime pipeline</div><div className="mt-4 grid gap-2 sm:grid-cols-5">{['NETWORK / API', 'DATABASE', 'ML RUNTIME', 'WEBSOCKET', 'PROCESS'].map((label, index) => <div key={label} className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-xs font-semibold text-slate-300"><span className="text-cyan-300">0{index + 1}</span>{label}</div>)}</div></section>
  </div></main>;
}

function Metric({ label, value }: { label: string; value: string | number }) { return <div className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-600">{label}</p><p className="mt-1 text-lg font-black text-slate-100">{value}</p></div>; }
function Row({ label, value }: { label: string; value: string }) { return <div className="flex items-center justify-between gap-4 border-b border-white/5 py-2.5 text-xs last:border-0"><span className="text-slate-500">{label}</span><span className="font-semibold text-slate-200">{value}</span></div>; }
