'use client';

import { useState, useEffect, useCallback } from 'react';
import { 
  Activity, 
  Clock, 
  CheckCircle2, 
  AlertTriangle, 
  RefreshCw, 
  Sparkles, 
  Zap, 
  TrendingUp, 
  Sliders,
  Radio,
  Layers,
  ShieldCheck,
  Award
} from 'lucide-react';
import { AttributionAnalyticsWidget, type AttributionDiagnosticsData } from './attribution-analytics-widget';

interface ExecutionRecord {
  id: string;
  assetSymbol: string;
  contractType: string;
  stake: number;
  payout: number | null;
  status: string;
  executedAt: string;
  targetHorizon: string;
  executedDuration: string;
  horizonMatch: boolean;
  proposalLatencyMs: number;
  calibratedWinProb: number;
  modelKeys: string[];
  strategy: string;
}

interface CohortStat {
  cohort: string;
  totalTrades: number;
  wins: number;
  winRate: number;
  avgLatencyMs: number;
  matchRate: number;
}

interface TelemetryData {
  totalExecutions: number;
  avgProposalLatencyMs: number;
  exactHorizonMatchRate: number;
  overallWinRate: number;
}

export function HorizonExecutionAuditPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [cohorts, setCohorts] = useState<CohortStat[]>([]);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [attribution, setAttribution] = useState<AttributionDiagnosticsData | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchAuditData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/admin/horizon-audit', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const data = await res.json();
      if (data.success) {
        setTelemetry(data.overallTelemetry);
        setCohorts(data.cohortStats || []);
        setExecutions(data.recentExecutions || []);
        setAttribution(data.attributionDiagnostics || null);
      } else {
        throw new Error(data.error || 'Failed to fetch audit telemetry');
      }
    } catch (err: any) {
      setError(err.message || 'Error loading horizon execution audit');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAuditData();
  }, [fetchAuditData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchAuditData();
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchAuditData]);

  return (
    <div className="space-y-6">
      {/* Header controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-white/10 bg-slate-900/80 p-4">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-emerald-400" />
            <h2 className="text-lg font-black text-white">Real-Time Horizon Execution Audit & Telemetry</h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Comparing Target HDE Horizon vs. Actual Deriv WebSocket Contract Durations with microsecond latency logs and cohort win probability metrics.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all ${
              autoRefresh 
                ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-300' 
                : 'border-white/10 bg-white/5 text-slate-400'
            }`}
          >
            <Activity className={`mr-1.5 inline h-3.5 w-3.5 ${autoRefresh ? 'animate-pulse text-emerald-400' : ''}`} />
            {autoRefresh ? 'Live Auto-Sync On (5s)' : 'Auto-Sync Off'}
          </button>
          <button
            type="button"
            onClick={() => fetchAuditData()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/20 px-3 py-1.5 text-xs font-bold text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh Audit
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-950/30 p-4 text-xs text-rose-200">
          <div className="font-bold flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-rose-400" />
            Audit Sync Issue
          </div>
          <p className="mt-1 text-rose-300/80">{error}</p>
        </div>
      )}

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/10 p-4">
          <div className="flex items-center justify-between text-xs font-bold text-emerald-400 uppercase tracking-wider">
            <span>Horizon Match Rate</span>
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-black text-white">
            {telemetry && telemetry.exactHorizonMatchRate != null ? `${telemetry.exactHorizonMatchRate}%` : '—'}
          </div>
          <div className="text-[10px] text-emerald-300/80 mt-1">Target Horizon == Deriv Executed Contract</div>
        </div>

        <div className="rounded-2xl border border-cyan-500/30 bg-cyan-950/10 p-4">
          <div className="flex items-center justify-between text-xs font-bold text-cyan-400 uppercase tracking-wider">
            <span>Avg Proposal Latency</span>
            <Zap className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-black text-white">
            {telemetry && telemetry.avgProposalLatencyMs != null ? `⚡ ${telemetry.avgProposalLatencyMs}ms` : '—'}
          </div>
          <div className="text-[10px] text-cyan-300/80 mt-1">WebSocket Proposal → Buy Confirmation</div>
        </div>

        <div className="rounded-2xl border border-purple-500/30 bg-purple-950/10 p-4">
          <div className="flex items-center justify-between text-xs font-bold text-purple-400 uppercase tracking-wider">
            <span>Overall Win Rate</span>
            <Award className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-black text-white">
            {telemetry && telemetry.overallWinRate != null ? `${telemetry.overallWinRate}%` : '—'}
          </div>
          <div className="text-[10px] text-purple-300/80 mt-1">Real Executed Positions Outing</div>
        </div>

        <div className="rounded-2xl border border-amber-500/30 bg-amber-950/10 p-4">
          <div className="flex items-center justify-between text-xs font-bold text-amber-400 uppercase tracking-wider">
            <span>Audited Executions</span>
            <Layers className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-black text-white">
            {telemetry ? telemetry.totalExecutions : '—'}
          </div>
          <div className="text-[10px] text-amber-300/80 mt-1">Durable Log Records Inspected</div>
        </div>
      </div>

      {/* Attribution Analytics Widget (MFE/MAE Distributions & Online Regime Multipliers) */}
      <AttributionAnalyticsWidget data={attribution} loading={loading} />

      {/* Cohort Performance Breakdown */}
      <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-black text-white uppercase tracking-wider">Horizon Cohort Win Probability & Execution Match</h3>
            <p className="text-xs text-slate-400">Aggregated performance across 1t, 5t, 15s, 1m, and 2m execution horizons.</p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="border-b border-white/10 text-[10px] font-black uppercase text-slate-400 bg-black/40">
              <tr>
                <th className="p-3">Cohort Horizon</th>
                <th className="p-3">Total Trades</th>
                <th className="p-3">Wins / Loss</th>
                <th className="p-3">Cohort Win Rate</th>
                <th className="p-3">Avg Latency</th>
                <th className="p-3">Horizon Match Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 font-mono">
              {cohorts.map((c) => (
                <tr key={c.cohort} className="hover:bg-white/[0.02]">
                  <td className="p-3 font-extrabold text-white font-sans">
                    <span className="inline-block px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                      {c.cohort}
                    </span>
                  </td>
                  <td className="p-3 font-bold text-slate-200">{c.totalTrades}</td>
                  <td className="p-3">
                    <span className="text-emerald-400 font-bold">{c.wins}</span> / <span className="text-rose-400 font-bold">{c.totalTrades - c.wins}</span>
                  </td>
                  <td className="p-3 font-black text-emerald-400">
                    {c.winRate}%
                  </td>
                  <td className="p-3 text-cyan-300 font-bold">
                    ⚡ {c.avgLatencyMs}ms
                  </td>
                  <td className="p-3">
                    <span className="inline-flex items-center gap-1 text-emerald-300 font-bold">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      {c.matchRate}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Real-Time Live Execution Logs */}
      <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-black text-white uppercase tracking-wider">Microsecond Telemetry Execution Feed</h3>
            <p className="text-xs text-slate-400">Live order logs showing model snapshot issuance vs. Deriv confirmation.</p>
          </div>
          <span className="text-[10px] font-mono text-cyan-400 bg-cyan-500/10 px-2.5 py-1 rounded-lg border border-cyan-500/30">
            {executions.length} Executions Logged
          </span>
        </div>

        <div className="overflow-x-auto max-h-[450px]">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="sticky top-0 border-b border-white/10 text-[10px] font-black uppercase text-slate-400 bg-slate-950">
              <tr>
                <th className="p-3">Asset & Strategy</th>
                <th className="p-3">Target Horizon</th>
                <th className="p-3">Executed Contract</th>
                <th className="p-3">Horizon Match</th>
                <th className="p-3">Latency</th>
                <th className="p-3">Calibrated Win Exp.</th>
                <th className="p-3">Outcome</th>
                <th className="p-3">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 font-mono text-[11px]">
              {executions.map((x) => (
                <tr key={x.id} className="hover:bg-white/[0.02]">
                  <td className="p-3 font-sans">
                    <div className="font-bold text-white">{x.assetSymbol}</div>
                    <div className="text-[10px] text-slate-400">{x.strategy}</div>
                  </td>
                  <td className="p-3">
                    <span className="font-extrabold text-cyan-300 bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
                      {x.targetHorizon}
                    </span>
                  </td>
                  <td className="p-3 font-bold text-slate-200">
                    {x.contractType} ({x.executedDuration})
                  </td>
                  <td className="p-3">
                    {x.horizonMatch ? (
                      <span className="inline-flex items-center gap-1 text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                        <CheckCircle2 className="h-3 w-3" /> MATCH
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-400 font-bold bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30">
                        <AlertTriangle className="h-3 w-3" /> MISMATCH
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-cyan-300 font-bold">
                    ⚡ {x.proposalLatencyMs}ms
                  </td>
                  <td className="p-3 font-bold text-purple-300">
                    {x.calibratedWinProb}%
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                      ['WON', 'WIN'].includes(x.status) 
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' 
                        : ['LOST', 'LOSS'].includes(x.status)
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                        : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    }`}>
                      {x.status}
                    </span>
                  </td>
                  <td className="p-3 text-[10px] text-slate-400">
                    {new Date(x.executedAt).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
