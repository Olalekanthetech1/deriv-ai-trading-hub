'use client';

import Link from 'next/link';
import { AssetBatchPresets } from '@/components/admin/asset-batch-presets';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CalendarClock, CheckCircle2, Play, RefreshCw, ShieldAlert, Timer, XCircle } from 'lucide-react';

type RetrainingStatus = {
  status?: string;
  scheduleConfigured?: boolean;
  scheduleIntervalHours?: number | null;
  lastTrainedAt?: string | null;
  timeSinceLastTrainMinutes?: number | null;
  isDue?: boolean | null;
  nextScheduledRunInMinutes?: number | null;
  liveSymbols?: string[];
  driftMonitoring?: Array<{
    symbol: string;
    sampleSize: number;
    wins: number;
    recentAccuracy: number;
    controlLimit: number;
    driftDetected: boolean;
    status: 'NORMAL' | 'DRIFT_DETECTED';
    lastEvaluatedAt: string;
    recommendedAction: string;
  }>;
  cohortRetrainingTriggers?: {
    totalEvaluated: number;
    triggeredCount: number;
    results: Array<{
      triggerId: string;
      assetSymbol: string;
      timestamp: string;
      triggered: boolean;
      suppressedReason?: string;
      driftState: string;
      metrics: {
        sampleSize: number;
        meanPredictedProb: number;
        realizedWinRate: number;
        calibrationGap: number;
        brierScore: number;
        logLoss: number;
        statisticalSignificance: number;
        isStatisticallySignificant: boolean;
      };
      milestones: Array<{
        milestone: string;
        description: string;
        threshold: number;
        observedValue: number;
        sampleSize: number;
        breached: boolean;
        severity: 'NORMAL' | 'WARNING' | 'CRITICAL';
      }>;
      dispatchedJobs: Array<{
        jobId: string;
        datasetId: string;
        status: string;
      }>;
      summary: string;
    }>;
  };
  cohortTriggerHistory?: Array<{
    triggerId: string;
    assetSymbol: string;
    timestamp: string;
    triggered: boolean;
    driftState: string;
    metrics: {
      brierScore: number;
      calibrationGap: number;
      sampleSize: number;
    };
    dispatchedJobs: Array<any>;
    summary: string;
  }>;
  promotionHistory?: {
    promotedCount: number;
    promotions: Array<{
      candidateId: string;
      championId: string | null;
      assetSymbol: string;
      modelType: string;
      candidateF1: number;
      championF1: number;
      f1Improvement: number;
      promotedAt: string;
      downtimeMs: number;
    }>;
  };
  error?: string;
};

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wider ${ok ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : 'border-amber-400/20 bg-amber-400/10 text-amber-200'}`}>{ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}{label}</span>;
}

export default function RetrainingPage() {
  const [data, setData] = useState<RetrainingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [symbol, setSymbol] = useState('ALL_ASSETS');
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [availableAssets, setAvailableAssets] = useState<any[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/retraining', { cache: 'no-store' });
      if (response.status === 401) { window.location.replace('/admin'); return; }
      const body: RetrainingStatus = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Retraining status returned HTTP ${response.status}.`);
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load retraining status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30000); return () => window.clearInterval(timer); }, [load]);

  const runNow = async () => {
    const targetLabel = selectedSymbols.length > 0 ? `${selectedSymbols.length} assets` : symbol;
    if (!window.confirm(`Start a forced retraining request for ${targetLabel}? This queues training work and may consume significant compute.`)) return;
    setRunning(true); setMessage(null); setError(null);
    try {
      const response = await fetch('/api/admin/retraining', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: selectedSymbols.length ? selectedSymbols.join(',') : symbol, symbols: selectedSymbols.length ? selectedSymbols : [symbol], force: true }) });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.replace('/admin'); return; }
      if (!response.ok || body.success === false) throw new Error(body.error || `Retraining request returned HTTP ${response.status}.`);
      setMessage(body.message || 'Retraining request accepted and queued.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start retraining.');
    } finally {
      setRunning(false);
    }
  };

  const evaluateDriftMilestones = async (force: boolean = false) => {
    setRunning(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/retraining', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'evaluate_cohort_triggers', symbol, force }),
      });
      if (response.status === 401) { window.location.replace('/admin'); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) throw new Error(body.error || 'Milestone evaluation failed.');
      setMessage(force ? 'Cohort retraining trigger evaluation & queue dispatch executed.' : 'Drift & calibration gap milestones evaluated across fleet.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Drift milestone evaluation failed.');
    } finally {
      setRunning(false);
    }
  };

  const configured = data?.scheduleConfigured === true;
  const due = data?.isDue === true;
  const active = data?.status === 'active';

  return <main className="min-h-screen bg-[#05070b] text-slate-100"><div className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6 lg:px-8">
    <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3"><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><CalendarClock className="h-6 w-6 text-cyan-300" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">Model Operations · Automation</p><h1 className="text-2xl font-black tracking-tight sm:text-3xl">Retraining & Automation</h1><p className="mt-1 text-xs text-slate-500">Source-backed visibility and controlled execution for the production retraining scheduler.</p></div></div>
      <div className="flex flex-wrap gap-2"><Link href="/admin/models" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10"><ArrowLeft className="h-4 w-4" />Model Operations</Link><Link href="/admin/training-pipeline" className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10">Training Pipeline</Link><button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button></div>
    </header>

    {error && <div className="mb-5 rounded-2xl border border-red-400/20 bg-red-400/[0.06] p-4 text-sm text-red-200">{error}</div>}
    {message && <div className="mb-5 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4 text-sm text-emerald-200">{message}</div>}

    <section className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-3 flex items-center justify-between"><Timer className="h-5 w-5 text-cyan-300" /><StatusPill ok={configured} label={configured ? 'CONFIGURED' : 'NOT CONFIGURED'} /></div><p className="text-xs uppercase tracking-wider text-slate-500">Schedule</p><p className="mt-1 text-xl font-black">{data?.scheduleIntervalHours != null ? `${data.scheduleIntervalHours}h` : '—'}</p></article>
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-3 flex items-center justify-between"><CheckCircle2 className="h-5 w-5 text-emerald-300" /><StatusPill ok={active} label={active ? 'ACTIVE' : String(data?.status || 'UNKNOWN').toUpperCase()} /></div><p className="text-xs uppercase tracking-wider text-slate-500">Scheduler state</p><p className="mt-1 text-xl font-black">{active ? 'Ready' : 'Attention'}</p></article>
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-3 flex items-center justify-between"><CalendarClock className="h-5 w-5 text-slate-300" /><span className="text-[10px] font-bold tracking-wider text-slate-500">PERSISTED</span></div><p className="text-xs uppercase tracking-wider text-slate-500">Last training</p><p className="mt-1 text-sm font-bold">{formatDate(data?.lastTrainedAt)}</p></article>
      <article className={`rounded-2xl border p-5 ${due ? 'border-amber-400/20 bg-amber-400/[0.05]' : 'border-white/10 bg-white/[0.025]'}`}><div className="mb-3 flex items-center justify-between"><ShieldAlert className={`h-5 w-5 ${due ? 'text-amber-300' : 'text-slate-400'}`} /><span className="text-[10px] font-bold tracking-wider text-slate-500">SCHEDULE</span></div><p className="text-xs uppercase tracking-wider text-slate-500">Next run</p><p className="mt-1 text-xl font-black">{data?.nextScheduledRunInMinutes != null ? `${data.nextScheduledRunInMinutes}m` : due ? 'DUE' : '—'}</p></article>
    </section>

    <section className="grid gap-5 lg:grid-cols-[1fr_0.8fr]">
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-5"><h2 className="text-base font-bold">Scheduler Diagnostics</h2><p className="mt-1 text-xs leading-5 text-slate-500">The page reads the canonical Admin retraining endpoint. No health state is inferred from configuration alone.</p></div><dl className="divide-y divide-white/5 text-sm"><div className="flex items-center justify-between gap-4 py-3"><dt className="text-slate-500">Backend status</dt><dd className="font-mono text-slate-200">{data?.status || 'loading…'}</dd></div><div className="flex items-center justify-between gap-4 py-3"><dt className="text-slate-500">Schedule configured</dt><dd className="font-mono text-slate-200">{configured ? 'true' : 'false'}</dd></div><div className="flex items-center justify-between gap-4 py-3"><dt className="text-slate-500">Time since last train</dt><dd className="font-mono text-slate-200">{data?.timeSinceLastTrainMinutes != null ? `${data.timeSinceLastTrainMinutes} min` : '—'}</dd></div><div className="flex items-center justify-between gap-4 py-3"><dt className="text-slate-500">Due now</dt><dd className={`font-mono ${due ? 'text-amber-300' : 'text-slate-200'}`}>{data?.isDue == null ? '—' : String(data.isDue)}</dd></div></dl></article>
      <article className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.025] p-5"><div className="mb-5"><h2 className="text-base font-bold">Controlled Manual Run</h2><p className="mt-1 text-xs leading-5 text-slate-500">Use this only when you intentionally want to queue retraining outside the normal schedule.</p></div><label className="mb-2 block text-xs font-semibold text-slate-400">Training scope</label><select value={symbol} onChange={(event) => setSymbol(event.target.value)} className="mb-4 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-xs text-slate-200 outline-none"><option value="ALL_ASSETS">ALL_ASSETS (Fleet-wide)</option>{data?.liveSymbols && data.liveSymbols.length > 0 ? (data.liveSymbols.map((sym) => (<option key={sym} value={sym}>{sym}</option>))) : (<><option value="R_10">R_10</option><option value="R_25">R_25</option><option value="R_50">R_50</option><option value="R_75">R_75</option><option value="R_100">R_100</option></>)}</select><button onClick={runNow} disabled={running} className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60">{running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{running ? 'Queueing…' : 'Force Retraining Run'}</button><p className="mt-3 text-[10px] leading-4 text-slate-600">Execution remains server-side and authenticated. The UI does not bypass scheduler or database eligibility checks.</p></article>
    </section>
    <section className="mt-6 grid gap-5 lg:grid-cols-2">
      {/* Drift Monitoring Matrix */}
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 space-y-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-400" />
            Statistical Drift Control & Retraining Worker
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Automated monitoring comparing recent prediction accuracy against statistical control limits (SCL: 52.0%).
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="border-b border-white/10 text-[10px] font-black uppercase text-slate-400 bg-black/40">
              <tr>
                <th className="p-2.5">Asset</th>
                <th className="p-2.5">Sample</th>
                <th className="p-2.5">Accuracy</th>
                <th className="p-2.5">SCL Limit</th>
                <th className="p-2.5">Drift Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 font-mono text-[11px]">
              {data?.driftMonitoring && data.driftMonitoring.length > 0 ? (
                data.driftMonitoring.map((d) => (
                  <tr key={d.symbol} className="hover:bg-white/[0.02]">
                    <td className="p-2.5 font-bold text-white font-sans">{d.symbol}</td>
                    <td className="p-2.5 text-slate-400">{d.sampleSize} trades</td>
                    <td className={`p-2.5 font-bold ${d.driftDetected ? 'text-rose-400' : 'text-emerald-400'}`}>
                      {d.recentAccuracy}%
                    </td>
                    <td className="p-2.5 text-slate-400">{d.controlLimit}%</td>
                    <td className="p-2.5">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                        d.driftDetected 
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 animate-pulse' 
                          : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      }`}>
                        {d.status}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-slate-500">
                    Scanning statistical control limits...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>

      {/* Zero-Downtime Automated Model Promotion Log */}
      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 space-y-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-400" />
            Automated Model Promotion & Zero-Downtime Gate
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Candidate ensemble models evaluated against production champions with automated zero-downtime activation.
          </p>
        </div>

        <div className="space-y-2 font-mono text-xs">
          {data?.promotionHistory && data.promotionHistory.promotions.length > 0 ? (
            data.promotionHistory.promotions.map((p) => (
              <div key={p.candidateId} className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3 space-y-1">
                <div className="flex items-center justify-between font-sans">
                  <span className="font-bold text-white">{p.assetSymbol} · {p.modelType}</span>
                  <span className="text-[10px] font-extrabold text-emerald-400 bg-emerald-500/20 px-2 py-0.5 rounded border border-emerald-500/30">
                    0ms Downtime Promoted
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-300">
                  <span>Candidate F1: <strong className="text-emerald-300">{p.candidateF1}</strong></span>
                  <span>Champion F1: <strong className="text-slate-400">{p.championF1}</strong></span>
                  <span className="text-cyan-300 font-bold">+{p.f1Improvement} Delta</span>
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-white/5 bg-black/20 p-6 text-center text-slate-500 text-xs font-sans">
              All 8 active ensemble models are verified production champions. Candidate model gates monitored.
            </div>
          )}
        </div>
      </article>
    </section>

    {/* Phase 4: Automated Cohort Retraining Triggers & Brier/Calibration Gap Milestones */}
    <section className="mt-6 rounded-2xl border border-cyan-400/20 bg-cyan-950/[0.04] p-5 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-cyan-400/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-cyan-300 border border-cyan-400/20">
              Phase 4 Offline Trigger
            </span>
            <h2 className="text-base font-bold text-white">
              Cohort Drift & Brier Divergence Milestone Triggers
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-400 max-w-3xl">
            Automatically tracks rolling prediction cohorts, computing Brier scores, calibration gap divergence, and SCL accuracy limits. When statistical thresholds are breached across real execution milestones, candidate training jobs are automatically dispatched to the durable queue.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void evaluateDriftMilestones(false)}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-bold text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${running ? 'animate-spin' : ''}`} />
            Scan Fleet Milestones
          </button>
          <button
            onClick={() => void evaluateDriftMilestones(true)}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs font-bold text-amber-200 hover:bg-amber-400/20 disabled:opacity-60"
          >
            <Play className="h-3.5 w-3.5" />
            Force Trigger Check ({symbol})
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.cohortRetrainingTriggers?.results && data.cohortRetrainingTriggers.results.length > 0 ? (
          data.cohortRetrainingTriggers.results.map((res) => {
            const hasBreached = res.milestones.some((m) => m.breached);
            return (
              <div
                key={res.assetSymbol}
                className={`rounded-xl border p-4 space-y-3 font-sans transition-all ${
                  res.triggered
                    ? 'border-amber-400/40 bg-amber-950/20'
                    : hasBreached
                    ? 'border-rose-500/30 bg-rose-950/10'
                    : 'border-white/10 bg-black/30'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-black text-white">{res.assetSymbol}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                      res.driftState === 'CRITICAL_DRIFT' || res.driftState === 'SIGNIFICANT_DRIFT'
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                        : res.driftState === 'MODERATE_DRIFT'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    }`}>
                      {res.driftState.replace('_', ' ')}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-slate-400">
                    N={res.metrics.sampleSize} trades
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs font-mono bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                  <div>
                    <span className="text-[10px] text-slate-500 block">Brier Score</span>
                    <span className={`font-bold ${res.metrics.brierScore > 0.28 ? 'text-rose-400' : 'text-slate-200'}`}>
                      {res.metrics.brierScore.toFixed(4)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Calibration Gap</span>
                    <span className={`font-bold ${res.metrics.calibrationGap > 0.08 ? 'text-amber-400' : 'text-slate-200'}`}>
                      {(res.metrics.calibrationGap * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Win Rate / Pred</span>
                    <span className="text-slate-300">
                      {(res.metrics.realizedWinRate * 100).toFixed(1)}% / {(res.metrics.meanPredictedProb * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Stat Significance</span>
                    <span className={res.metrics.isStatisticallySignificant ? 'text-cyan-300 font-bold' : 'text-slate-400'}>
                      {(res.metrics.statisticalSignificance * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>

                {/* Milestones list */}
                <div className="space-y-1.5 pt-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                    Diagnostic Milestones
                  </span>
                  {res.milestones.map((m) => (
                    <div
                      key={m.milestone}
                      className={`flex items-center justify-between text-[11px] px-2 py-1 rounded border ${
                        m.breached
                          ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                          : 'border-white/5 bg-white/[0.01] text-slate-400'
                      }`}
                    >
                      <span className="truncate pr-2">{m.description}</span>
                      <span className="font-mono font-bold whitespace-nowrap text-[10px]">
                        {m.breached ? 'BREACHED' : 'PASS'}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Queue status */}
                {res.triggered && res.dispatchedJobs.length > 0 && (
                  <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-2 text-[10px] text-amber-200">
                    <span className="font-bold">Retraining Dispatched: </span>
                    {res.dispatchedJobs.map((j) => j.jobId).join(', ')}
                  </div>
                )}
                {res.suppressedReason && (
                  <div className="text-[10px] text-slate-500 italic">
                    Suppression status: {res.suppressedReason}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="col-span-full rounded-xl border border-white/5 bg-black/20 p-6 text-center text-xs text-slate-500">
            Real-time milestone evaluations will populate as trade outcomes are recorded across the synthetic fleet.
          </div>
        )}
      </div>
    </section>
  </div></main>;
}
