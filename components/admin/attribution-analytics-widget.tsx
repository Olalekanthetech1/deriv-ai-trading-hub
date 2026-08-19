'use client';

import { 
  Activity, 
  AlertTriangle, 
  BarChart2, 
  CheckCircle2, 
  Compass, 
  Gauge, 
  Percent, 
  ShieldAlert, 
  Sparkles, 
  Zap 
} from 'lucide-react';

export interface HorizonAttributionMetrics {
  tradeId: string;
  symbol: string;
  horizonKey: string;
  outcome: 'WIN' | 'LOSS';
  profit: number;
  mfe: number;
  mae: number;
  mfeRatio: number;
  optimalExitTickIndex: number;
  totalTicksObserved: number;
  earlyExhaustion: boolean;
  horizonFitScore: number;
  attributionTimestamp: number;
}

export interface HorizonPriorAdjustment {
  horizonKey: string;
  sampleCount: number;
  realizedWinRate: number;
  avgMfeRatio: number;
  earlyExhaustionRate: number;
  regimeFitnessMultiplier: number;
  attributionDriftBreached: boolean;
  lastUpdated: number;
}

export interface AttributionDiagnosticsData {
  totalAttributions: number;
  recentAttributions: HorizonAttributionMetrics[];
  horizonPriors: HorizonPriorAdjustment[];
  mfeDistribution: {
    excellent: number;
    moderate: number;
    adverse: number;
  };
  earlyExhaustionTotal: number;
}

interface AttributionAnalyticsWidgetProps {
  data?: AttributionDiagnosticsData | null;
  loading?: boolean;
}

