'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowUpRight, ArrowDownRight, Sparkles, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ProposalInfo, DerivWS, ActiveSymbol, AuthState } from '@deriv/core';
import type { Direction, DurationSelectUnit, DurationOption } from '@/lib/types';
import type { HorizonDecisionSnapshot } from '@/lib/horizon-decision-engine';
import type { AutoHorizonMode } from '@/lib/duration-utils';
import { PayoutInfoCard } from './payout-info-card';
import { DerivTradeConfigFields } from './deriv-trade-config-fields';
import { TickSentimentBar } from './tick-sentiment-bar';
import { MLReadinessBadge } from './ml-readiness-badge';
import { tradeStrategyStore } from '@/lib/trade-store';

interface ProModeControlsProps {
  authState?: AuthState;
  onLogin?: () => void;
  proposal: ProposalInfo | null;
  stake: string;
  onStakeChange: (val: string) => void;
  direction: Direction;
  onDirectionChange: (dir: Direction) => void;
  allowEquals?: boolean;
  onAllowEqualsChange?: (val: boolean) => void;
  onBuy: (targetDir?: Direction, overrides?: { duration?: number; durationUnit?: DurationSelectUnit; executionPlanId?: string }) => Promise<void>;
  isBuying: boolean;
  isConnected: boolean;
  duration: number;
  onDurationChange: (val: number) => void;
  durationUnit: DurationSelectUnit;
  onDurationUnitChange: (unit: DurationSelectUnit) => void;
  durationOptions: DurationOption[];
  endDate?: Date;
  onEndDateChange?: (date: Date | undefined) => void;
  endTime?: string;
  onEndTimeChange?: (time: string) => void;
  ws?: DerivWS | null;
  activeSymbol: ActiveSymbol | null;
  prices?: number[];
  decisionSnapshot?: HorizonDecisionSnapshot | null;
  isAutoDuration?: boolean;
  onIsAutoDurationChange?: (val: boolean) => void;
  onAutoDurationChange?: (val: boolean) => void;
  autoHorizonMode?: AutoHorizonMode;
  onAutoHorizonModeChange?: (mode: AutoHorizonMode) => void;
}

