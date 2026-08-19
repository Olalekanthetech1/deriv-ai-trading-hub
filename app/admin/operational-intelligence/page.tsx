'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, ArrowLeft, BrainCircuit, CheckCircle2, Database, Gauge, RefreshCw, Server, ShieldAlert, XCircle } from 'lucide-react';

type Health = { status?: string; timestamp?: string; services?: { database?: string; dbLatencyMs?: number | null; pythonDaemon?: string; daemonLatencyMs?: number | null }; env?: { derivAppIdSet?: boolean } };
type Stats = { summary?: { totalTrades?: number; totalTicks?: number; totalModels?: number; activeModel?: string; activeAccuracy?: number | null; winRate?: number } };
type Registry = { models?: Array<{ model_id?: string; status?: string; accuracy?: number | null; trained_at?: string }> };
type Event = { id: string | number; category: string; severity: string; service?: string | null; eventType: string; message: string; symbol?: string | null; modelId?: string | null; createdAt: string };

type SourceState = { health: Health | null; stats: Stats | null; registry: Registry | null; events: Event[]; coverage: Record<string, string>; loading: boolean; error: string | null };
const initial: SourceState = { health: null, stats: null, registry: null, events: [], coverage: {}, loading: true, error: null };

function time(value?: string) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(); }
function num(value?: number | null) { return Number.isFinite(value) ? Number(value).toLocaleString() : '—'; }
function status(ok: boolean | undefined) { return ok === true ? 'healthy' : ok === false ? 'degraded' : 'unknown'; }

