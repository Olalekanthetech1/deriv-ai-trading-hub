'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, ClipboardCheck, Database, Gauge, RefreshCw, ShieldCheck, XCircle, Zap } from 'lucide-react';

type CheckResult = { name: string; status: 'PASS' | 'FAIL' | 'WARN'; detail: string; evidence?: string };

type VerificationResponse = {
  success?: boolean;
  diagnostic?: boolean;
  correlationId?: string;
  prediction?: { signal?: string; confidence?: number; modelVersion?: string; symbol?: string };
  strategyGate?: { accepted?: boolean; confidenceGateThreshold?: number; riskTier?: string; reasons?: string[] };
  assetContext?: { assetClass?: string; marketType?: string };
  error?: string;
};

function Status({ status }: { status: CheckResult['status'] }) {
  if (status === 'PASS') return <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[10px] font-bold text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />PASS</span>;
  if (status === 'WARN') return <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] font-bold text-amber-300">WARN</span>;
  return <span className="inline-flex items-center gap-1 rounded-full border border-red-400/20 bg-red-400/10 px-2 py-1 text-[10px] font-bold text-red-300"><XCircle className="h-3.5 w-3.5" />FAIL</span>;
}

export default function FinalVerificationPage() {
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [correlationId, setCorrelationId] = useState<string | null>(null);

  const runVerification = useCallback(async () => {
    setRunning(true);
    setChecks([]);
    setCorrelationId(null);
    const results: CheckResult[] = [];

    try {
      const healthResponse = await fetch('/api/health', { cache: 'no-store' });
      const health = await healthResponse.json().catch(() => null);
      results.push({
        name: 'Runtime health',
        status: healthResponse.ok && health?.status === 'healthy' ? 'PASS' : healthResponse.status === 503 ? 'WARN' : 'FAIL',
        detail: health?.status || `HTTP ${healthResponse.status}`,
        evidence: health?.services ? `DB: ${health.services.database || 'unknown'} · Python: ${health.services.pythonDaemon || 'unknown'}` : undefined,
      });

      const retrainingResponse = await fetch('/api/admin/retraining', { cache: 'no-store' });
      const retraining = await retrainingResponse.json().catch(() => null);
      results.push({
        name: 'Retraining scheduler',
        status: retrainingResponse.ok && retraining?.status !== 'database_unavailable' ? 'PASS' : retrainingResponse.status === 503 ? 'WARN' : 'FAIL',
        detail: retraining?.status || `HTTP ${retrainingResponse.status}`,
        evidence: retraining?.scheduleConfigured ? `Interval: ${retraining.scheduleIntervalHours}h · Last training: ${retraining.lastTrainedAt || 'none'}` : 'ML_RETRAIN_INTERVAL_MS is not configured.',
      });

      const registryResponse = await fetch('/api/ml/registry?status=production', { cache: 'no-store' });
      const registry = await registryResponse.json().catch(() => null);
      const productionCount = Array.isArray(registry?.models) ? registry.models.length : 0;
      results.push({
        name: 'Production model registry',
        status: registryResponse.ok && productionCount > 0 ? 'PASS' : registryResponse.ok ? 'WARN' : 'FAIL',
        detail: registryResponse.ok ? `${productionCount} production model record${productionCount === 1 ? '' : 's'}` : `HTTP ${registryResponse.status}`,
        evidence: registry?.dataSource || undefined,
      });

      const correlation = crypto.randomUUID();
      const signalResponse = await fetch('/api/signals/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-diagnostic': 'true', 'x-correlation-id': correlation },
        body: JSON.stringify({ symbol: 'R_100', durationValue: 5, durationUnit: 't' }),
        cache: 'no-store',
      });
      const signal = (await signalResponse.json().catch(() => null)) as VerificationResponse | null;
      const returnedCorrelation = signal?.correlationId || signalResponse.headers.get('x-correlation-id') || correlation;
      setCorrelationId(returnedCorrelation);
      results.push({
        name: 'Production signal path',
        status: signalResponse.ok && signal?.success ? 'PASS' : signalResponse.status === 503 ? 'WARN' : 'FAIL',
        detail: signal?.success ? `${signal.prediction?.signal || 'WAIT'} · ${signal.prediction?.confidence ?? '—'}% confidence` : signal?.error || `HTTP ${signalResponse.status}`,
        evidence: signal?.success ? `Model: ${signal.prediction?.modelVersion || 'unknown'} · Symbol: ${signal.prediction?.symbol || 'R_100'} · Diagnostic mode: ${signal.diagnostic === true ? 'ON' : 'OFF'}` : `Correlation: ${returnedCorrelation}`,
      });
    } catch (error) {
      results.push({ name: 'Verification runner', status: 'FAIL', detail: error instanceof Error ? error.message : 'Verification request failed.' });
    } finally {
      setChecks(results);
      setLastRun(new Date().toISOString());
      setRunning(false);
    }
  }, []);

  useEffect(() => { void runVerification(); }, [runVerification]);

  const passed = checks.filter((check) => check.status === 'PASS').length;
  const failed = checks.filter((check) => check.status === 'FAIL').length;

  return <main className="min-h-screen bg-[#05070b] text-slate-100 admin-dashboard-surface">
    <div className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3"><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><ClipboardCheck className="h-6 w-6 text-cyan-300" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">5B-3</p><h1 className="text-2xl font-black sm:text-3xl">Production Verification</h1><p className="mt-1 text-xs text-slate-500">Controlled runtime, ML lifecycle and signal-path verification. Diagnostic requests never create trade records.</p></div></div>
        <div className="flex gap-2"><Link href="/admin" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300"><ArrowLeft className="h-4 w-4" />Operations Center</Link><button onClick={runVerification} disabled={running} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />Run verification</button></div>
      </header>

      <section className="mb-6 grid gap-4 sm:grid-cols-3"><article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><p className="text-xs uppercase tracking-wider text-slate-500">Checks passed</p><p className="mt-2 text-3xl font-black text-emerald-300">{passed}</p></article><article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><p className="text-xs uppercase tracking-wider text-slate-500">Checks failed</p><p className="mt-2 text-3xl font-black text-red-300">{failed}</p></article><article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><p className="text-xs uppercase tracking-wider text-slate-500">Last run</p><p className="mt-2 text-sm font-bold text-slate-200">{lastRun ? new Date(lastRun).toLocaleString() : 'Running…'}</p></article></section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-5 flex items-center gap-2"><Zap className="h-5 w-5 text-cyan-300" /><div><h2 className="font-bold">Verification Evidence</h2><p className="mt-1 text-xs text-slate-500">The runner checks the same production boundaries used by the application.</p></div></div><div className="space-y-3">{checks.length === 0 ? <div className="rounded-xl border border-white/10 bg-black/20 p-5 text-sm text-slate-400">Running controlled verification…</div> : checks.map((check) => <article key={check.name} className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h3 className="text-sm font-bold text-slate-200">{check.name}</h3><p className="mt-1 text-sm text-slate-300">{check.detail}</p>{check.evidence && <p className="mt-2 break-words text-xs text-slate-500">{check.evidence}</p>}</div><Status status={check.status} /></div></article>)}</div></section>

      {correlationId && <section className="mt-5 rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.05] p-5"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" /><div><h2 className="text-sm font-bold text-cyan-100">Signal diagnostic correlation</h2><p className="mt-1 text-xs leading-5 text-slate-400">Use this ID when correlating logs, observability telemetry and signal-forensics evidence.</p><code className="mt-3 block break-all rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-cyan-200">{correlationId}</code></div></div></section>}

      <section className="mt-5 grid gap-4 md:grid-cols-3"><Link href="/admin/observability" className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 hover:border-cyan-400/20"><Gauge className="h-5 w-5 text-cyan-300" /><h3 className="mt-3 font-bold">Observability</h3><p className="mt-1 text-xs text-slate-500">Correlate runtime and API evidence.</p></Link><Link href="/admin/signal-forensics" className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 hover:border-cyan-400/20"><Zap className="h-5 w-5 text-rose-300" /><h3 className="mt-3 font-bold">Signal Forensics</h3><p className="mt-1 text-xs text-slate-500">Trace model and signal lineage.</p></Link><Link href="/admin/incident-center" className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 hover:border-amber-400/20"><Database className="h-5 w-5 text-amber-300" /><h3 className="mt-3 font-bold">Incident Center</h3><p className="mt-1 text-xs text-slate-500">Investigate production failures and dependencies.</p></Link></section>
    </div>
  </main>;
}