export function ProModeControls({
  authState,
  onLogin,
  proposal,
  stake,
  onStakeChange,
  direction,
  onDirectionChange,
  allowEquals = false,
  onAllowEqualsChange,
  onBuy,
  isBuying,
  isConnected,
  duration,
  onDurationChange,
  durationUnit,
  onDurationUnitChange,
  durationOptions,
  endDate,
  onEndDateChange,
  endTime,
  onEndTimeChange,
  ws,
  activeSymbol,
  prices,
  decisionSnapshot = null,
  isAutoDuration = false,
  onIsAutoDurationChange,
  onAutoDurationChange,
  autoHorizonMode = 'auto',
  onAutoHorizonModeChange = () => {},
}: ProModeControlsProps) {
  const [isAnalyzingAi, setIsAnalyzingAi] = useState(false);
  const [multiContractMultiplier, setMultiContractMultiplier] = useState(1);
  const [isBatchExecuting, setIsBatchExecuting] = useState(false);
  const [lastDecisionSnapshot, setLastDecisionSnapshot] = useState<HorizonDecisionSnapshot | null>(decisionSnapshot);

  const handleAutoDurationToggle = onAutoDurationChange || onIsAutoDurationChange || (() => {});

  const decisionSnapshotRef = useRef<HorizonDecisionSnapshot | null>(decisionSnapshot);
  const pricesRef = useRef<number[] | undefined>(prices);
  const autoHorizonModeRef = useRef<AutoHorizonMode>(autoHorizonMode);
  const isAutoDurationRef = useRef<boolean>(isAutoDuration ?? false);
  const durationRef = useRef<number>(duration);
  const durationUnitRef = useRef<DurationSelectUnit>(durationUnit);
  const durationOptionsRef = useRef<DurationOption[]>(durationOptions);
  const activeSymbolRef = useRef(activeSymbol);

  decisionSnapshotRef.current = decisionSnapshot || lastDecisionSnapshot;
  pricesRef.current = prices;
  autoHorizonModeRef.current = autoHorizonMode;
  isAutoDurationRef.current = isAutoDuration ?? false;
  durationRef.current = duration;
  durationUnitRef.current = durationUnit;
  durationOptionsRef.current = durationOptions;
  activeSymbolRef.current = activeSymbol;

  useEffect(() => {
    if (decisionSnapshot) {
      setLastDecisionSnapshot(decisionSnapshot);
      decisionSnapshotRef.current = decisionSnapshot;
    }
  }, [decisionSnapshot]);

  // Auto horizon is a server-owned decision. This helper only projects the
  // latest server snapshot; it never calculates an optimal duration locally.
  const resolveFreshOverrides = useCallback(() => {
    if (isAutoDurationRef.current) {
      const horizon = decisionSnapshotRef.current?.decision?.horizon;
      if (!horizon) throw new Error('Server-authoritative horizon decision is not available yet.');
      if (onDurationChange && horizon.value !== durationRef.current) onDurationChange(horizon.value);
      if (onDurationUnitChange && horizon.unit !== durationUnitRef.current) onDurationUnitChange(horizon.unit);
      return { duration: horizon.value, durationUnit: horizon.unit };
    }
    return { duration: durationRef.current, durationUnit: durationUnitRef.current };
  }, [onDurationChange, onDurationUnitChange]);

  const executeBatchTrade = async (
    targetDir: Direction,
    overridesParam?: { duration?: number; durationUnit?: DurationSelectUnit; executionPlanId?: string }
  ) => {
    if (isBatchExecuting || isBuying) return;

    const count = multiContractMultiplier;
    const initialOverrides = overridesParam || resolveFreshOverrides();

    if (count <= 1) {
      await onBuy(targetDir, initialOverrides);
      return;
    }

    setIsBatchExecuting(true);
    toast.info(`Batch Executing ${count}x Contracts...`, {
      description: `Submitting ${count} independent ${targetDir === 'CALL' ? 'RISE' : 'FALL'} orders at $${stake} each.`,
    });

    let successful = 0;
    const errors: string[] = [];

    try {
      for (let i = 0; i < count; i += 1) {
        try {
          const currentOverrides = overridesParam || (i === 0 ? initialOverrides : resolveFreshOverrides());
          await onBuy(targetDir, currentOverrides);
          successful += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown execution error';
          errors.push(`Contract ${i + 1}: ${message}`);
        }
      }

      if (successful === count) {
        toast.success(`Batch complete: ${successful}/${count} contracts purchased`, { description: `Total stake: $${(Number(stake) * count).toFixed(2)}.` });
      } else if (successful > 0) {
        toast.warning(`Partial batch: ${successful}/${count} contracts purchased`, { description: errors[0] || 'One or more contracts could not be purchased.' });
      } else {
        toast.error(`Batch failed: 0/${count} contracts purchased`, { description: errors[0] || 'No contracts were purchased.' });
      }
    } finally {
      setIsBatchExecuting(false);
    }
  };

  const handleRiseClick = () => {
    if (authState !== 'authenticated') {
      toast.error('Authentication Required', { description: 'Please log in to your Deriv account to execute live trades.' });
      return;
    }
    onDirectionChange('CALL');
    tradeStrategyStore.setStrategy('Manual');
    void executeBatchTrade('CALL').catch((error) => toast.error('Rise execution failed', { description: error instanceof Error ? error.message : 'Unable to execute the trade.' }));
  };

  const handleFallClick = () => {
    if (authState !== 'authenticated') {
      toast.error('Authentication Required', { description: 'Please log in to your Deriv account to execute live trades.' });
      return;
    }
    onDirectionChange('PUT');
    tradeStrategyStore.setStrategy('Manual');
    void executeBatchTrade('PUT').catch((error) => toast.error('Fall execution failed', { description: error instanceof Error ? error.message : 'Unable to execute the trade.' }));
  };

  const handleAiTradingClick = async () => {
    if (authState !== 'authenticated') {
      toast.error('Authentication Required', { description: 'Please log in to your Deriv account to execute AI trades.' });
      return;
    }
    if (!isConnected) {
      toast.error('Not connected to Deriv trading server');
      return;
    }

    const currentIsAuto = isAutoDurationRef.current;
    const requestedDuration = durationRef.current;
    const requestedUnit = durationUnitRef.current;

    setIsAnalyzingAi(true);
    toast.info('AI Model Analyzing...', {
      description: `Requesting a server-authoritative horizon for ${activeSymbol?.underlying_symbol_name || 'active symbol'}${currentIsAuto ? ' (Auto)' : ` (${requestedDuration}${requestedUnit})`}`,
      icon: <Sparkles className="h-4 w-4 text-cyan-400 animate-spin" />,
    });

    try {
      const currentPrices = pricesRef.current || [];
      const tickObjects = currentPrices.map((price, idx) => ({
        price,
        timestamp: Date.now() - (currentPrices.length - idx) * 1000,
      }));

      const res = await fetch('/api/signals/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: activeSymbol?.underlying_symbol || 'R_100',
          ticks: tickObjects.length >= 25 ? tickObjects : undefined,
          durationValue: requestedDuration,
          durationUnit: requestedUnit,
          pipSize: (activeSymbol as any)?.pip || 0.01,
          autoHorizonMode: autoHorizonModeRef.current,
          durationOptions: durationOptionsRef.current,
          isAutoDuration: currentIsAuto,
          mode: currentIsAuto ? 'auto' : autoHorizonModeRef.current !== 'auto' ? 'ai_assist' : 'manual',
        }),
      });

      let data: any = {};
      try {
        const text = await res.text();
        data = text ? JSON.parse(text) : {};
      } catch (parseErr) {
        throw new Error(
          !res.ok
            ? `Server request failed (Status ${res.status}: ${res.statusText || 'Edge Function Error'}). Please retry.`
            : 'Invalid JSON response received from signal service.'
        );
      }

      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Failed to generate AI signals (Status ${res.status})`);
      }

      setIsAnalyzingAi(false);

      const executionPlan = data.executionPlan;
      if (!executionPlan?.selectedHorizon || !executionPlan?.predictionHorizon || executionPlan.horizonAligned !== true) {
        throw new Error('Server returned no validated execution horizon. Trade blocked.');
      }
      if (executionPlan.selectedHorizon.value !== executionPlan.predictionHorizon.value || executionPlan.selectedHorizon.unit !== executionPlan.predictionHorizon.unit) {
        throw new Error('Server execution plan horizon mismatch. Trade blocked.');
      }
      if (data.strategyGate?.accepted !== true || executionPlan.strategyGateAccepted !== true) {
        throw new Error('AI strategy gate rejected the selected production horizon.');
      }
      if (typeof executionPlan.executionPlanId !== 'string' || !executionPlan.executionPlanId.trim()) {
        throw new Error('Server execution plan is missing its traceable identifier.');
      }

      if (data.decisionSnapshot) {
        setLastDecisionSnapshot(data.decisionSnapshot);
        decisionSnapshotRef.current = data.decisionSnapshot;
      }

      const decision = data.decisionSnapshot?.decision;
      const aiDirection: Direction = data.prediction?.signal === 'PUT' || decision?.direction === 'FALL' ? 'PUT' : 'CALL';
      const confidence = Number(data.prediction?.confidence ?? decision?.calibratedProbability ?? decision?.confidence ?? 0);
      const executionDuration = Number(executionPlan.selectedHorizon.value);
      const executionUnit = executionPlan.selectedHorizon.unit as DurationSelectUnit;

      if (onDurationChange && executionDuration !== durationRef.current) onDurationChange(executionDuration);
      if (onDurationUnitChange && executionUnit !== durationUnitRef.current) onDurationUnitChange(executionUnit);

      onDirectionChange(aiDirection);
      tradeStrategyStore.setStrategy('Horizon Decision Engine · Server Execution Plan');
      const horizonLabel = executionPlan.selectedHorizon.label || `${executionDuration}${executionUnit}`;
      const formattedConfidence = (confidence > 1 ? confidence : confidence * 100).toFixed(0);

      toast.success(`HDE Optimal Horizon: ${horizonLabel} (${formattedConfidence}% Confidence)`, {
        description: `Executing ${multiContractMultiplier > 1 ? `${multiContractMultiplier}x batch ` : ''}automated trade with ${stake} USD stake...`,
      });

      await executeBatchTrade(aiDirection, {
        duration: executionDuration,
        durationUnit: executionUnit,
        executionPlanId: executionPlan.executionPlanId,
      });
      return;
    } catch (err: any) {
      setIsAnalyzingAi(false);
      const isNoModel = String(err.message || '').includes('NO_PRODUCTION_PREDICTIVE_MODEL_REGISTERED');
      const targetSymbol = activeSymbol?.underlying_symbol || 'active symbol';
      if (isNoModel) {
        toast.error('AI Model Not Registered', {
          description: `No production predictive model found for ${targetSymbol}. Train or promote a candidate in the Model Operations Center.`,
          action: { label: 'Open Registry', onClick: () => window.open(`/admin/models?symbol=${encodeURIComponent(targetSymbol)}`, '_blank') },
          duration: 7000,
        });
      } else {
        toast.error('AI Analysis Failed', { description: err.message || 'System lacked sufficient data to generate signal. Please wait for more ticks.' });
      }
    }
  };

  const controlsDisabled = !isConnected || isBuying || isBatchExecuting || isAnalyzingAi;

  return (
    <div className="w-full space-y-4">
      <div className="space-y-2">
        <TickSentimentBar prices={prices} activeSymbol={activeSymbol} />
        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] font-medium text-slate-400">AI Model Readiness:</span>
          <MLReadinessBadge symbol={activeSymbol?.underlying_symbol} durationValue={duration} durationUnit={durationUnit} />
        </div>
      </div>

      <PayoutInfoCard proposal={proposal} stake={stake} />

      <DerivTradeConfigFields
        allowEquals={allowEquals}
        onAllowEqualsChange={onAllowEqualsChange}
        stake={stake}
        onStakeChange={onStakeChange}
        duration={duration}
        onDurationChange={onDurationChange}
        durationUnit={durationUnit}
        onDurationUnitChange={onDurationUnitChange}
        durationOptions={durationOptions}
        isAutoDuration={isAutoDuration}
        onAutoDurationChange={handleAutoDurationToggle}
        autoHorizonMode={autoHorizonMode}
        onAutoHorizonModeChange={onAutoHorizonModeChange}
        multiContractMultiplier={multiContractMultiplier}
        onMultiContractMultiplierChange={setMultiContractMultiplier}
        decisionSnapshot={decisionSnapshot || lastDecisionSnapshot}
        endDate={endDate}
        onEndDateChange={onEndDateChange}
        endTime={endTime}
        onEndTimeChange={onEndTimeChange}
        ws={ws}
        isConnected={isConnected}
        activeSymbol={activeSymbol}
        prices={prices}
        showMultiContract={true}
      />

      <div className="pt-2 border-t border-border/50 grid grid-cols-[1fr_2fr_1fr] gap-2.5 items-center">
        <button type="button" disabled={controlsDisabled} onClick={handleRiseClick} className="h-16 rounded-2xl bg-gradient-to-b from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 active:scale-95 transition-all duration-150 flex items-center justify-center shadow-lg shadow-emerald-950/40 border border-emerald-400/30 group disabled:opacity-50">
          <div className="flex flex-col items-center"><div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center group-hover:scale-110 transition-transform"><ArrowUpRight className="w-5 h-5 text-white stroke-[3]" /></div><span className="text-[10px] font-bold text-white uppercase tracking-tight mt-0.5">Rise</span></div>
        </button>

        <button type="button" disabled={controlsDisabled} onClick={handleAiTradingClick} className="relative h-16 rounded-2xl bg-gradient-to-r from-cyan-500 via-blue-600 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 active:scale-[0.98] transition-all duration-200 flex items-center justify-center px-3 shadow-xl shadow-cyan-500/25 border border-cyan-300/40 group overflow-hidden disabled:opacity-50">
          <div className="absolute inset-0 bg-gradient-to-r from-cyan-400/20 via-blue-400/30 to-purple-500/20 animate-pulse pointer-events-none" />
          <div className="relative flex items-center gap-2.5 z-10">
            <div className="w-9 h-9 rounded-full bg-white text-blue-600 font-black flex items-center justify-center text-xs tracking-tight shadow-md border border-white/50 shrink-0">{isAnalyzingAi ? <Loader2 className="w-5 h-5 animate-spin text-blue-600" /> : <span className="font-extrabold text-[13px] bg-gradient-to-r from-blue-600 to-indigo-700 bg-clip-text text-transparent">AI</span>}</div>
            <div className="flex flex-col text-left"><span className="text-sm font-extrabold tracking-wider text-white uppercase drop-shadow-sm flex items-center gap-1">TRADING <Sparkles className="w-3.5 h-3.5 text-cyan-200 animate-bounce" /></span><span className="text-[10px] text-cyan-100/90 font-medium tracking-tight">{isAnalyzingAi ? 'AI Signal...' : 'Auto-Signal Entry'}</span></div>
          </div>
        </button>

        <button type="button" disabled={controlsDisabled} onClick={handleFallClick} className="h-16 rounded-2xl bg-gradient-to-b from-red-500 to-rose-600 hover:from-red-400 hover:to-rose-500 active:scale-95 transition-all duration-150 flex items-center justify-center shadow-lg shadow-rose-950/40 border border-rose-400/30 group disabled:opacity-50">
          <div className="flex flex-col items-center"><div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center group-hover:scale-110 transition-transform"><ArrowDownRight className="w-5 h-5 text-white stroke-[3]" /></div><span className="text-[10px] font-bold text-white uppercase tracking-tight mt-0.5">Fall</span></div>
        </button>
      </div>
    </div>
  );
}
