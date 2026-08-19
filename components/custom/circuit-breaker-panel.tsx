'use client';

import React, { useState, useEffect } from 'react';
import { ShieldAlert, RefreshCw, CheckCircle2, AlertTriangle, Cpu, ArrowDownRight, Activity } from 'lucide-react';
import { toast } from 'sonner';

export function CircuitBreakerPanel() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [evaluating, setEvaluating] = useState<boolean>(false);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/ml/circuit-breaker');
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (e) {
      console.warn('[CircuitBreakerPanel Fetch Error]:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleRunEvaluation = async () => {
    try {
      setEvaluating(true);
      const res = await fetch('/api/ml/circuit-breaker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoDemote: true }),
      });
      const result = await res.json();
      if (res.ok && result.success) {
        const breached = result.result?.breachedCount ?? 0;
        const demoted = result.result?.demotedCount ?? 0;
        if (demoted > 0) {
          toast.warning(`Circuit Breaker Triggered`, {
            description: `Auto-demoted ${demoted} underperforming model(s) to staging due to accuracy drift.`,
          });
        } else {
          toast.success(`Circuit Breaker Check Passed`, {
            description: `All ${result.result?.evaluatedCount ?? 0} production models are operating within drift tolerance.`,
          });
        }
        await fetchStatus();
      } else {
        toast.error('Evaluation failed', { description: result.error || 'Unknown error' });
      }
    } catch (err: any) {
      toast.error('Evaluation failed', { description: err.message });
    } finally {
      setEvaluating(false);
    }
  };

  const reports = data?.driftReport?.reports || [];
  const recentDemotions = data?.overview?.recentDemotions || [];

  return (
    <section className="mt-8 rounded-2xl border border-white/10 bg-slate-950/60 p-6 shadow-xl backdrop-blur-md">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-white/10 pb-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-400/30 bg-amber-500/10 text-amber-300">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
              Automated Drift &amp; Performance Circuit Breaker
              <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                ACTIVE GATE
              </span>
            </h3>
            <p className="text-xs text-slate-400">
              Continuously monitors live prediction accuracy vs validation baseline. Auto-demotes models with &gt;15% drift or accuracy &lt;48%.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={handleRunEvaluation}
            disabled={evaluating}
            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-400/30 bg-amber-500/20 px-4 py-2 text-xs font-bold text-amber-200 hover:bg-amber-500/30 transition disabled:opacity-50"
          >
            <Activity className={`h-3.5 w-3.5 ${evaluating ? 'animate-spin' : ''}`} />
            {evaluating ? 'Evaluating Fleet...' : 'Run Circuit Breaker Pass'}
          </button>
        </div>
      </div>

      {/* Production Drift Table */}
      <div className="mt-5">
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
          Live Model Drift Telemetry ({reports.length} Production Models)
        </h4>

        {reports.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-slate-500">
            No active production models currently registered in the fleet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-white/10 text-slate-500 font-semibold">
                  <th className="py-2.5 px-3">Model</th>
                  <th className="py-2.5 px-3">Asset &amp; Duration</th>
                  <th className="py-2.5 px-3 text-right">Validation Baseline</th>
                  <th className="py-2.5 px-3 text-right">Live Accuracy</th>
                  <th className="py-2.5 px-3 text-right">Samples</th>
                  <th className="py-2.5 px-3 text-right">Drift Delta</th>
                  <th className="py-2.5 px-3 text-center">Circuit Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-mono">
                {reports.map((r: any) => {
                  const hasSamples = r.sampleCount >= 15;
                  const isHealthy = !r.isBreached;
                  return (
                    <tr key={r.modelId} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3 px-3">
                        <div className="font-sans font-bold text-slate-200">{r.modelKey || r.modelFamily}</div>
                        <div className="text-[10px] text-slate-500 truncate max-w-[140px]">{r.modelId}</div>
                      </td>
                      <td className="py-3 px-3">
                        <span className="font-sans font-semibold text-slate-300">{r.symbol}</span>
                        <span className="ml-1 text-slate-500">({r.durationValue}{r.durationUnit})</span>
                      </td>
                      <td className="py-3 px-3 text-right text-cyan-300">
                        {r.validationAccuracy ? `${(r.validationAccuracy * 100).toFixed(1)}%` : '—'}
                      </td>
                      <td className="py-3 px-3 text-right">
                        {r.liveAccuracy !== null ? (
                          <span className={r.liveAccuracy >= 0.52 ? 'text-emerald-400' : 'text-amber-400'}>
                            {(r.liveAccuracy * 100).toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-slate-500 italic font-sans text-[11px]">Collecting ticks</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right text-slate-400">
                        {r.sampleCount}
                      </td>
                      <td className="py-3 px-3 text-right">
                        {r.accuracyDrop !== null ? (
                          <span className={r.accuracyDrop > 0.15 ? 'text-rose-400 font-bold' : 'text-slate-400'}>
                            {r.accuracyDrop > 0 ? `-${(r.accuracyDrop * 100).toFixed(1)}%` : `+${(Math.abs(r.accuracyDrop) * 100).toFixed(1)}%`}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-3 px-3 text-center">
                        {isHealthy ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300 font-sans">
                            <CheckCircle2 className="h-3 w-3" />
                            HEALTHY
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold text-rose-300 font-sans">
                            <AlertTriangle className="h-3 w-3" />
                            DRIFT BREACH
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

      {/* Recent Circuit Breaker Demotions */}
      {recentDemotions.length > 0 && (
        <div className="mt-6 border-t border-white/10 pt-5">
          <h4 className="text-xs font-bold uppercase tracking-wider text-amber-300 mb-3 flex items-center gap-2">
            <ArrowDownRight className="h-4 w-4" />
            Recent Automated Circuit Breaker Demotions ({recentDemotions.length})
          </h4>
          <div className="space-y-2">
            {recentDemotions.map((demotion: any) => (
              <div
                key={demotion.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between rounded-xl border border-amber-400/20 bg-amber-500/[0.04] p-3 text-xs"
              >
                <div>
                  <div className="font-bold text-amber-200">
                    Model {demotion.modelId} auto-demoted to Staging
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {demotion.metadata?.breachReason || 'Drift exceeded baseline tolerance'}
                  </div>
                </div>
                <div className="text-[11px] text-slate-500 font-mono mt-1 sm:mt-0">
                  {new Date(demotion.createdAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
