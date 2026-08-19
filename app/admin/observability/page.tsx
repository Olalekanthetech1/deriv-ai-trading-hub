'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Bell,
  CheckCircle2,
  Clock3,
  Database,
  Filter,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import { adminFetch } from '@/lib/admin-client-auth';

type EventRow = {
  id: string | number;
  category: string;
  severity: string;
  service: string | null;
  eventType: string;
  message: string;
  requestId: string | null;
  correlationId: string | null;
  symbol: string | null;
  modelId: string | null;
  createdAt: string;
  source: string;
  metadata?: unknown;
};

type Coverage = Record<string, 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'>;

const severityStyles: Record<string, string> = {
  debug: 'border-slate-400/20 bg-slate-400/10 text-slate-300',
  info: 'border-cyan-400/20 bg-cyan-400/10 text-cyan-200',
  warn: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
  error: 'border-rose-400/20 bg-rose-400/10 text-rose-200',
  critical: 'border-red-400/30 bg-red-400/15 text-red-200',
};

function CoverageCard({ title, value, icon: Icon }: { title: string; value: Coverage[string]; icon: typeof Activity }) {
  const healthy = value === 'AVAILABLE';
  const partial = value === 'PARTIAL';
  return (
    <div className={`rounded-2xl border p-4 ${healthy ? 'border-emerald-400/15 bg-emerald-400/[0.04]' : partial ? 'border-amber-400/15 bg-amber-400/[0.04]' : 'border-white/10 bg-white/[0.025]'}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-300"><Icon className="h-4 w-4" />{title}</div>
        {healthy ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : partial ? <AlertCircle className="h-4 w-4 text-amber-300" /> : <XCircle className="h-4 w-4 text-slate-500" />}
      </div>
      <p className={`text-xs font-bold tracking-wider ${healthy ? 'text-emerald-300' : partial ? 'text-amber-300' : 'text-slate-500'}`}>{value}</p>
    </div>
  );
}

export default function ObservabilityPage() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [coverage, setCoverage] = useState<Coverage>({});
  const [summary, setSummary] = useState({ total: 0, errors: 0, warnings: 0, critical: 0 });
  const [range, setRange] = useState('24h');
  const [category, setCategory] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [service, setService] = useState('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [testAlertLoading, setTestAlertLoading] = useState(false);
  const [testAlertMsg, setTestAlertMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ range, category, severity, service, q: query, limit: '150' });
      const response = await adminFetch(`/api/admin/observability?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Unable to load observability telemetry.');
      setEvents(Array.isArray(data.events) ? data.events : []);
      setCoverage(data.coverage || {});
      setSummary(data.summary || { total: 0, errors: 0, warnings: 0, critical: 0 });
      setGeneratedAt(data.generatedAt || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load observability telemetry.');
    } finally {
      setLoading(false);
    }
  }, [range, category, severity, service, query]);

  useEffect(() => { load(); }, [load]);

  async function handleSendTestAlert() {
    setTestAlertLoading(true);
    setTestAlertMsg(null);
    try {
      const res = await adminFetch('/api/admin/test-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'all' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Failed to dispatch (HTTP ${res.status})`);
      setTestAlertMsg('✅ Test alert dispatched to Telegram & Email successfully!');
      setTimeout(() => setTestAlertMsg(null), 6000);
    } catch (err: any) {
      setTestAlertMsg(`❌ ${err.message || 'Failed to dispatch alert'}`);
    } finally {
      setTestAlertLoading(false);
    }
  }

  const services = useMemo(() => Array.from(new Set(events.map(event => event.service).filter(Boolean) as string[])).sort(), [events]);

  return (
    <main className="min-h-screen bg-[#05070b] text-slate-100">
      <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
        <header className="mb-6 rounded-3xl border border-white/10 bg-white/[0.03] p-5 shadow-2xl shadow-black/20 backdrop-blur-xl">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-300"><Activity className="h-4 w-4" />5B-7 · Observability</div>
              <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Operational Telemetry</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Persisted application, trading, ML, security and system events with explicit telemetry coverage. Missing instrumentation is shown as unavailable instead of being inferred.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={handleSendTestAlert} disabled={testAlertLoading} className="inline-flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-400/20 disabled:opacity-50 transition"><Bell className={`h-4 w-4 ${testAlertLoading ? 'animate-bounce' : ''}`} />{testAlertLoading ? 'Sending Alert…' : '🔔 Send Test Alert'}</button>
              <Link href="/admin" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10"><ArrowLeft className="h-4 w-4" />Admin Center</Link>
              <button onClick={load} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button>
            </div>
          </div>
          {testAlertMsg && <div className={`mt-3 rounded-xl border p-3 text-xs font-medium ${testAlertMsg.startsWith('✅') ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-rose-400/30 bg-rose-400/10 text-rose-200'}`}>{testAlertMsg}</div>}
        </header>

        <section className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <CoverageCard title="Persisted Events" value={coverage.persistedEvents || 'UNAVAILABLE'} icon={Database} />
          <CoverageCard title="Trading Logs" value={coverage.tradingLogs || 'UNAVAILABLE'} icon={Activity} />
          <CoverageCard title="ML Logs" value={coverage.mlLogs || 'UNAVAILABLE'} icon={Server} />
          <CoverageCard title="Model Registry" value={coverage.modelRegistry || 'UNAVAILABLE'} icon={TerminalSquare} />
          <CoverageCard title="Application / API" value={coverage.applicationApi || 'UNAVAILABLE'} icon={ShieldCheck} />
        </section>

        <section className="mb-5 grid gap-3 grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Events</p><p className="mt-1 text-2xl font-black">{summary.total}</p></div>
          <div className="rounded-2xl border border-rose-400/15 bg-rose-400/[0.03] p-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-rose-300/70">Errors</p><p className="mt-1 text-2xl font-black text-rose-200">{summary.errors}</p></div>
          <div className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.03] p-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-amber-300/70">Warnings</p><p className="mt-1 text-2xl font-black text-amber-200">{summary.warnings}</p></div>
          <div className="rounded-2xl border border-red-400/15 bg-red-400/[0.03] p-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-red-300/70">Critical</p><p className="mt-1 text-2xl font-black text-red-200">{summary.critical}</p></div>
        </section>

        <section className="mb-5 rounded-2xl border border-white/10 bg-white/[0.025] p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-bold"><Filter className="h-4 w-4 text-cyan-300" />Telemetry filters</div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <select value={range} onChange={event => setRange(event.target.value)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-xs text-slate-200 outline-none"><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select>
            <select value={category} onChange={event => setCategory(event.target.value)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-xs text-slate-200 outline-none"><option value="all">All categories</option><option value="application">Application</option><option value="trading">Trading</option><option value="ml">ML</option><option value="api">API</option><option value="system">System</option><option value="security">Security</option><option value="error">Error</option></select>
            <select value={severity} onChange={event => setSeverity(event.target.value)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-xs text-slate-200 outline-none"><option value="all">All severity</option><option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warning</option><option value="error">Error</option><option value="critical">Critical</option></select>
            <select value={service} onChange={event => setService(event.target.value)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-xs text-slate-200 outline-none"><option value="all">All services</option>{services.map(item => <option key={item} value={item}>{item}</option>)}</select>
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search event, request or correlation ID" className="w-full rounded-xl border border-white/10 bg-black/30 py-2.5 pl-9 pr-3 text-xs text-slate-200 outline-none placeholder:text-slate-600" /></div>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
          <div className="flex flex-col gap-2 border-b border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-sm font-bold">Event Stream</h2><p className="mt-1 text-xs text-slate-600">Source-backed telemetry only.</p></div>{generatedAt && <div className="flex items-center gap-1.5 text-[10px] text-slate-600"><Clock3 className="h-3.5 w-3.5" />Generated {new Date(generatedAt).toLocaleTimeString()}</div>}</div>
          {error ? <div className="m-4 rounded-xl border border-rose-400/20 bg-rose-400/5 p-4 text-sm text-rose-200">{error}</div> : loading && !events.length ? <div className="flex items-center justify-center gap-2 p-12 text-sm text-slate-500"><RefreshCw className="h-4 w-4 animate-spin" />Loading telemetry…</div> : !events.length ? <div className="p-12 text-center"><Activity className="mx-auto h-8 w-8 text-slate-700" /><p className="mt-3 text-sm font-semibold text-slate-400">No persisted events match the current filters.</p><p className="mt-1 text-xs text-slate-600">This is an empty data state, not synthetic telemetry.</p></div> : <div className="divide-y divide-white/5">{events.map(event => <article key={`${event.source}-${event.id}`} className="p-4 transition hover:bg-white/[0.02]"><div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${severityStyles[event.severity] || severityStyles.info}`}>{event.severity}</span><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-600">{event.category}</span><span className="text-[10px] text-slate-600">{event.service || 'service unavailable'}</span><span className="text-[10px] font-mono text-slate-700">{event.source}</span></div><h3 className="mt-2 text-sm font-semibold text-slate-200">{event.eventType}</h3><p className="mt-1 break-words text-xs leading-5 text-slate-500">{event.message}</p></div><div className="shrink-0 text-left xl:text-right"><p className="text-[10px] font-mono text-slate-600">{new Date(event.createdAt).toLocaleString()}</p>{event.symbol && <p className="mt-1 text-[10px] font-mono text-slate-500">Symbol: {event.symbol}</p>}{event.modelId && <p className="mt-1 max-w-xs truncate text-[10px] font-mono text-slate-600">Model: {event.modelId}</p>}{event.requestId && <p className="mt-1 max-w-xs truncate text-[10px] font-mono text-slate-700">Request: {event.requestId}</p>}{event.correlationId && <p className="mt-1 max-w-xs truncate text-[10px] font-mono text-slate-700">Correlation: {event.correlationId}</p>}</div></div></article>)}</div>}
        </section>

        <footer className="mt-5 rounded-2xl border border-cyan-400/10 bg-cyan-400/[0.025] p-4 text-xs leading-5 text-slate-500"><span className="font-semibold text-cyan-300">Integrity rule:</span> configured services are not treated as healthy merely because an environment variable exists. Observability likewise reports only persisted or explicitly instrumented telemetry. Application-wide/API telemetry will expand as more production paths emit correlation-aware events.</footer>
      </div>
    </main>
  );
}