export function AttributionAnalyticsWidget({ data, loading }: AttributionAnalyticsWidgetProps) {
  if (loading) {
    return (
      <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-6 flex items-center justify-center min-h-[220px]">
        <div className="flex items-center gap-3 text-cyan-300">
          <Activity className="h-5 w-5 animate-spin" />
          <span className="text-xs font-semibold uppercase tracking-wider">Loading Attribution Forensics...</span>
        </div>
      </div>
    );
  }

  const total = data?.totalAttributions || 0;
  const priors = data?.horizonPriors || [];
  const recents = data?.recentAttributions || [];
  const mfeDist = data?.mfeDistribution || { excellent: 0, moderate: 0, adverse: 0 };
  const earlyExhaustions = data?.earlyExhaustionTotal || 0;

  const excellentPct = total > 0 ? Math.round((mfeDist.excellent / total) * 100) : 0;
  const moderatePct = total > 0 ? Math.round((mfeDist.moderate / total) * 100) : 0;
  const adversePct = total > 0 ? Math.round((mfeDist.adverse / total) * 100) : 0;

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-5 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-white/5 pb-4">
        <div className="flex items-center gap-3">
          <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-2">
            <Compass className="h-5 w-5 text-emerald-300" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-black text-white uppercase tracking-wider">
                Attribution Analytics & Regime Multipliers
              </h3>
              <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/30">
                CPARFE ACTIVE
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Live Maximum Favorable Excursion (MFE) vs Adverse Excursion (MAE) path dynamics & online HDE prior modulations.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-cyan-300 bg-cyan-950/60 px-3 py-1 rounded-lg border border-cyan-800/50">
            {total} Trades Attributed
          </span>
        </div>
      </div>

      {/* Top 3 Summary Metric Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* MFE Dominance */}
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/20 p-4">
          <div className="flex items-center justify-between text-xs font-bold text-emerald-400 uppercase tracking-wider">
            <span>MFE Path Dominance</span>
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-black text-white">{excellentPct}%</span>
            <span className="text-xs font-semibold text-emerald-400/90 font-mono">({mfeDist.excellent}/{total})</span>
          </div>
          <div className="mt-1 text-[10px] text-slate-400">
            Trades maintaining &ge;70% MFE ratio across full micro-horizon duration.
          </div>
        </div>

        {/* Early Exhaustion Rate */}
        <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 p-4">
          <div className="flex items-center justify-between text-xs font-bold text-amber-400 uppercase tracking-wider">
            <span>Early Exhaustion Events</span>
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-black text-white">
              {total > 0 ? `${Math.round((earlyExhaustions / total) * 100)}%` : '0%'}
            </span>
            <span className="text-xs font-semibold text-amber-400/90 font-mono">({earlyExhaustions} events)</span>
          </div>
          <div className="mt-1 text-[10px] text-slate-400">
            Peak MFE reached in first 40% of duration before decay (short-lived micro-bursts).
          </div>
        </div>

        {/* Active Horizon Priors */}
        <div className="rounded-xl border border-purple-500/20 bg-purple-950/20 p-4">
          <div className="flex items-center justify-between text-xs font-bold text-purple-400 uppercase tracking-wider">
            <span>Active Horizon Priors</span>
            <Gauge className="h-4 w-4" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-black text-white">{priors.length}</span>
            <span className="text-xs font-semibold text-purple-300 font-mono">Calibrated Units</span>
          </div>
          <div className="mt-1 text-[10px] text-slate-400">
            Live dynamic prior adjustments modulating HDE candidate utility.
          </div>
        </div>
      </div>

      {/* MFE vs MAE Distribution Bar */}
      <div className="space-y-2 rounded-xl border border-white/5 bg-black/40 p-4">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
          <span className="uppercase tracking-wider text-[11px] font-bold text-slate-400">Microstructure MFE/MAE Spectrum</span>
          <span className="text-[11px] font-mono text-cyan-300">{total} Total Samples</span>
        </div>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            style={{ width: `${excellentPct}%` }}
            className="bg-emerald-500 transition-all duration-500 hover:opacity-90"
            title={`High MFE (>=0.70): ${excellentPct}%`}
          />
          <div
            style={{ width: `${moderatePct}%` }}
            className="bg-cyan-500 transition-all duration-500 hover:opacity-90"
            title={`Balanced Path (0.40-0.70): ${moderatePct}%`}
          />
          <div
            style={{ width: `${adversePct}%` }}
            className="bg-rose-500 transition-all duration-500 hover:opacity-90"
            title={`High MAE (<0.40): ${adversePct}%`}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between pt-1 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="text-slate-300">High MFE Dominance (&ge;70%):</span>
            <span className="font-mono font-bold text-emerald-400">{excellentPct}%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-cyan-500" />
            <span className="text-slate-300">Moderate Equilibrium (40-70%):</span>
            <span className="font-mono font-bold text-cyan-300">{moderatePct}%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-rose-500" />
            <span className="text-slate-300">High Adverse MAE (&lt;40%):</span>
            <span className="font-mono font-bold text-rose-400">{adversePct}%</span>
          </div>
        </div>
      </div>

      {/* Active Horizon Priors Table */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-black uppercase tracking-wider text-slate-300">
            Active Horizon Prior Multipliers (Online HDE Feedback)
          </h4>
          <span className="text-[10px] text-slate-500 font-mono">
            Bounded in range [0.60, 1.40]
          </span>
        </div>

        {priors.length === 0 ? (
          <div className="rounded-xl border border-white/5 bg-black/20 p-4 text-center text-xs text-slate-400">
            No dynamic horizon prior adjustments recorded yet. Priors calibrate automatically as trades settle.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="border-b border-white/10 bg-black/40 text-[10px] font-black uppercase text-slate-400">
                <tr>
                  <th className="p-3">Horizon Key</th>
                  <th className="p-3">Sample Count</th>
                  <th className="p-3">Realized Win Rate</th>
                  <th className="p-3">Avg MFE Ratio</th>
                  <th className="p-3">Early Exhaustion</th>
                  <th className="p-3">Regime Multiplier</th>
                  <th className="p-3">Drift Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-mono text-[11px]">
                {priors.map((p) => {
                  const mult = p.regimeFitnessMultiplier;
                  const isBoost = mult > 1.05;
                  const isPenalty = mult < 0.95;

                  return (
                    <tr key={p.horizonKey} className="hover:bg-white/[0.02]">
                      <td className="p-3 font-sans font-bold text-white">
                        <span className="inline-block rounded bg-cyan-500/20 px-2 py-0.5 font-mono text-cyan-300 border border-cyan-500/30">
                          {p.horizonKey}
                        </span>
                      </td>
                      <td className="p-3 text-slate-300 font-bold">{p.sampleCount}</td>
                      <td className="p-3 font-bold">
                        <span className={p.realizedWinRate >= 0.55 ? 'text-emerald-400' : 'text-rose-400'}>
                          {(p.realizedWinRate * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td className="p-3 font-bold text-cyan-300">
                        {(p.avgMfeRatio * 100).toFixed(1)}%
                      </td>
                      <td className="p-3">
                        <span className={p.earlyExhaustionRate > 0.30 ? 'text-amber-400 font-bold' : 'text-slate-400'}>
                          {(p.earlyExhaustionRate * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-block rounded px-2 py-0.5 font-bold ${
                            isBoost
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                              : isPenalty
                              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                              : 'bg-slate-800 text-slate-300 border border-white/10'
                          }`}
                        >
                          {mult.toFixed(2)}x
                        </span>
                      </td>
                      <td className="p-3">
                        {p.attributionDriftBreached ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/30">
                            <ShieldAlert className="h-3 w-3" /> DRIFT BREACH (RETRAINING TRIGGERED)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                            <CheckCircle2 className="h-3 w-3" /> NOMINAL REGIME
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Attribution Log Feed */}
      {recents.length > 0 && (
        <div className="space-y-3 pt-2 border-t border-white/5">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-black uppercase tracking-wider text-slate-300">
              Recent Trade Attributions (Post-Settlement Forensics)
            </h4>
            <span className="text-[10px] text-slate-500 font-mono">
              Last {recents.length} settlements
            </span>
          </div>

          <div className="overflow-x-auto max-h-[300px]">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="sticky top-0 border-b border-white/10 bg-slate-950 text-[10px] font-black uppercase text-slate-400">
                <tr>
                  <th className="p-2.5">Trade / Asset</th>
                  <th className="p-2.5">Horizon</th>
                  <th className="p-2.5">Outcome</th>
                  <th className="p-2.5">MFE / MAE Path</th>
                  <th className="p-2.5">MFE Ratio</th>
                  <th className="p-2.5">Fit Score</th>
                  <th className="p-2.5">Exhaustion</th>
                  <th className="p-2.5">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-mono text-[11px]">
                {recents.slice().reverse().map((r) => (
                  <tr key={r.tradeId} className="hover:bg-white/[0.02]">
                    <td className="p-2.5 font-sans">
                      <div className="font-bold text-white">{r.symbol}</div>
                      <div className="text-[9px] text-slate-500">{r.tradeId}</div>
                    </td>
                    <td className="p-2.5">
                      <span className="font-bold text-cyan-300">{r.horizonKey}</span>
                    </td>
                    <td className="p-2.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-black uppercase ${
                          r.outcome === 'WIN'
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                        }`}
                      >
                        {r.outcome}
                      </span>
                    </td>
                    <td className="p-2.5 font-mono text-[10px]">
                      <span className="text-emerald-400 font-bold">+{r.mfe.toFixed(3)}</span> /{' '}
                      <span className="text-rose-400 font-bold">-{r.mae.toFixed(3)}</span>
                    </td>
                    <td className="p-2.5 font-bold text-cyan-300">
                      {(r.mfeRatio * 100).toFixed(1)}%
                    </td>
                    <td className="p-2.5 font-bold text-purple-300">
                      {(r.horizonFitScore * 100).toFixed(0)}%
                    </td>
                    <td className="p-2.5">
                      {r.earlyExhaustion ? (
                        <span className="text-amber-400 text-[10px] font-bold">EARLY</span>
                      ) : (
                        <span className="text-slate-500 text-[10px]">STABLE</span>
                      )}
                    </td>
                    <td className="p-2.5 text-[10px] text-slate-400">
                      {new Date(r.attributionTimestamp).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