export default function OperationalIntelligencePage() {
  const [state, setState] = useState<SourceState>(initial);

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const responses = await Promise.all([
        fetch('/api/health', { cache: 'no-store' }),
        fetch('/api/admin/stats', { cache: 'no-store' }),
        fetch('/api/ml/registry?status=production', { cache: 'no-store' }),
        fetch('/api/admin/observability?range=24h&severity=all&limit=100', { cache: 'no-store' }),
      ]);
      if (responses.some(r => r.status === 401)) { window.location.replace('/admin'); return; }
      const [health, stats, registry, observability] = await Promise.all(responses.map(r => r.json().catch(() => null)));
      const obs = observability || {};
      setState({ health, stats, registry, events: Array.isArray(obs.events) ? obs.events : [], coverage: obs.coverage || {}, loading: false, error: responses.some(r => !r.ok && r.status !== 503) ? 'One or more operational sources returned an error.' : null });
    } catch (error) {
      setState(s => ({ ...s, loading: false, error: error instanceof Error ? error.message : 'Unable to load operational intelligence.' }));
    }
  }, []);

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); return () => window.clearInterval(timer); }, [load]);

  const db = status(state.health?.services?.database === 'connected');
  const ml = status(state.health?.services?.pythonDaemon === 'connected');
  const system = state.health?.status === 'healthy' ? 'healthy' : state.health?.status === 'degraded' ? 'degraded' : 'unknown';
  const productionModels = state.registry?.models?.filter(m => String(m.status || '').toLowerCase() === 'production') || [];
  const activeModel = Boolean(state.stats?.summary?.activeModel && !String(state.stats.summary.activeModel).toLowerCase().includes('unavailable'));
  const criticalEvents = useMemo(() => state.events.filter(e => ['critical', 'error', 'warn'].includes(String(e.severity).toLowerCase())).slice(0, 12), [state.events]);
  const degradedDomains = [system !== 'healthy' && 'system', db !== 'healthy' && 'database', ml !== 'healthy' && 'ml runtime', !activeModel && 'production model'].filter(Boolean) as string[];

  return <main className="min-h-screen bg-[#05070b] text-slate-100"><div className="mx-auto max-w-[1550px] px-4 py-5 sm:px-6 lg:px-8">
    <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3"><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><Gauge className="h-6 w-6 text-cyan-300" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">Operations · Cross-System View</p><h1 className="text-2xl font-black tracking-tight sm:text-3xl">Operational Intelligence</h1><p className="mt-1 text-xs text-slate-500">Correlates authoritative health, telemetry, ML registry and production statistics without inventing state.</p></div></div>
      <div className="flex flex-wrap gap-2"><Link href="/admin/control-plane" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300"><ArrowLeft className="h-4 w-4" />Control Plane</Link><button onClick={() => void load()} disabled={state.loading} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200"><RefreshCw className={`h-4 w-4 ${state.loading ? 'animate-spin' : ''}`} />Refresh</button></div>
    </header>

    {state.error && <div className="mb-5 rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-4 text-sm text-amber-200">{state.error}</div>}

    <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <DomainCard title="System" value={system} icon={Activity} tone={system} detail={time(state.health?.timestamp)} />
      <DomainCard title="Database" value={db} icon={Database} tone={db} detail={state.health?.services?.dbLatencyMs != null ? `${state.health.services.dbLatencyMs} ms latency` : 'Latency unavailable'} />
      <DomainCard title="ML Runtime" value={ml} icon={BrainCircuit} tone={ml} detail={state.health?.services?.daemonLatencyMs != null ? `${state.health.services.daemonLatencyMs} ms latency` : 'Latency unavailable'} />
      <DomainCard title="Production Model" value={activeModel ? 'active' : 'not confirmed'} icon={Server} tone={activeModel ? 'healthy' : 'degraded'} detail={`${productionModels.length} production registry record${productionModels.length === 1 ? '' : 's'}`} />
    </section>

    <section className="mb-6 grid gap-4 lg:grid-cols-[1.15fr_.85fr]">
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
        <div className="mb-5 flex items-center justify-between"><div><h2 className="text-base font-bold">Operational Risk Picture</h2><p className="mt-1 text-xs text-slate-500">A decision aid, not a replacement for the source pages.</p></div><ShieldAlert className="h-5 w-5 text-amber-300" /></div>
        {degradedDomains.length ? <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-4"><p className="text-sm font-semibold text-amber-200">Attention required in {degradedDomains.length} domain{degradedDomains.length === 1 ? '' : 's'}.</p><p className="mt-1 text-xs text-slate-500">{degradedDomains.join(' · ')}</p></div> : <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4"><div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-300" /><p className="text-sm font-semibold text-emerald-200">No degraded domain is currently reported.</p></div></div>}
        <div className="mt-4 grid gap-3 sm:grid-cols-3"><Metric label="Ticks" value={num(state.stats?.summary?.totalTicks)} /><Metric label="Trades" value={num(state.stats?.summary?.totalTrades)} /><Metric label="Models" value={num(state.stats?.summary?.totalModels)} /></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2"><Metric label="Win rate" value={Number.isFinite(state.stats?.summary?.winRate) ? `${state.stats?.summary?.winRate}%` : '—'} /><Metric label="Active accuracy" value={Number.isFinite(state.stats?.summary?.activeAccuracy) ? `${state.stats?.summary?.activeAccuracy}%` : '—'} /></div>
      </article>

      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="text-base font-bold">Telemetry Coverage</h2><p className="mt-1 text-xs text-slate-500">Unavailable means not confirmed by the current source.</p></div><Activity className="h-5 w-5 text-cyan-300" /></div><div className="space-y-2">{Object.entries(state.coverage).map(([key, value]) => <div key={key} className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-3 py-2"><span className="text-xs text-slate-400">{key}</span><span className={`text-[10px] font-bold tracking-wider ${value === 'AVAILABLE' ? 'text-emerald-300' : 'text-amber-300'}`}>{value}</span></div>)}{!Object.keys(state.coverage).length && <p className="text-xs text-slate-600">No coverage data reported.</p>}</div><Link href="/admin/observability" className="mt-4 inline-flex text-xs font-semibold text-cyan-300">Inspect telemetry →</Link></article>
    </section>

    <section className="grid gap-4 lg:grid-cols-[1.25fr_.75fr]">
      <article className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]"><div className="flex items-center justify-between border-b border-white/10 p-4"><div><h2 className="text-sm font-bold">Recent Actionable Telemetry</h2><p className="mt-1 text-xs text-slate-600">Last 24 hours · persisted or explicitly instrumented events only.</p></div><Link href="/admin/incident-center" className="text-xs font-semibold text-cyan-300">Incident Center →</Link></div>{criticalEvents.length ? <div className="divide-y divide-white/5">{criticalEvents.map(event => <div key={`${event.id}-${event.createdAt}`} className="p-4"><div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><Severity value={event.severity} /><span className="text-[10px] uppercase tracking-wider text-slate-600">{event.service || event.category}</span>{event.symbol && <span className="font-mono text-[10px] text-slate-600">{event.symbol}</span>}</div><p className="mt-2 text-sm font-semibold text-slate-300">{event.eventType}</p><p className="mt-1 text-xs leading-5 text-slate-500">{event.message}</p></div><span className="shrink-0 font-mono text-[10px] text-slate-600">{time(event.createdAt)}</span></div></div>)}</div> : <div className="p-10 text-center"><CheckCircle2 className="mx-auto h-7 w-7 text-emerald-300" /><p className="mt-2 text-sm font-semibold text-slate-300">No actionable telemetry currently reported.</p></div>}</article>

      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><h2 className="text-sm font-bold">Investigation Paths</h2><p className="mt-1 text-xs text-slate-600">Move from detection to evidence without guessing.</p><div className="mt-4 space-y-2"><Path href="/admin/command-center" title="Command Center" detail="System readiness and dependency health" /><Path href="/admin/observability" title="Observability" detail="Raw persisted telemetry and coverage" /><Path href="/admin/incident-center" title="Incident Center" detail="Severity triage and response signals" /><Path href="/admin/signal-forensics" title="Signal Forensics" detail="Trace signal evidence and lineage" /><Path href="/admin/final-verification" title="Production Verification" detail="Controlled end-to-end verification" /></div></article>
    </section>
  </div></main>;
}

function DomainCard({ title, value, icon: Icon, tone, detail }: { title: string; value: string; icon: typeof Activity; tone: string; detail: string }) { const good = tone === 'healthy'; const bad = tone === 'degraded'; return <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-4 flex items-start justify-between"><div className="rounded-xl border border-white/10 bg-black/20 p-2.5"><Icon className="h-5 w-5 text-cyan-300" /></div>{good ? <CheckCircle2 className="h-5 w-5 text-emerald-300" /> : bad ? <AlertTriangle className="h-5 w-5 text-amber-300" /> : <XCircle className="h-5 w-5 text-slate-500" />}</div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{title}</p><p className="mt-2 text-lg font-bold capitalize">{value}</p><p className="mt-1 text-xs text-slate-600">{detail}</p></article>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-600">{label}</p><p className="mt-1 text-lg font-bold text-slate-200">{value}</p></div>; }
function Severity({ value }: { value: string }) { const cls = value === 'critical' ? 'border-red-400/20 bg-red-400/10 text-red-200' : value === 'error' ? 'border-rose-400/20 bg-rose-400/10 text-rose-200' : 'border-amber-400/20 bg-amber-400/10 text-amber-200'; return <span className={`rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${cls}`}>{value}</span>; }
function Path({ href, title, detail }: { href: string; title: string; detail: string }) { return <Link href={href} className="block rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-cyan-400/20 hover:bg-white/[0.03]"><p className="text-xs font-semibold text-slate-200">{title}</p><p className="mt-1 text-[11px] text-slate-600">{detail}</p></Link>; }
