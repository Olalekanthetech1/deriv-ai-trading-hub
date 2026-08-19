'use client';

import { useState, useMemo } from 'react';
import {
  Sparkles,
  CheckCircle2,
  Crown,
  Zap,
  ArrowRight,
  TrendingUp,
  AlertCircle,
  RefreshCw,
  Award,
  Filter,
  CheckSquare,
  Square,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  Activity,
} from 'lucide-react';
import type { EligibleCandidateModel } from '@/app/api/admin/champion-challenger/eligible/route';

interface EligiblePromotionsTabProps {
  eligibleModels: EligibleCandidateModel[];
  ineligibleModels: Array<EligibleCandidateModel & { rejectionReason: string }>;
  loading: boolean;
  onRefresh: () => Promise<void>;
  onPromoteBatch: (modelIds: string[]) => Promise<void>;
  onPromoteSingle: (model: EligibleCandidateModel) => Promise<void>;
  busy: string | null;
}

function pct(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return '—';
  return `${val.toFixed(2)}%`;
}

function f1Str(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return '—';
  return val.toFixed(3);
}

export function EligiblePromotionsTab({
  eligibleModels,
  ineligibleModels,
  loading,
  onRefresh,
  onPromoteBatch,
  onPromoteSingle,
  busy,
}: EligiblePromotionsTabProps) {
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [selectedAssetFilter, setSelectedAssetFilter] = useState<string>('ALL');
  const [showIneligible, setShowIneligible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [backtestEvaluating, setBacktestEvaluating] = useState(false);
  const [backtestFeedback, setBacktestFeedback] = useState<{ count: number; promoted: number; msg: string } | null>(null);

  const symbolsList = useMemo(() => {
    const set = new Set<string>();
    for (const m of eligibleModels) set.add(m.symbol);
    return Array.from(set).sort();
  }, [eligibleModels]);

  const filteredEligible = useMemo(() => {
    return eligibleModels.filter((m) => {
      if (selectedAssetFilter !== 'ALL' && m.symbol !== selectedAssetFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matches =
          m.symbol.toLowerCase().includes(q) ||
          m.assetDisplayName.toLowerCase().includes(q) ||
          m.modelId.toLowerCase().includes(q) ||
          m.framework.toLowerCase().includes(q) ||
          `${m.horizonSecs}s`.includes(q);
        if (!matches) return false;
      }
      return true;
    });
  }, [eligibleModels, selectedAssetFilter, searchQuery]);

  const isAllSelected = filteredEligible.length > 0 && filteredEligible.every((m) => selectedModelIds.has(m.modelId));

  const toggleSelectAll = () => {
    if (isAllSelected) {
      const next = new Set(selectedModelIds);
      for (const m of filteredEligible) next.delete(m.modelId);
      setSelectedModelIds(next);
    } else {
      const next = new Set(selectedModelIds);
      for (const m of filteredEligible) next.add(m.modelId);
      setSelectedModelIds(next);
    }
  };

  const toggleSelectOne = (modelId: string) => {
    const next = new Set(selectedModelIds);
    if (next.has(modelId)) {
      next.delete(modelId);
    } else {
      next.add(modelId);
    }
    setSelectedModelIds(next);
  };

  const handlePromoteAll = async () => {
    const ids = Array.from(selectedModelIds.size > 0 ? selectedModelIds : filteredEligible.map((m) => m.modelId));
    if (!ids.length) return;
    await onPromoteBatch(ids);
    setSelectedModelIds(new Set());
  };

  const handleBacktestAndPromote = async () => {
    const ids = Array.from(selectedModelIds.size > 0 ? selectedModelIds : filteredEligible.map((m) => m.modelId));
    if (!ids.length) return;
    setBacktestEvaluating(true);
    setBacktestFeedback(null);
    try {
      const res = await fetch('/api/admin/pipeline-auto-eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds: ids, autoPromote: true }),
      });
      const data = await res.json();
      if (data?.success && data?.evaluationSummary) {
        setBacktestFeedback({
          count: data.evaluationSummary.totalEvaluated,
          promoted: data.evaluationSummary.promotedCount,
          msg: `Evaluated ${data.evaluationSummary.totalEvaluated} models: ${data.evaluationSummary.promotedCount} passed walk-forward backtest and auto-promoted.`,
        });
        await onRefresh();
        setSelectedModelIds(new Set());
      } else {
        setBacktestFeedback({
          count: ids.length,
          promoted: 0,
          msg: data?.error || 'Walk-forward backtest evaluation failed.',
        });
      }
    } catch (err: any) {
      setBacktestFeedback({
        count: ids.length,
        promoted: 0,
        msg: err?.message || 'Network error during backtest evaluation.',
      });
    } finally {
      setBacktestEvaluating(false);
    }
  };

  const avgAccDelta = useMemo(() => {
    if (!filteredEligible.length) return 0;
    return filteredEligible.reduce((sum, m) => sum + (m.governance.accuracyDelta ?? 0), 0) / filteredEligible.length;
  }, [filteredEligible]);

  const avgF1Delta = useMemo(() => {
    if (!filteredEligible.length) return 0;
    return filteredEligible.reduce((sum, m) => sum + (m.governance.f1Delta ?? 0), 0) / filteredEligible.length;
  }, [filteredEligible]);

  const initialChampionsCount = useMemo(() => {
    return filteredEligible.filter((m) => m.governance.isInitialChampion).length;
  }, [filteredEligible]);

  return (
    <div className="space-y-6">
      {/* Top Aggregation Header Bar */}
      <div className="rounded-3xl border border-emerald-500/30 bg-gradient-to-br from-emerald-950/30 via-slate-900/60 to-slate-950/80 p-6 shadow-2xl shadow-emerald-950/20 backdrop-blur-xl">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-3.5 shadow-inner">
              <Sparkles className="h-7 w-7 text-emerald-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-200">
                  Governance Engine Verified
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  Strict Pareto Improvement Enforced
                </span>
              </div>
              <h2 className="mt-1 text-2xl font-black tracking-tight text-white sm:text-3xl">
                {eligibleModels.length} Eligible Models Ready to Promote
              </h2>
              <p className="mt-1 text-xs text-slate-400 max-w-2xl leading-relaxed">
                These candidate models strictly outperform the active champions in both validation accuracy and F1 score without metric regression, or establish the initial champion for new duration horizons.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void onRefresh()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-xs font-semibold text-slate-300 hover:bg-white/10 transition"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Re-Scan Registry
            </button>
            <button
              onClick={() => void handleBacktestAndPromote()}
              disabled={loading || backtestEvaluating || filteredEligible.length === 0}
              className="inline-flex items-center gap-2 rounded-2xl border border-cyan-400/40 bg-gradient-to-r from-cyan-500/20 to-blue-500/20 px-4 py-3 text-xs font-black uppercase tracking-wider text-cyan-300 shadow-xl shadow-cyan-950/40 hover:bg-cyan-500/30 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {backtestEvaluating ? (
                <RefreshCw className="h-4 w-4 animate-spin text-cyan-300" />
              ) : (
                <Activity className="h-4 w-4 text-cyan-300" />
              )}
              {selectedModelIds.size > 0
                ? `Backtest & Auto-Promote (${selectedModelIds.size})`
                : `Backtest & Auto-Promote Fleet (${filteredEligible.length})`}
            </button>
            <button
              onClick={() => void handlePromoteAll()}
              disabled={loading || busy !== null || filteredEligible.length === 0}
              className="inline-flex items-center gap-2.5 rounded-2xl bg-gradient-to-r from-emerald-400 to-teal-400 px-5 py-3 text-xs font-black uppercase tracking-wider text-slate-950 shadow-xl shadow-emerald-500/25 hover:from-emerald-300 hover:to-teal-300 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {busy === 'BATCH_PROMOTION' ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Award className="h-4 w-4" />
              )}
              {selectedModelIds.size > 0
                ? `Direct Promote ${selectedModelIds.size} Selected`
                : `Direct Promote All ${filteredEligible.length}`}
            </button>
          </div>
        </div>

        {backtestFeedback && (
          <div className="mt-4 rounded-xl border border-cyan-500/30 bg-cyan-950/40 p-3.5 text-xs text-cyan-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-cyan-400" />
              <span>{backtestFeedback.msg}</span>
            </div>
            <button
              onClick={() => setBacktestFeedback(null)}
              className="text-slate-400 hover:text-white text-xs ml-4"
            >
              ✕
            </button>
          </div>
        )}

        {/* Aggregate KPI Badges */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-2xl border border-white/5 bg-black/40 p-3.5">
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Eligible Models</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono text-emerald-300">{filteredEligible.length}</span>
              <span className="text-[11px] text-slate-500 font-mono">of {eligibleModels.length}</span>
            </div>
          </div>

          <div className="rounded-2xl border border-white/5 bg-black/40 p-3.5">
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Avg Accuracy Gain</span>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className={`text-xl font-bold font-mono ${avgAccDelta >= 0 ? 'text-emerald-400' : 'text-slate-200'}`}>
                {avgAccDelta > 0 ? `+${avgAccDelta.toFixed(2)}%` : `${avgAccDelta.toFixed(2)}%`}
              </span>
              <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
            </div>
          </div>

          <div className="rounded-2xl border border-white/5 bg-black/40 p-3.5">
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Avg F1 Score Gain</span>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className={`text-xl font-bold font-mono ${avgF1Delta >= 0 ? 'text-emerald-400' : 'text-slate-200'}`}>
                {avgF1Delta > 0 ? `+${avgF1Delta.toFixed(3)}` : `${avgF1Delta.toFixed(3)}`}
              </span>
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            </div>
          </div>

          <div className="rounded-2xl border border-white/5 bg-black/40 p-3.5">
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">New Horizons / Outperforms</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono text-cyan-300">{initialChampionsCount}</span>
              <span className="text-[11px] text-slate-500">Initial / {filteredEligible.length - initialChampionsCount} Upgrades</span>
            </div>
          </div>
        </div>
      </div>

      {/* Filter and Selection Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={toggleSelectAll}
            disabled={filteredEligible.length === 0}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-white/10 transition"
          >
            {isAllSelected ? (
              <CheckSquare className="h-4 w-4 text-emerald-400" />
            ) : (
              <Square className="h-4 w-4 text-slate-400" />
            )}
            {isAllSelected ? 'Deselect All' : 'Select All Filtered'}
          </button>

          {/* Symbol Filter Pills */}
          <div className="flex flex-wrap items-center gap-1.5 ml-2">
            <button
              onClick={() => setSelectedAssetFilter('ALL')}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition ${
                selectedAssetFilter === 'ALL'
                  ? 'bg-cyan-500 text-slate-950 font-bold'
                  : 'bg-white/5 text-slate-400 hover:text-white'
              }`}
            >
              All Assets ({eligibleModels.length})
            </button>
            {symbolsList.map((sym) => {
              const count = eligibleModels.filter((m) => m.symbol === sym).length;
              return (
                <button
                  key={sym}
                  onClick={() => setSelectedAssetFilter(sym)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition ${
                    selectedAssetFilter === sym
                      ? 'bg-cyan-500 text-slate-950 font-bold'
                      : 'bg-white/5 text-slate-400 hover:text-white'
                  }`}
                >
                  {sym} ({count})
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Search symbol, model ID, horizon..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="rounded-xl border border-white/10 bg-black/40 px-3.5 py-2 text-xs text-slate-200 placeholder-slate-500 focus:border-cyan-400 focus:outline-none w-64"
          />
        </div>
      </div>

      {/* Main Table of Eligible Models */}
      {filteredEligible.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.01] p-12 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-slate-600" />
          <h3 className="mt-3 text-base font-bold text-slate-300">No Eligible Models Match Current Filter</h3>
          <p className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
            All active candidate models have either already been promoted, or do not currently exceed the active production champions metrics.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.02] shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="border-b border-white/10 bg-black/40 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-3.5 px-4 w-10 text-center">
                    <button onClick={toggleSelectAll} className="text-slate-400 hover:text-white">
                      {isAllSelected ? (
                        <CheckSquare className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <Square className="h-4 w-4" />
                      )}
                    </button>
                  </th>
                  <th className="py-3.5 px-4">Asset &amp; Horizon</th>
                  <th className="py-3.5 px-4">Framework / Family</th>
                  <th className="py-3.5 px-4">Candidate Metrics</th>
                  <th className="py-3.5 px-4">Active Champion</th>
                  <th className="py-3.5 px-4">Improvement Delta (Δ)</th>
                  <th className="py-3.5 px-4">Governance Reason</th>
                  <th className="py-3.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-sans">
                {filteredEligible.map((model) => {
                  const isSelected = selectedModelIds.has(model.modelId);
                  const isBusy = busy === model.modelId || busy === 'BATCH_PROMOTION';
                  const isInitial = model.governance.isInitialChampion;

                  return (
                    <tr
                      key={model.modelId}
                      className={`transition hover:bg-white/[0.02] ${
                        isSelected ? 'bg-emerald-500/[0.04]' : ''
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="py-3 px-4 text-center">
                        <button
                          onClick={() => toggleSelectOne(model.modelId)}
                          className="text-slate-400 hover:text-white"
                        >
                          {isSelected ? (
                            <CheckSquare className="h-4 w-4 text-emerald-400" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </button>
                      </td>

                      {/* Asset & Horizon */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <div className="rounded-lg bg-white/5 px-2 py-1 font-mono font-bold text-white text-xs border border-white/10">
                            {model.symbol}
                          </div>
                          <div>
                            <p className="font-bold text-slate-100">{model.assetDisplayName}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="rounded bg-cyan-500/20 text-cyan-300 px-1.5 py-0.5 text-[10px] font-mono font-bold">
                                {model.horizonSecs}s Horizon
                              </span>
                              <span className="text-[10px] font-mono text-slate-500 truncate max-w-[120px]" title={model.modelId}>
                                {model.modelId.slice(0, 16)}…
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Framework / Family */}
                      <td className="py-3 px-4">
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold text-slate-300">
                          <Zap className="h-3 w-3 text-cyan-400" />
                          {model.framework}
                        </span>
                        {model.strategyKey && (
                          <span className="block mt-1 text-[10px] font-mono text-slate-500">
                            {model.strategyKey}
                          </span>
                        )}
                      </td>

                      {/* Candidate Metrics */}
                      <td className="py-3 px-4 font-mono">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-500 text-[10px]">Acc:</span>
                            <span className="font-bold text-slate-200">{pct(model.metrics.accuracy)}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-500 text-[10px]">F1:</span>
                            <span className="text-slate-300">{f1Str(model.metrics.f1)}</span>
                          </div>
                        </div>
                      </td>

                      {/* Active Champion */}
                      <td className="py-3 px-4 font-mono">
                        {model.champion ? (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="text-slate-500 text-[10px]">Acc:</span>
                              <span className="text-slate-400">{pct(model.champion.accuracy)}</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-slate-500 text-[10px]">F1:</span>
                              <span className="text-slate-400">{f1Str(model.champion.f1)}</span>
                            </div>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-300/80 bg-amber-400/10 px-2 py-0.5 rounded-md border border-amber-400/20">
                            None (Initial Horizon)
                          </span>
                        )}
                      </td>

                      {/* Improvement Delta */}
                      <td className="py-3 px-4 font-mono">
                        {isInitial ? (
                          <span className="text-xs font-bold text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-lg border border-emerald-400/20 inline-block">
                            ★ New Champion
                          </span>
                        ) : (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-slate-500">ΔAcc:</span>
                              <span className={`font-bold text-xs ${
                                (model.governance.accuracyDelta ?? 0) > 0 ? 'text-emerald-400' : 'text-slate-300'
                              }`}>
                                {(model.governance.accuracyDelta ?? 0) > 0 ? '+' : ''}
                                {model.governance.accuracyDelta?.toFixed(2)}%
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-slate-500">ΔF1:</span>
                              <span className={`font-bold text-xs ${
                                (model.governance.f1Delta ?? 0) > 0 ? 'text-emerald-400' : 'text-slate-300'
                              }`}>
                                {(model.governance.f1Delta ?? 0) > 0 ? '+' : ''}
                                {model.governance.f1Delta?.toFixed(3)}
                              </span>
                            </div>
                          </div>
                        )}
                      </td>

                      {/* Governance Reason */}
                      <td className="py-3 px-4">
                        <div className="flex items-start gap-1.5 max-w-xs">
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400 mt-0.5" />
                          <span className="text-[11px] text-slate-300 leading-snug">
                            {model.governance.reason}
                          </span>
                        </div>
                      </td>

                      {/* Action */}
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={() => void onPromoteSingle(model)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs font-bold text-emerald-200 hover:bg-emerald-400/20 transition disabled:opacity-40 cursor-pointer"
                        >
                          {busy === model.modelId ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Crown className="h-3.5 w-3.5 text-emerald-300" />
                          )}
                          Promote
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Ineligible Candidates Drawer Toggle */}
      {ineligibleModels.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.015] overflow-hidden">
          <button
            onClick={() => setShowIneligible(!showIneligible)}
            className="w-full flex items-center justify-between p-4 text-left hover:bg-white/[0.02] transition"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-slate-400" />
              <span className="text-xs font-bold text-slate-300">
                View Ineligible Candidates in Staging ({ineligibleModels.length})
              </span>
              <span className="text-[10px] text-slate-500 font-mono">
                (Rejected by Pareto Improvement or Missing Artifacts)
              </span>
            </div>
            {showIneligible ? (
              <ChevronUp className="h-4 w-4 text-slate-400" />
            ) : (
              <ChevronDown className="h-4 w-4 text-slate-400" />
            )}
          </button>

          {showIneligible && (
            <div className="border-t border-white/10 p-4 divide-y divide-white/5 text-xs">
              {ineligibleModels.map((inelig) => (
                <div key={inelig.modelId} className="py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-bold text-slate-300 bg-white/5 px-2 py-0.5 rounded border border-white/10">
                      {inelig.symbol} · {inelig.horizonSecs}s
                    </span>
                    <span className="text-slate-400 font-mono text-[11px] truncate max-w-xs">{inelig.modelId}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px]">
                    <span className="text-slate-400">
                      Acc: {pct(inelig.metrics.accuracy)} | F1: {f1Str(inelig.metrics.f1)}
                    </span>
                    <span className="rounded bg-rose-500/10 border border-rose-500/20 text-rose-300 px-2 py-0.5 text-[10px] font-medium">
                      {inelig.rejectionReason}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
