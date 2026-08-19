'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Sparkles, AlertTriangle, CheckCircle2, ChevronRight, Activity, Cpu, ExternalLink, RefreshCw } from 'lucide-react';

interface MLReadinessBadgeProps {
  symbol?: string;
  durationValue?: number;
  durationUnit?: string;
  compact?: boolean;
  className?: string;
}

interface ReadinessData {
  success: boolean;
  ready: boolean;
  symbol: string;
  duration: { value: number; unit: string; label: string };
  productionModelCount: number;
  productionModels: Array<{
    modelId: string;
    modelKey: string;
    modelFamily: string;
    framework: string;
    isMultiHorizon?: boolean;
    validation?: { accuracy?: number; f1?: number; f1Score?: number };
  }>;
  isMultiHorizonCovered: boolean;
  candidateCount: number;
  stagingCount: number;
  trainUrl: string;
  promoteUrl: string;
  actionableTip?: string;
  errorCode?: string | null;
}

export function MLReadinessBadge({
  symbol = 'R_100',
  durationValue = 1,
  durationUnit = 't',
  compact = false,
  className = '',
}: MLReadinessBadgeProps) {
  const [data, setData] = useState<ReadinessData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [silentLoading, setSilentLoading] = useState<boolean>(false);
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Keep track of the parameters of the last fetch to implement "Silent Refreshing"
  const lastParamsRef = useRef<{ symbol: string; value: number; unit: string } | null>(null);

  const fetchReadiness = async (forceSpinner: boolean = false) => {
    const isSameParams =
      lastParamsRef.current &&
      lastParamsRef.current.symbol === symbol &&
      lastParamsRef.current.value === durationValue &&
      lastParamsRef.current.unit === durationUnit;

    try {
      if (isSameParams && !forceSpinner) {
        // If parameters are identical, fetch silently in the background without wiping current UI state or showing "Checking AI..."
        setSilentLoading(true);
      } else {
        // Only trigger layout loading if it's a completely new symbol, duration, or a forced manual refresh
        setLoading(true);
      }

      const res = await fetch(
        `/api/ml/readiness?symbol=${encodeURIComponent(symbol)}&durationValue=${durationValue}&durationUnit=${encodeURIComponent(durationUnit)}`
      );
      if (res.ok) {
        const json = await res.json();
        setData(json);
        // Record the last successfully fetched parameters
        lastParamsRef.current = { symbol, value: durationValue, unit: durationUnit };
      }
    } catch (e) {
      console.warn('[MLReadinessBadge Error]:', e);
    } finally {
      setLoading(false);
      setSilentLoading(false);
    }
  };

  useEffect(() => {
    fetchReadiness();
  }, [symbol, durationValue, durationUnit]);

  // Close popover when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const isReady = data?.ready ?? false;
  const isMultiHorizon = data?.isMultiHorizonCovered ?? false;
  const modelCount = data?.productionModelCount ?? 0;

  // Symmetrical layout measurements for stable layout boundary
  const badgeWidthClass = compact ? 'min-w-[85px]' : 'min-w-[155px] md:min-w-[165px]';

  return (
    <div className={`relative inline-block ${className}`} ref={popoverRef}>
      {/* Trigger Badge - Warp-Speed Symmetrical Container */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`group inline-flex items-center justify-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-all duration-300 ease-out hover:scale-[1.02] ${badgeWidthClass} ${
          loading
            ? 'border-white/10 bg-white/5 text-slate-400'
            : isReady
            ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300 hover:border-emerald-400/50 hover:bg-emerald-500/20'
            : 'border-amber-400/30 bg-amber-500/10 text-amber-300 hover:border-amber-400/50 hover:bg-amber-500/20'
        }`}
        title="Click to view AI Model Readiness Diagnostics"
      >
        {/* Symmetrical Animated Icon Slot - Spins when loading/refreshing to keep feedback live */}
        <div className="relative flex h-3.5 w-3.5 items-center justify-center transition-transform duration-300">
          {loading || silentLoading ? (
            <RefreshCw className={`h-3 w-3 animate-spin ${isReady ? 'text-emerald-400' : 'text-amber-400'}`} />
          ) : isReady ? (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          ) : (
            <AlertTriangle className="h-3 w-3 text-amber-400 animate-pulse" />
          )}
        </div>

        {/* Warp-Speed Symmetrical Text Slot - Retains previous state text to avoid layout-shaking */}
        <span className="whitespace-nowrap font-mono tracking-tight transition-all duration-300 ease-out select-none">
          {data === null && loading ? (
            compact ? (
              'AI Ready'
            ) : (
              'AI Ready · Multi-Horizon'
            )
          ) : isReady ? (
            compact ? (
              'AI Ready'
            ) : (
              `AI Ready · ${isMultiHorizon ? 'Multi-Horizon' : `${modelCount} Model${modelCount > 1 ? 's' : ''}`}`
            )
          ) : (
            compact ? 'No AI Model' : `No Model (${durationValue}${durationUnit})`
          )}
        </span>
      </button>

      {/* Interactive Diagnostics Popover */}
      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 rounded-2xl border border-white/15 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-xl transition-all">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-cyan-400" />
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                AI Model Diagnostics
              </h4>
            </div>
            <button
              onClick={() => fetchReadiness(true)}
              disabled={loading}
              className="text-slate-400 hover:text-white transition-colors"
              title="Refresh status"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="mt-3 space-y-2.5">
            {/* Target context */}
            <div className="flex items-center justify-between rounded-xl bg-white/[0.03] px-3 py-2 text-xs">
              <span className="text-slate-400">Target Asset & Duration:</span>
              <span className="font-mono font-bold text-slate-100">
                {symbol} · {durationValue}{durationUnit}
              </span>
            </div>

            {/* Coverage Status */}
            <div
              className={`rounded-xl border p-3 text-xs ${
                isReady
                  ? 'border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-300'
                  : 'border-amber-400/20 bg-amber-400/[0.05] text-amber-300'
              }`}
            >
              <div className="flex items-center gap-2 font-bold">
                {isReady ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-amber-400" />
                )}
                {isReady ? 'Production Model Active' : 'No Production Model Registered'}
              </div>
              <p className="mt-1 text-[11px] leading-4 text-slate-400">
                {isReady
                  ? isMultiHorizon
                    ? 'Unified Multi-Horizon champion is active. Auto Signal Entry is ready across all durations.'
                    : `Active ensemble with ${modelCount} production classifier(s) trained for this horizon.`
                  : data?.actionableTip ||
                    `No active predictive model found for ${symbol} at ${durationValue}${durationUnit}. Auto signal analysis is locked.`}
              </p>
            </div>

            {/* Production Models List if any */}
            {isReady && data?.productionModels && data.productionModels.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Active Ensemble Classifiers:
                </div>
                {data.productionModels.map((m) => (
                  <div
                    key={m.modelId}
                    className="flex items-center justify-between rounded-lg bg-black/40 px-2.5 py-1.5 text-[11px] font-mono text-slate-300"
                  >
                    <span className="capitalize">{m.modelKey || m.modelFamily}</span>
                    <span className="text-emerald-400">
                      {m.validation?.accuracy
                        ? `${(m.validation.accuracy * 100).toFixed(1)}% Acc`
                        : m.isMultiHorizon
                        ? 'Multi-Horizon'
                        : 'Active'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Candidate / Staging hints */}
            {!isReady && (data?.candidateCount ?? 0) + (data?.stagingCount ?? 0) > 0 && (
              <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] p-2.5 text-xs text-cyan-300">
                <div className="font-bold flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
                  Candidates Available ({data?.candidateCount ?? 0} candidate / {data?.stagingCount ?? 0} staging)
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  Trained candidates exist for this asset. Promote one to Production to unlock AI trading.
                </p>
              </div>
            )}

            {/* Quick Actions */}
            <div className="pt-2 flex flex-col gap-2">
              {!isReady && (
                <>
                  <Link
                    href={data?.promoteUrl || `/admin/models?symbol=${encodeURIComponent(symbol)}`}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-cyan-500/20 border border-cyan-400/40 px-3 py-2 text-xs font-bold text-cyan-200 hover:bg-cyan-500/30 transition-all"
                  >
                    <span>Promote Candidate in Registry</span>
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                  <Link
                    href={data?.trainUrl || `/admin/model-training?symbol=${encodeURIComponent(symbol)}`}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-500/20 border border-emerald-400/40 px-3 py-2 text-xs font-bold text-emerald-200 hover:bg-emerald-500/30 transition-all"
                  >
                    <span>Train Multi-Horizon Model</span>
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </>
              )}
              {isReady && (
                <Link
                  href={`/admin/models?symbol=${encodeURIComponent(symbol)}`}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-white/5 border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/10 transition-all"
                >
                  <span>View in Model Operations</span>
                  <ChevronRight className="h-3 w-3" />
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
