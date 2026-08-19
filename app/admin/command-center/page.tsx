'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  Database,
  Gauge,
  RefreshCw,
  Server,
  ShieldAlert,
  Timer,
  XCircle,
} from 'lucide-react';

type HealthData = {
  status?: 'healthy' | 'degraded';
  timestamp?: string;
  services?: {
    database?: string;
    dbLatencyMs?: number | null;
    pythonDaemon?: string;
    daemonLatencyMs?: number | null;
  };
  env?: {
    databaseUrlSet?: boolean;
    derivAppIdSet?: boolean;
  };
};

type StatsData = {
  isDbConnected?: boolean;
  dataSource?: string;
  isSimulated?: boolean;
  realTradesOnly?: boolean;
  generatedAt?: string;
  summary?: {
    totalTrades?: number;
    wins?: number;
    losses?: number;
    winRate?: number;
    totalProfit?: number;
    totalTicks?: number;
    totalModels?: number;
    activeModel?: string;
    activeAccuracy?: number | null;
    metricsQuality?: {
      recentTradesSampled?: number;
      resolvedTrades?: number;
      pnlTradesWithCompleteAmounts?: number;
    };
  };
};

type RegistryModel = {
  model_id?: string;
  symbol?: string;
  horizon_secs?: number;
  status?: string;
  format?: string;
  accuracy?: number | null;
  trained_at?: string;
};

type RegistryData = {
  success?: boolean;
  count?: number;
  models?: RegistryModel[];
  dataSource?: string;
  error?: string;
};

type LoadState = {
  health: HealthData | null;
  stats: StatsData | null;
  registry: RegistryData | null;
  error: string | null;
  loading: boolean;
  refreshedAt: string | null;
};

const initialState: LoadState = {
  health: null,
  stats: null,
  registry: null,
  error: null,
  loading: true,
  refreshedAt: null,
};

function formatNumber(value: number | null | undefined) {
  return Number.isFinite(value) ? Number(value).toLocaleString() : '—';
}

function formatLatency(value: number | null | undefined) {
  return Number.isFinite(value) ? `${value} ms` : '—';
}

function formatTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
}

