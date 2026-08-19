'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowLeft, BrainCircuit, CheckCircle2, Clock3, ExternalLink, Filter, Gauge, RefreshCw, Search, ShieldAlert, XCircle } from 'lucide-react';
import { AttributionAnalyticsWidget, type AttributionDiagnosticsData } from '@/components/admin/attribution-analytics-widget';

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
  metadata?: Record<string, unknown> | null;
};
type Coverage = Record<string, string>;
type Range = '24h' | '7d' | '30d';

function numberValue(value: unknown) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function stringValue(value: unknown, fallback = 'UNAVAILABLE') { return typeof value === 'string' && value.trim() ? value : fallback; }
function boolValue(value: unknown) { return value === true; }
function formatTime(value?: string | null) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(); }
function severityLabel(value: string) { return value === 'warn' ? 'warning' : value; }

export default function SignalForensicsPage() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [coverage, setCoverage] = useState<Coverage>({});
  const [symbol, setSymbol] = useState('');
  const [query, setQuery] = useState('');
  const [model, setModel] = useState('');
  const [severity, setSeverity] = useState('all');
  const [decision, setDecision] = useState<'all' | 'accepted' | 'blocked'>('all');
  const [range, setRange] = useState<Range>('24h');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [selected, setSelected] = useState<EventRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attribution, setAttribution] = useState<AttributionDiagnosticsData | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ range, category: 'all', severity, symbol, model, q: query, limit: '300' });
      const [obsRes, attrRes] = await Promise.all([
        fetch(`/api/admin/observability?${params.toString()}`, { cache: 'no-store' }),
        fetch(`/api/signals/attribution?symbol=${symbol || 'all'}`, { cache: 'no-store' }),
      ]);
      if (obsRes.status === 401) { window.location.replace('/admin'); return; }
      const data = await obsRes.json().catch(() => ({}));
      if (!obsRes.ok) throw new Error(data?.error || `Signal telemetry returned HTTP ${obsRes.status}.`);
      setEvents(Array.isArray(data.events) ? data.events.filter((event: EventRow) => ['trading', 'ml', 'api'].includes(event.category)) : []);
      setCoverage(data.coverage || {});

      const attrData = await attrRes.json().catch(() => ({}));
      if (attrData.success && attrData.diagnostics) {
        setAttribution(attrData.diagnostics);
      }

      setLastRefresh(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load signal forensics.');
    } finally { setLoading(false); }
  }, [model, query, range, severity, symbol]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  const tradeEvents = useMemo(() => events.filter(e => e.category === 'trading'), [events]);
  const modelEvents = useMemo(() => events.filter(e => e.category === 'ml'), [events]);
  const apiEvents = useMemo(() => events.filter(e => e.category === 'api'), [events]);
  const decisions = useMemo(() => tradeEvents.filter(e => e.eventType === 'signal_prediction_completed'), [tradeEvents]);
  const failedPredictions = useMemo(() => tradeEvents.filter(e => e.eventType === 'signal_prediction_failed'), [tradeEvents]);
  const acceptedDecisions = useMemo(() => decisions.filter(e => boolValue(e.metadata?.strategyGateAccepted)), [decisions]);
  const filteredDecisions = useMemo(() => decisions.filter(e => {
    if (decision === 'accepted' && !boolValue(e.metadata?.strategyGateAccepted)) return false;
    if (decision === 'blocked' && boolValue(e.metadata?.strategyGateAccepted)) return false;
    return true;
  }), [decision, decisions]);
  const latest = filteredDecisions[0] ?? decisions[0] ?? null;

  return <main className="min-h-screen bg-[#05070b] text-slate-100">
    <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
      <header className="mb-6 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><BrainCircuit className="h-6 w-6 text-cyan-300" /></div>
            <div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">Trading Intelligence · Forensics</p><h1 className="text-2xl font-black tracking-tight sm:text-3xl">Signal Forensics</h1><p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">Evidence-first investigation of persisted production decisions, model coverage and request lineage. Missing evidence stays unavailable.</p></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/intelligence" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300"><ArrowLeft className="h-4 w-4" />Trading Intelligence</Link>
            <Link href="/admin/observability" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300"><ExternalLink className="h-4 w-4" />Observability</Link>
            <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button>
            <button onClick={() => setAutoRefresh(v => !v)} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300"><Activity className="h-4 w-4" />Auto {autoRefresh ? 'ON' : 'OFF'}</button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-[10px] text-slate-600"><span>Last refresh: {formatTime(lastRefresh)}</span><span>•</span><span>Window: {range}</span><span>•</span><span>Polling: {autoRefresh ? '15s' : 'paused'}</span></div>
      </header>

      {error && <div className="mb-5 rounded-2xl border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{error}</div>}

      <section className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label="Decisions" value={decisions.length} icon={Gauge} />
        <Metric label="Gate accepted" value={acceptedDecisions.length} icon={CheckCircle2} />
        <Metric label="Prediction failures" value={failedPredictions.length} icon={ShieldAlert} />
        <Metric label="ML evidence" value={modelEvents.length} icon={BrainCircuit} />
        <Metric label="API evidence" value={apiEvents.length} icon={Activity} />
      </section>

      <section className="mb-5 rounded-2xl border border-cyan-400/10 bg-cyan-400/[0.025] p-4">
        <div className="mb-3 flex items-center gap-2"><Gauge className="h-4 w-4 text-cyan-300" /><h2 className="text-sm font-bold">Decision Lineage</h2></div>
        <p className="text-xs leading-5 text-slate-500">Production prediction events carry correlation ID, final decision, confidence, strategy gate, risk tier, market regime, anomaly score, duration and model coverage. Select a row below to inspect the complete persisted evidence.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <LineageStat label="Latest decision" value={latest ? stringValue(latest.metadata?.finalDecision) : 'UNAVAILABLE'} />
          <LineageStat label="Confidence" value={latest ? `${numberValue(latest.metadata?.confidence)?.toFixed(1) ?? '—'}%` : 'UNAVAILABLE'} />
          <LineageStat label="Gate" value={latest ? (boolValue(latest.metadata?.strategyGateAccepted) ? 'ACCEPTED' : 'BLOCKED') : 'UNAVAILABLE'} />
          <LineageStat label="Correlation" value={latest?.correlationId || 'UNAVAILABLE'} />
        </div>
      </section>

      <section className="mb-5 rounded-2xl border border-white/10 bg-white/[0.025] p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-bold"><Filter className="h-4 w-4 text-cyan-300" />Forensic controls</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="relative lg:col-span-2"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search event, request, model or correlation" className="w-full rounded-xl border border-white/10 bg-black/30 py-2.5 pl-9 pr-3 text-xs text-slate-200 outline-none focus:border-cyan-400/40" /></label>
          <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="Symbol" className="rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-xs text-slate-200 outline-none focus:border-cyan-400/40" />
          <input value={model} onChange={e => setModel(e.target.value)} placeholder="Model" className="rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-xs text-slate-200 outline-none focus:border-cyan-400/40" />
          <select value={range} onChange={e => setRange(e.target.value as Range)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-xs text-slate-200 outline-none"><option value="24h">Last 24h</option><option value="7d">Last 7d</option><option value="30d">Last 30d</option></select>
          <select value={severity} onChange={e => setSeverity(e.target.value)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-xs text-slate-200 outline-none"><option value="all">All severity</option><option value="info">Info</option><option value="warn">Warning</option><option value="error">Error</option><option value="critical">Critical</option></select>
        </div>
        <div className="mt-3 flex flex-wrap gap-2"><span className="text-[10px] uppercase tracking-wider text-slate-600">Decision:</span>{(['all', 'accepted', 'blocked'] as const).map(value => <button key={value} onClick={() => setDecision(value)} className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${decision === value ? 'bg-cyan-400/10 text-cyan-200 ring-1 ring-cyan-400/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}>{value}</button>)}</div>
      </section>

      <section className="mb-5 grid gap-4 lg:grid-cols-3"><EvidenceCard title="ML Runtime Evidence" events={modelEvents} coverage={coverage.mlLogs} icon={BrainCircuit} /><EvidenceCard title="Trading Evidence" events={tradeEvents} coverage={coverage.tradingLogs} icon={Activity} /><EvidenceCard title="API Evidence" events={apiEvents} coverage={coverage.applicationApi} icon={ShieldAlert} /></section>

      {/* Attribution Analytics & Regime Multipliers Widget */}
      <section className="mb-5">
        <AttributionAnalyticsWidget data={attribution} loading={loading} />
      </section>

      <section className="mb-5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
        <div className="flex items-center justify-between border-b border-white/10 p-4"><div><h2 className="text-sm font-bold">Production Decision Ledger</h2><p className="mt-1 text-xs text-slate-600">{filteredDecisions.length} persisted decisions match the current evidence filters.</p></div><Clock3 className="h-4 w-4 text-slate-600" /></div>
        {loading && !filteredDecisions.length ? <div className="p-12 text-center text-sm text-slate-500">Loading decision evidence…</div> : !filteredDecisions.length ? <div className="p-12 text-center"><XCircle className="mx-auto h-8 w-8 text-slate-700" /><p className="mt-3 text-sm font-semibold text-slate-400">No persisted production decisions match the filters.</p></div> : <div className="divide-y divide-white/5">{filteredDecisions.slice(0, 100).map(event => <DecisionRow key={`${event.source}-${event.id}`} event={event} onSelect={() => setSelected(event)} />)}</div>}
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
        <div className="border-b border-white/10 p-4"><h2 className="text-sm font-bold">Trace Stream</h2><p className="mt-1 text-xs text-slate-600">Raw persisted signal-related telemetry. No synthetic lineage is added.</p></div>
        {loading && !events.length ? <div className="p-12 text-center text-sm text-slate-500">Loading forensic evidence…</div> : !events.length ? <div className="p-12 text-center"><Clock3 className="mx-auto h-8 w-8 text-slate-700" /><p className="mt-3 text-sm font-semibold text-slate-400">No persisted signal evidence matches the filters.</p></div> : <div className="divide-y divide-white/5">{events.map(event => <TraceRow key={`${event.source}-${event.id}`} event={event} />)}</div>}
      </section>
    </div>

    {selected && <DecisionDrawer event={selected} onClose={() => setSelected(null)} />}
  </main>;
}

function DecisionRow({ event, onSelect }: { event: EventRow; onSelect: () => void }) {
  const metadata = event.metadata ?? {};
  const accepted = boolValue(metadata.strategyGateAccepted);
  const confidence = numberValue(metadata.confidence);
  const anomaly = numberValue(metadata.anomalyScore);
  const available = numberValue(metadata.availableModelCount);
  const total = numberValue(metadata.modelCount);
  return <button type="button" onClick={onSelect} className="block w-full p-4 text-left transition hover:bg-white/[0.025]"><div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${accepted ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : 'border-amber-400/20 bg-amber-400/10 text-amber-300'}`}>{accepted ? 'EXECUTABLE' : 'WAIT / BLOCKED'}</span><span className="font-mono text-[10px] text-slate-600">{event.symbol || 'symbol unavailable'}</span><span className="font-mono text-[10px] text-slate-700">{event.correlationId || 'correlation unavailable'}</span></div><h3 className="mt-2 text-sm font-semibold text-slate-200">{stringValue(metadata.finalDecision)} · {confidence === null ? '—' : `${confidence.toFixed(1)}%`} confidence</h3><p className="mt-1 text-xs text-slate-500">{event.message}</p></div><div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[10px] text-slate-600 sm:grid-cols-4"><Stat label="Risk" value={stringValue(metadata.riskTier)} /><Stat label="Regime" value={stringValue(metadata.marketRegime)} /><Stat label="Anomaly" value={anomaly === null ? '—' : anomaly.toFixed(3)} /><Stat label="Models" value={available !== null && total !== null ? `${available}/${total}` : '—'} /></div></div></button>;
}

function TraceRow({ event }: { event: EventRow }) { return <article className="p-4"><div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-200">{event.category}</span><span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-500">{severityLabel(event.severity)}</span><span className="text-[10px] text-slate-600">{event.service || 'service unavailable'}</span>{event.symbol && <span className="font-mono text-[10px] text-slate-600">{event.symbol}</span>}</div><h3 className="mt-2 text-sm font-semibold text-slate-200">{event.eventType}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{event.message}</p></div><div className="shrink-0 text-left xl:text-right"><p className="font-mono text-[10px] text-slate-600">{formatTime(event.createdAt)}</p><p className="mt-1 max-w-sm truncate font-mono text-[10px] text-slate-700">Model: {event.modelId || 'unavailable'}</p><p className="mt-1 max-w-sm truncate font-mono text-[10px] text-slate-700">Request: {event.requestId || 'unavailable'}</p><p className="mt-1 max-w-sm truncate font-mono text-[10px] text-slate-700">Correlation: {event.correlationId || 'unavailable'}</p></div></div></article>; }

function DecisionDrawer({ event, onClose }: { event: EventRow; onClose: () => void }) {
  const m = event.metadata ?? {};
  const fields: Array<[string, string]> = [
    ['Decision', stringValue(m.finalDecision)], ['Confidence', numberValue(m.confidence) === null ? 'UNAVAILABLE' : `${numberValue(m.confidence)?.toFixed(2)}%`],
    ['Probability Up', numberValue(m.probabilityUp) === null ? 'UNAVAILABLE' : `${numberValue(m.probabilityUp)?.toFixed(4)}`],
    ['Probability Down', numberValue(m.probabilityDown) === null ? 'UNAVAILABLE' : `${numberValue(m.probabilityDown)?.toFixed(4)}`],
    ['Strategy Gate', boolValue(m.strategyGateAccepted) ? 'ACCEPTED' : 'BLOCKED'], ['Risk Tier', stringValue(m.riskTier)],
    ['Market Regime', stringValue(m.marketRegime)], ['Anomaly Score', numberValue(m.anomalyScore) === null ? 'UNAVAILABLE' : numberValue(m.anomalyScore)!.toFixed(4)],
    ['Model Coverage', numberValue(m.availableModelCount) !== null && numberValue(m.modelCount) !== null ? `${numberValue(m.availableModelCount)}/${numberValue(m.modelCount)}` : 'UNAVAILABLE'],
    ['Duration', durationLabel(m.duration)], ['Feature Count', numberValue(m.featureCount)?.toString() ?? 'UNAVAILABLE'],
    ['Correlation ID', event.correlationId || 'UNAVAILABLE'], ['Request ID', event.requestId || 'UNAVAILABLE'], ['Model ID', event.modelId || 'UNAVAILABLE'], ['Created', formatTime(event.createdAt)],
  ];
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-3 backdrop-blur-sm sm:items-center" onClick={onClose}><article className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-3xl border border-white/10 bg-[#0a0d13] p-5 shadow-2xl" onClick={e => e.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-300">Decision evidence</p><h2 className="mt-2 text-xl font-bold">{stringValue(m.finalDecision)} · {event.symbol || 'symbol unavailable'}</h2><p className="mt-2 text-sm leading-6 text-slate-400">{event.message}</p></div><button type="button" onClick={onClose} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-400">Close</button></div><dl className="mt-6 grid gap-3 sm:grid-cols-2">{fields.map(([label, value]) => <div key={label} className="rounded-xl border border-white/5 bg-white/[0.025] p-3"><dt className="text-[10px] uppercase tracking-wider text-slate-600">{label}</dt><dd className="mt-1 break-all font-mono text-xs text-slate-300">{value}</dd></div>)}</dl><div className="mt-5 flex flex-wrap gap-2"><Link href="/admin/observability" className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200">Open telemetry <ExternalLink className="h-3.5 w-3.5" /></Link><Link href="/admin/incident-center" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300">Incident Center <ExternalLink className="h-3.5 w-3.5" /></Link></div></article></div>;
}

function durationLabel(value: unknown) { if (!value || typeof value !== 'object') return 'UNAVAILABLE'; const d = value as { value?: unknown; unit?: unknown; seconds?: unknown }; const v = Number(d.value); const s = Number(d.seconds); return Number.isFinite(v) && typeof d.unit === 'string' ? `${v}${d.unit} (${Number.isFinite(s) ? `${s}s` : 'seconds unavailable'})` : 'UNAVAILABLE'; }
function Stat({ label, value }: { label: string; value: string }) { return <div><p className="uppercase tracking-wider">{label}</p><p className="mt-0.5 font-semibold text-slate-400">{value}</p></div>; }
function LineageStat({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-600">{label}</p><p className="mt-1 break-all text-sm font-bold text-slate-200">{value}</p></div>; }
function Metric({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Activity }) { return <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><Icon className="h-4 w-4 text-cyan-300" /><p className="mt-2 text-[10px] uppercase tracking-wider text-slate-500">{label}</p><p className="mt-1 text-2xl font-black">{value}</p></div>; }
function EvidenceCard({ title, events, coverage, icon: Icon }: { title: string; events: EventRow[]; coverage?: string; icon: typeof Activity }) { return <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><Icon className="h-4 w-4 text-cyan-300" /><h2 className="text-sm font-bold">{title}</h2></div><span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">{coverage || 'UNAVAILABLE'}</span></div><p className="mt-2 text-2xl font-black">{events.length}</p><p className="mt-1 text-xs text-slate-500">Persisted evidence records</p></article>; }