function StatusPill({ status }: { status: 'healthy' | 'degraded' | 'unavailable' | 'unknown' | 'production' }) {
  const config = {
    production: { label: 'PRODUCTION', className: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300', icon: CheckCircle2, showPulse: true },
    healthy: { label: 'HEALTHY', className: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300', icon: CheckCircle2 },
    degraded: { label: 'DEGRADED', className: 'border-amber-400/20 bg-amber-400/10 text-amber-300', icon: AlertTriangle },
    unavailable: { label: 'UNAVAILABLE', className: 'border-red-400/20 bg-red-400/10 text-red-300', icon: XCircle },
    unknown: { label: 'UNKNOWN', className: 'border-white/10 bg-white/5 text-slate-400', icon: ShieldAlert },
  }[status];
  const Icon = config.icon;
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wider ${config.className}`}>{'showPulse' in config && config.showPulse && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />}<Icon className="h-3.5 w-3.5" />{config.label}</span>;
}

function ServiceCard({ title, icon: Icon, status, value, detail }: { title: string; icon: typeof Database; status: 'healthy' | 'degraded' | 'unavailable' | 'unknown'; value: string; detail: string }) {
  return <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="rounded-xl border border-white/10 bg-black/20 p-2.5"><Icon className="h-5 w-5 text-cyan-300" /></div>
      <StatusPill status={status} />
    </div>
    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{title}</p>
    <p className="mt-2 truncate text-lg font-bold text-slate-100">{value}</p>
    <p className="mt-1 text-xs text-slate-500">{detail}</p>
  </article>;
}

import { RenderDeploymentWidget } from '@/components/admin/render-deployment-widget';

export default function CommandCenterPage() {
  const [state, setState] = useState<LoadState>(initialState);

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const responses = await Promise.all([
        fetch('/api/health', { cache: 'no-store' }),
        fetch('/api/admin/stats', { cache: 'no-store' }),
        fetch('/api/ml/registry?status=production', { cache: 'no-store' }),
      ]);

      if (responses.some((response) => response.status === 401)) {
        window.location.replace('/admin');
        return;
      }

      const [healthResponse, statsResponse, registryResponse] = responses;
      const [health, stats, registry] = await Promise.all([
        healthResponse.json().catch(() => null),
        statsResponse.json().catch(() => null),
        registryResponse.json().catch(() => null),
      ]);

      const endpointErrors = responses
        .filter((response) => !response.ok && response.status !== 503)
        .map((response) => response.status);

      setState({
        health,
        stats,
        registry,
        error: endpointErrors.length ? `One or more admin data sources returned HTTP ${endpointErrors.join(', ')}.` : null,
        loading: false,
        refreshedAt: new Date().toISOString(),
      });
    } catch {
      setState((current) => ({ ...current, loading: false, error: 'Unable to load Command Center data.' }));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  const healthStatus = state.health?.status === 'healthy' ? 'healthy' : state.health?.status === 'degraded' ? 'degraded' : 'unknown';
  const databaseStatus = state.health?.services?.database === 'connected' ? 'healthy' : state.health?.services?.database ? 'degraded' : 'unknown';
  const daemonStatus = state.health?.services?.pythonDaemon === 'connected' ? 'healthy' : state.health?.services?.pythonDaemon ? 'degraded' : 'unknown';
  const productionModels = state.registry?.models?.filter((model) => String(model.status || '').toLowerCase() === 'production') || [];
  const activeModel = state.stats?.summary?.activeModel;
  const hasActiveModel = Boolean(activeModel && !activeModel.toLowerCase().includes('unavailable') && !activeModel.toLowerCase().includes('no trained model'));

  const alerts = useMemo(() => {
    const items: Array<{ severity: 'critical' | 'warning'; text: string }> = [];
    if (healthStatus === 'degraded') items.push({ severity: 'critical', text: 'System health is degraded. Inspect database and ML runtime status.' });
    if (databaseStatus !== 'healthy') items.push({ severity: 'critical', text: 'Database health is not confirmed as connected.' });
    if (daemonStatus !== 'healthy') items.push({ severity: 'critical', text: 'Python ML daemon is not confirmed as connected.' });
    if (!hasActiveModel) items.push({ severity: 'warning', text: 'No trained production model is currently reported by admin stats.' });
    if (state.health?.env?.derivAppIdSet === false) items.push({ severity: 'critical', text: 'NEXT_PUBLIC_DERIV_APP_ID is not configured in the running environment.' });
    if (items.length === 0) items.push({ severity: 'warning', text: 'No critical condition is reported by the available health endpoints.' });
    return items;
  }, [databaseStatus, daemonStatus, hasActiveModel, healthStatus, state.health?.env?.derivAppIdSet]);

  return <main className="min-h-screen bg-[#05070b] text-slate-100">
    <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><Gauge className="h-6 w-6 text-cyan-300" /></div>
          <div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">5B-2</p><h1 className="text-2xl font-black tracking-tight sm:text-3xl">Command Center</h1><p className="mt-1 text-xs text-slate-500">Operational readiness from persisted runtime and database signals.</p></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/admin" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10"><ArrowLeft className="h-4 w-4" />Operations Center</Link>
          <button onClick={load} disabled={state.loading} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${state.loading ? 'animate-spin' : ''}`} />Refresh</button>
        </div>
      </header>

      {state.error && <div className="mb-5 rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-200">{state.error}</div>}

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <ServiceCard title="System" icon={Activity} status={healthStatus} value={healthStatus === 'healthy' ? 'Operational' : healthStatus === 'degraded' ? 'Degraded' : 'Awaiting data'} detail={`Health endpoint · ${formatTime(state.health?.timestamp)}`} />
        <ServiceCard title="Database" icon={Database} status={databaseStatus} value={state.health?.services?.database || 'Not reported'} detail={`Latency ${formatLatency(state.health?.services?.dbLatencyMs)}`} />
        <ServiceCard title="ML Runtime" icon={BrainCircuit} status={daemonStatus} value={state.health?.services?.pythonDaemon || 'Not reported'} detail={`Python daemon · ${formatLatency(state.health?.services?.daemonLatencyMs)}`} />
        <ServiceCard title="Production Model" icon={Server} status={hasActiveModel ? 'healthy' : 'unavailable'} value={hasActiveModel ? String(activeModel) : 'No trained model'} detail={`${productionModels.length} production registry record${productionModels.length === 1 ? '' : 's'} reported`} />
      </section>

      <section className="mb-6 grid gap-4 lg:grid-cols-[1.4fr_0.6fr]">
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-5 flex items-center justify-between gap-3"><div><h2 className="text-base font-bold">Platform Snapshot</h2><p className="mt-1 text-xs text-slate-500">Only values returned by current production APIs are shown.</p></div><span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-bold tracking-wider text-emerald-300">LIVE DATA</span></div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs text-slate-500">Stored ticks</p><p className="mt-1 text-xl font-bold">{formatNumber(state.stats?.summary?.totalTicks)}</p></div>
            <div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs text-slate-500">Logged trades</p><p className="mt-1 text-xl font-bold">{formatNumber(state.stats?.summary?.totalTrades)}</p></div>
            <div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs text-slate-500">Resolved win rate</p><p className="mt-1 text-xl font-bold">{Number.isFinite(state.stats?.summary?.winRate) ? `${state.stats?.summary?.winRate}%` : '—'}</p></div>
            <div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs text-slate-500">Registered models</p><p className="mt-1 text-xl font-bold">{formatNumber(state.stats?.summary?.totalModels)}</p></div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-[11px] text-slate-500">Wins</p><p className="mt-1 font-semibold">{formatNumber(state.stats?.summary?.wins)}</p></div><div className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-[11px] text-slate-500">Losses</p><p className="mt-1 font-semibold">{formatNumber(state.stats?.summary?.losses)}</p></div><div className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-[11px] text-slate-500">Persisted P&L</p><p className="mt-1 font-semibold">{Number.isFinite(state.stats?.summary?.totalProfit) ? state.stats?.summary?.totalProfit : '—'}</p></div></div>
        </article>

        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-4 flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-amber-300" /><h2 className="text-base font-bold">Critical Events</h2></div>
          <div className="space-y-3">
            {alerts.map((alert, index) => <div key={`${alert.text}-${index}`} className="rounded-xl border border-white/10 bg-black/20 p-3"><div className="flex items-start gap-2">{alert.severity === 'critical' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />}<p className="text-xs leading-5 text-slate-300">{alert.text}</p></div></div>)}
          </div>
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-4 flex items-center justify-between"><div><h2 className="text-base font-bold">Runtime Diagnostics</h2><p className="mt-1 text-xs text-slate-500">Environment presence is reported as a boolean; secret values are never displayed.</p></div><Timer className="h-5 w-5 text-cyan-300" /></div>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between border-b border-white/5 pb-3"><span className="text-slate-400">DATABASE_URL</span><span className={state.health?.env?.databaseUrlSet ? 'text-emerald-300' : 'text-red-300'}>{state.health?.env?.databaseUrlSet === undefined ? 'Not reported' : state.health.env.databaseUrlSet ? 'Configured' : 'Missing'}</span></div>
            <div className="flex items-center justify-between border-b border-white/5 pb-3"><span className="text-slate-400">Deriv App ID</span><span className={state.health?.env?.derivAppIdSet ? 'text-emerald-300' : 'text-red-300'}>{state.health?.env?.derivAppIdSet === undefined ? 'Not reported' : state.health.env.derivAppIdSet ? 'Configured' : 'Missing'}</span></div>
            <div className="flex items-center justify-between"><span className="text-slate-400">Last refresh</span><span className="text-slate-300">{formatTime(state.refreshedAt)}</span></div>
          </div>
        </article>

        <RenderDeploymentWidget />

        <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-4 flex items-center justify-between"><div><h2 className="text-base font-bold">Production Registry</h2><p className="mt-1 text-xs text-slate-500">Only persisted models returned with status=production are listed.</p></div><Link href="/admin" className="text-xs font-semibold text-cyan-300 hover:text-cyan-200">Model Operations →</Link></div>
          {productionModels.length === 0 ? <div className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">No production registry records are currently available.</div> : <div className="space-y-2">{productionModels.slice(0, 5).map((model, index) => <div key={`${model.model_id || 'model'}-${index}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 p-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-200">{model.model_id || 'Unnamed model'}</p><p className="mt-1 text-[11px] text-slate-500">{model.symbol || 'Symbol unavailable'} · {Number.isFinite(model.horizon_secs) ? `${model.horizon_secs}s` : 'Horizon unavailable'}</p></div><StatusPill status="production" /></div>)}</div>}
        </article>
      </section>
    </div>
  </main>;
}
