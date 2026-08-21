'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Minus, Plus, Play, Square, Sparkles, Cpu, RefreshCw, BarChart2, Zap, Lock, Shuffle, Info } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import type { ProposalInfo, DerivWS, ActiveSymbol, AuthState } from '@deriv/core';
import type { Direction, DurationSelectUnit, DurationOption } from '@/lib/types';
import type { HorizonDecisionSnapshot } from '@/lib/horizon-decision-engine';
import { DerivTradeConfigFields } from './deriv-trade-config-fields';
import { initializeStakingState, applyTradeOutcome, type StakingState, type StakingStrategy, type RiskConstraints } from '@/lib/trading/staking/staking-engine';
import { waitForContractSettlement } from '@/lib/trading/settlement-waiter';
import { TickSentimentBar } from './tick-sentiment-bar';
import { MLReadinessBadge } from './ml-readiness-badge';
import { tradeStrategyStore } from '@/lib/trade-store';
import { RiskManagementConfigPanel, getDefaultRiskConfig, type DynamicRiskConfig, type LiveRiskMetrics } from './risk-management-config';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';
import { type AutoHorizonMode } from '@/lib/duration-utils';

interface AiTraderControlsProps {
  authState?: AuthState;
  onLogin?: () => void;
  proposal: ProposalInfo | null;
  stake: string;
  onStakeChange: (val: string) => void;
  direction: Direction;
  onDirectionChange: (dir: Direction) => void;
  allowEquals?: boolean;
  onAllowEqualsChange?: (val: boolean) => void;
  onBuy: (targetDir?: Direction, overrides?: { duration?: number; durationUnit?: DurationSelectUnit, stake?: number, executionPlanId?: string }) => Promise<any>;
  isBuying: boolean;
  isConnected: boolean;
  duration?: number;
  onDurationChange?: (val: number) => void;
  durationUnit?: DurationSelectUnit;
  onDurationUnitChange?: (unit: DurationSelectUnit) => void;
  durationOptions?: DurationOption[];
  isAutoDuration?: boolean;
  onAutoDurationChange?: (isAuto: boolean) => void;
  autoHorizonMode?: AutoHorizonMode;
  onAutoHorizonModeChange?: (mode: AutoHorizonMode) => void;
  endDate?: Date;
  onEndDateChange?: (date: Date | undefined) => void;
  endTime?: string;
  onEndTimeChange?: (time: string) => void;
  ws?: DerivWS | null;
  activeSymbol: ActiveSymbol | null;
  prices?: number[];
  decisionSnapshot?: HorizonDecisionSnapshot | null;
}

const NEXT_TRADE_DELAY_MS = 3500;

export interface PnLPoint {
  trade: number;
  label: string;
  pnl: number;
  cumPnL: number;
  win: boolean;
}

export function AiTraderControls({
  authState,
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
  duration = 1,
  onDurationChange,
  durationUnit = 't',
  onDurationUnitChange,
  durationOptions = [],
  isAutoDuration,
  onAutoDurationChange,
  autoHorizonMode = 'auto',
  onAutoHorizonModeChange = () => {},
  endDate,
  onEndDateChange,
  endTime,
  onEndTimeChange,
  ws,
  activeSymbol,
  prices,
  decisionSnapshot = null,
}: AiTraderControlsProps) {
  const [numTrades, setNumTrades] = useState<number>(10);
  const [strategy, setStrategy] = useState<string>('Flat Staking');
  const [sessionExecutionMode, setSessionExecutionMode] = useState<'hybrid' | 'adaptive' | 'locked'>('hybrid');
  const recoveryChainDirectionRef = useRef<Direction | null>(null);
  const recoveryChainHorizonRef = useRef<{ duration: number; unit: DurationSelectUnit } | null>(null);
  const [lastDecisionSnapshot, setLastDecisionSnapshot] = useState<HorizonDecisionSnapshot | null>(decisionSnapshot);
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

  const [riskConfig, setRiskConfig] = useState<DynamicRiskConfig>(() =>
    getDefaultRiskConfig(Number(stake) || 10)
  );

  useEffect(() => {
    if (decisionSnapshot) {
      setLastDecisionSnapshot(decisionSnapshot);
      decisionSnapshotRef.current = decisionSnapshot;
    }
  }, [decisionSnapshot]);

  const [isRunning, setIsRunning] = useState(false);
  const [currentTradeIndex, setCurrentTradeIndex] = useState(0);
  const [executionStats, setExecutionStats] = useState({ executed: 0, failed: 0 });
  const [sessionResults, setSessionResults] = useState({ wins: 0, losses: 0 });
  const [lastExecution, setLastExecution] = useState<string | null>(null);
  const [pnlHistory, setPnlHistory] = useState<PnLPoint[]>([
    { trade: 0, label: 'Start', pnl: 0, cumPnL: 0, win: true }
  ]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stakingStateRef = useRef<StakingState | null>(null);

  const stopSession = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsRunning(false);
  }, []);

  const handleResetSessionChart = () => {
    setPnlHistory([{ trade: 0, label: 'Start', pnl: 0, cumPnL: 0, win: true }]);
    setSessionResults({ wins: 0, losses: 0 });
    toast.info('Session Chart Reset', { description: 'Performance curve cleared for new trading session.' });
  };

  const executeTrade = async (sessionId: string, tradeNumber: number) => {
    if (tradeNumber > numTrades) {
      stopSession();
      toast.success('AI Session Completed', {
        description: `Successfully executed ${numTrades} trades sequentially.`,
      });
      return;
    }

    setCurrentTradeIndex(tradeNumber);

    try {
      if (!ws || !ws.isConnected) {
        throw new Error('Deriv WebSocket disconnected.');
      }

      const currentPnL = stakingStateRef.current ? stakingStateRef.current.sessionPnL : 0;
      if (riskConfig.stopLoss.enabled && currentPnL <= -Math.abs(riskConfig.stopLoss.value)) {
        stopSession();
        toast.error('AI Session Halted', { description: `Max Stop Loss limit (-$${riskConfig.stopLoss.value}) reached.` });
        return;
      }
      if (riskConfig.takeProfit.enabled && currentPnL >= riskConfig.takeProfit.value) {
        stopSession();
        toast.success('AI Session Profit Target Reached!', { description: `Take Profit limit (+$${riskConfig.takeProfit.value}) achieved.` });
        return;
      }

      tradeStrategyStore.setStrategy(`Auto (${strategy})`);

      // Every automated trade must obtain a fresh server-authoritative execution plan.
      // The client-side snapshot remains advisory only and is never used as the final
      // trading horizon source.
      const currentPrices = pricesRef.current || [];
      const currentAutoMode = autoHorizonModeRef.current;
      const currentIsAuto = isAutoDurationRef.current;
      const currentOptions = durationOptionsRef.current;
      if (currentIsAuto && (!currentOptions || currentOptions.length === 0)) {
        throw new Error('Live Deriv contract duration limits are still loading. Please ensure contract data is synchronized before executing AI trades.');
      }
      const currentSymbol = activeSymbolRef.current?.underlying_symbol || 'R_100';
      const tickObjects = currentPrices.map((price, idx) => ({
        price,
        timestamp: Date.now() - (currentPrices.length - idx) * 1000,
      }));
      const requestedDuration = durationRef.current;
      const requestedUnit = durationUnitRef.current;

      const predictionRes = await fetch('/api/signals/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: currentSymbol,
          ticks: tickObjects.length >= 25 ? tickObjects : undefined,
          durationValue: requestedDuration,
          durationUnit: requestedUnit,
          autoHorizonMode: currentAutoMode,
          durationOptions: currentOptions,
          isAutoDuration: currentIsAuto,
          mode: currentIsAuto ? (currentAutoMode !== 'auto' ? 'ai_assist' : 'auto') : 'manual',
        }),
      });

      let data: any = {};
      let rawText = '';
      try {
        rawText = await predictionRes.text();
        data = rawText ? JSON.parse(rawText) : {};
      } catch (parseErr) {
        throw new Error(
          !predictionRes.ok
            ? `Server request failed (Status ${predictionRes.status}: ${predictionRes.statusText || 'Edge Gateway Error'}). Please retry.`
            : 'Invalid JSON response received from signal service.'
        );
      }

      if (!predictionRes.ok || !data?.success) {
        const backendErrorMessage = data?.error || (rawText && rawText.length < 200 ? rawText : null);
        throw new Error(backendErrorMessage || `Failed to generate the server-authoritative AI execution plan (Status ${predictionRes.status}).`);
      }

      const executionPlan = data.executionPlan;
      if (!executionPlan?.horizonAligned || !executionPlan?.selectedHorizon || !executionPlan?.predictionHorizon) {
        throw new Error('AI execution plan is missing a validated horizon lineage.');
      }
      if (executionPlan.selectedHorizon.value !== executionPlan.predictionHorizon.value || executionPlan.selectedHorizon.unit !== executionPlan.predictionHorizon.unit) {
        throw new Error('AI execution plan horizon mismatch; trade blocked.');
      }
      if (data.strategyGate?.accepted !== true || executionPlan.strategyGateAccepted !== true) {
        throw new Error('AI strategy gate rejected the selected production horizon.');
      }
      if (typeof executionPlan.executionPlanId !== 'string' || !executionPlan.executionPlanId.trim()) {
        throw new Error('AI execution plan is missing its traceable execution plan identifier.');
      }

      if (data.decisionSnapshot) {
        setLastDecisionSnapshot(data.decisionSnapshot);
        decisionSnapshotRef.current = data.decisionSnapshot;
      }

      const decision = data.decisionSnapshot?.decision;
      const rawAiDirection: Direction = data.prediction?.signal === 'PUT' || decision?.direction === 'FALL' ? 'PUT' : 'CALL';
      const isRecoveryStep = (stakingStateRef.current?.sequenceTrades || 0) > 0;

      let effectiveDirection: Direction;
      let effectiveDuration: number;
      let effectiveUnit: DurationSelectUnit;
      let modeBadge = '';

      if (!isRecoveryStep || tradeNumber === 1) {
        // Base Trade in Sequence
        effectiveDirection = rawAiDirection;
        effectiveDuration = Number(executionPlan.selectedHorizon.value);
        effectiveUnit = executionPlan.selectedHorizon.unit as DurationSelectUnit;
        recoveryChainDirectionRef.current = effectiveDirection;
        recoveryChainHorizonRef.current = { duration: effectiveDuration, unit: effectiveUnit };
        modeBadge = '[Base]';
      } else {
        // Recovery Step (sequenceTrades > 0)
        if (sessionExecutionMode === 'locked' && recoveryChainDirectionRef.current && recoveryChainHorizonRef.current) {
          effectiveDirection = recoveryChainDirectionRef.current;
          effectiveDuration = recoveryChainHorizonRef.current.duration;
          effectiveUnit = recoveryChainHorizonRef.current.unit;
          modeBadge = `[Locked ${effectiveDirection}]`;
        } else if (sessionExecutionMode === 'adaptive') {
          effectiveDirection = rawAiDirection;
          effectiveDuration = Number(executionPlan.selectedHorizon.value);
          effectiveUnit = executionPlan.selectedHorizon.unit as DurationSelectUnit;
          modeBadge = `[Adaptive ${effectiveDirection}]`;
        } else {
          // Hybrid Mode (Default): Lock direction to avoid whipsaws, use AI dynamic horizon
          effectiveDirection = recoveryChainDirectionRef.current || rawAiDirection;
          effectiveDuration = Number(executionPlan.selectedHorizon.value);
          effectiveUnit = executionPlan.selectedHorizon.unit as DurationSelectUnit;
          modeBadge = `[Hybrid ${effectiveDirection}]`;
        }
      }

      const confidence = Number(data.prediction?.confidence ?? decision?.calibratedProbability ?? decision?.confidence ?? 0);
      const horizonLabel = executionPlan.selectedHorizon.label;

      if (onDurationChange && effectiveDuration !== durationRef.current) onDurationChange(effectiveDuration);
      if (onDurationUnitChange && effectiveUnit !== durationUnitRef.current) onDurationUnitChange(effectiveUnit);

      tradeStrategyStore.setStrategy('Horizon Decision Engine · Server Execution Plan');

      const formattedConf = (confidence > 1 ? confidence : confidence * 100).toFixed(0);

      if (!stakingStateRef.current) {
        stakingStateRef.current = initializeStakingState(Number(stake));
      }

      const currentStake = stakingStateRef.current.currentStake;
      const buyRes = await onBuy(effectiveDirection, { duration: effectiveDuration, durationUnit: effectiveUnit, stake: currentStake, executionPlanId: executionPlan.executionPlanId });

      if (!buyRes?.contractId) {
        throw new Error('Failed to retrieve contract ID from execution.');
      }

      setExecutionStats((prev) => ({ ...prev, executed: prev.executed + 1 }));
      setLastExecution(
        `Trade #${tradeNumber} (EXECUTED: ${effectiveDirection} ${modeBadge} | Conf: ${formattedConf}% | Stake: $${currentStake} | Plan: ${executionPlan.executionPlanId})`
      );
      toast.success(`AI Trade #${tradeNumber} Executed ${modeBadge}`, {
        description: `Direction: ${effectiveDirection} | Stake: $${currentStake} | Horizon: ${effectiveDuration}${effectiveUnit}`,
      });

      const settledContract = await waitForContractSettlement(ws, buyRes.contractId);

      const realizedPnL = Number(settledContract.profit);
      const isWin = realizedPnL > 0;
      const payoutRatio = (Number(settledContract.payout) - Number(settledContract.buy_price)) / Number(settledContract.buy_price);

      setSessionResults((prev) => ({
        wins: prev.wins + (isWin ? 1 : 0),
        losses: prev.losses + (isWin ? 0 : 1),
      }));

      // Record closed-loop trade attribution to feed back into HDE online prior scoring
      const symbolKey = activeSymbolRef.current?.underlying_symbol || 'R_100';
      const contractTicks = settledContract?.tick_stream ? settledContract.tick_stream.map((t) => ({ price: t.tick, timestamp: t.epoch * 1000 })) : undefined;
      const entryPriceVal = Number(settledContract?.entry_spot ?? settledContract?.barrier ?? 0);
      const exitPriceVal = Number(settledContract?.exit_spot ?? (settledContract?.tick_stream && settledContract.tick_stream.length > 0 ? settledContract.tick_stream[settledContract.tick_stream.length - 1].tick : entryPriceVal));
      
      void fetch('/api/signals/attribution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tradeId: String(settledContract?.contract_id || `TR-${Date.now()}`),
          symbol: symbolKey,
          horizonKey: `${effectiveDuration}${effectiveUnit}`,
          horizonValue: effectiveDuration,
          horizonUnit: effectiveUnit,
          direction: effectiveDirection,
          entryPrice: entryPriceVal,
          exitPrice: exitPriceVal,
          outcome: isWin ? 'WIN' : 'LOSS',
          profit: realizedPnL,
          stake: currentStake,
          intratradeTicks: contractTicks,
          executionPlanId: executionPlan.executionPlanId,
          strategyName: strategy,
        }),
      }).catch(() => {});

      setPnlHistory((prev) => {
        const tradeIndex = prev.length;
        const lastCum = prev.length > 0 ? prev[prev.length - 1].cumPnL : 0;
        const newCum = lastCum + realizedPnL;
        return [
          ...prev,
          {
            trade: tradeIndex,
            label: `#${tradeIndex}`,
            pnl: Number(realizedPnL.toFixed(2)),
            cumPnL: Number(newCum.toFixed(2)),
            win: isWin,
          },
        ];
      });

      const riskConstraints: RiskConstraints = {
        maxStake: riskConfig.maxStakeCap.enabled ? riskConfig.maxStakeCap.value : undefined,
        maxConsecutiveLosses: riskConfig.maxConsecutiveLosses.enabled ? riskConfig.maxConsecutiveLosses.value : undefined,
        maxSequenceLoss: riskConfig.maxSequenceLoss.enabled ? riskConfig.maxSequenceLoss.value : undefined,
        takeProfit: riskConfig.takeProfit.enabled ? riskConfig.takeProfit.value : undefined,
        stopLoss: riskConfig.stopLoss.enabled ? riskConfig.stopLoss.value : undefined,
      };

      const stakingDecision = applyTradeOutcome(
        strategy as StakingStrategy,
        stakingStateRef.current,
        { win: isWin, realizedPnL, payoutRatio },
        riskConstraints
      );

      stakingStateRef.current = stakingDecision.nextState;

      toast[isWin ? 'success' : 'error'](`Trade #${tradeNumber} Settled`, {
        description: `Result: ${isWin ? 'WIN' : 'LOSS'} | PnL: $${realizedPnL.toFixed(2)} | Next Stake: $${stakingStateRef.current.currentStake}`
      });

      if (stakingDecision.action === 'HALT') {
        stopSession();
        toast.error('AI Session Halted by Risk Engine', {
          description: stakingDecision.reason
        });
        return;
      }

      if (tradeNumber >= numTrades) {
        stopSession();
        toast.success('AI Session Completed', {
          description: `Successfully executed ${numTrades} trades sequentially.`,
        });
        return;
      }

      timerRef.current = setTimeout(() => {
        void executeTrade(sessionId, tradeNumber + 1);
      }, NEXT_TRADE_DELAY_MS);

    } catch (err) {
      setExecutionStats((prev) => ({ ...prev, failed: prev.failed + 1 }));
      const msg = err instanceof Error ? err.message : 'Execution error';
      toast.error(`Trade #${tradeNumber} Failed`, { description: msg });
      stopSession();
    }
  };

  const handleStartAiSession = () => {
    if (isRunning) {
      stopSession();
      toast.info('AI Automated Trading Stopped');
      return;
    }

    if (!isConnected) {
      toast.error('Cannot Start Session', { description: 'Deriv WebSocket is disconnected.' });
      return;
    }

    if (isAutoDurationRef.current && (!durationOptionsRef.current || durationOptionsRef.current.length === 0)) {
      toast.error('Contract Duration Limits Loading', {
        description: 'Waiting for live Deriv contract specifications for this asset. Please try again in a moment.',
      });
      return;
    }

    setIsRunning(true);
    setExecutionStats({ executed: 0, failed: 0 });
    setPnlHistory([{ trade: 0, label: 'Start', pnl: 0, cumPnL: 0, win: true }]);
    setSessionResults({ wins: 0, losses: 0 });

    stakingStateRef.current = initializeStakingState(Number(stake) || 10);
    const sessionId = `ai-session-${Date.now()}`;

    toast.success('AI Automated Session Started', {
      description: `Targeting ${numTrades} trades with ${strategy} strategy.`,
    });

    void executeTrade(sessionId, 1);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const chartAnalytics = useMemo(() => {
    const totalSettled = pnlHistory.length - 1;
    const currentNetPnL = pnlHistory.length > 0 ? pnlHistory[pnlHistory.length - 1].cumPnL : 0;
    let peak = 0;
    let maxDrawdown = 0;

    pnlHistory.forEach((pt) => {
      if (pt.cumPnL > peak) peak = pt.cumPnL;
      const dd = peak - pt.cumPnL;
      if (dd > maxDrawdown) maxDrawdown = dd;
    });

    const totalWins = sessionResults.wins;
    const winRate = totalSettled > 0 ? ((totalWins / totalSettled) * 100).toFixed(1) : '0.0';

    return { totalSettled, currentNetPnL, peak, maxDrawdown, winRate };
  }, [pnlHistory, sessionResults]);

  const liveMetrics: LiveRiskMetrics = {
    consecutiveLosses: stakingStateRef.current?.consecutiveLosses || 0,
    sessionPnL: stakingStateRef.current?.sessionPnL || 0,
    sequencePnL: stakingStateRef.current?.sequencePnL || 0,
    currentStake: stakingStateRef.current?.currentStake || Number(stake) || 10,
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-purple-500/20 bg-gradient-to-br from-purple-950/40 via-slate-900 to-indigo-950/40 p-3.5 space-y-3 shadow-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-300">
              <Cpu className="w-4 h-4 animate-pulse" />
            </div>
            <div>
              <div className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                AI Ensemble Execution Engine
                <Sparkles className="w-3.5 h-3.5 text-purple-400" />
              </div>
              <div className="text-[10px] text-slate-400">
                Calibrated probability &amp; multi-horizon gate
              </div>
            </div>
          </div>

          <MLReadinessBadge
            symbol={(activeSymbol as any)?.symbol || (activeSymbol as any)?.underlying_symbol}
            durationValue={duration}
            durationUnit={durationUnit}
          />
        </div>

        <TickSentimentBar prices={prices || []} />
      </div>

      <div className="rounded-2xl border border-border/80 bg-card/80 p-3 flex items-center justify-between gap-3 shadow-xs">
        <div className="flex items-center gap-2.5">
          <div className={`w-3 h-3 rounded-full ${isRunning ? 'bg-emerald-500 animate-ping' : 'bg-slate-600'}`} />
          <div>
            <div className="text-xs font-bold text-foreground">
              {isRunning ? 'AI Trading Session Active' : 'Automated Trading Engine Idle'}
            </div>
            <div className="text-[11px] text-purple-200/70 font-medium">
              {isRunning ? `Executing Trade ${currentTradeIndex}/${numTrades}...` : 'Ready for algorithmic execution'}
            </div>
          </div>
        </div>

        {isRunning && (
          <div className="text-right">
            <div className="text-[10px] text-slate-400 uppercase font-semibold tracking-wider">EXECUTION</div>
            <div className="flex items-center gap-1.5 font-mono text-xs font-bold mt-0.5">
              <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">{sessionResults.wins} Win</span>
              <span className="text-slate-500">|</span>
              <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30">{sessionResults.losses} Loss</span>
            </div>
          </div>
        )}
      </div>

      {lastExecution && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-200">
          Last submitted: <span className="font-bold">{lastExecution}</span>
        </div>
      )}

      <div className="rounded-2xl border border-indigo-500/20 bg-gradient-to-b from-slate-900/90 to-slate-950 p-3.5 space-y-3 shadow-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-300">
              <BarChart2 className="w-3.5 h-3.5" />
            </div>
            <div>
              <div className="text-xs font-bold text-slate-100 flex items-center gap-1">Real-Time Session Equity &amp; P&amp;L Curve</div>
              <div className="text-[10px] text-slate-400">Dynamic cumulative performance tracking</div>
            </div>
          </div>

          <button type="button" onClick={handleResetSessionChart} className="text-[10px] text-slate-400 hover:text-white px-2 py-1 rounded-lg bg-slate-800/80 border border-slate-700/80 flex items-center gap-1 transition-colors">
            <RefreshCw className="w-3 h-3 text-slate-400" />
            Reset Curve
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2 font-mono">
          <div className="p-2 rounded-xl bg-slate-950/60 border border-slate-800/80"><span className="text-[9px] text-slate-400 uppercase block font-medium">Session Net P&amp;L</span><span className={`text-xs font-black ${chartAnalytics.currentNetPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{chartAnalytics.currentNetPnL >= 0 ? '+' : ''}${chartAnalytics.currentNetPnL.toFixed(2)}</span></div>
          <div className="p-2 rounded-xl bg-slate-950/60 border border-slate-800/80"><span className="text-[9px] text-slate-400 uppercase block font-medium">Win Rate</span><span className="text-xs font-black text-indigo-300">{chartAnalytics.winRate}%</span></div>
          <div className="p-2 rounded-xl bg-slate-950/60 border border-slate-800/80"><span className="text-[9px] text-slate-400 uppercase block font-medium">Peak Profit</span><span className="text-xs font-black text-emerald-400">+${chartAnalytics.peak.toFixed(2)}</span></div>
          <div className="p-2 rounded-xl bg-slate-950/60 border border-slate-800/80"><span className="text-[9px] text-slate-400 uppercase block font-medium">Max Drawdown</span><span className="text-xs font-black text-amber-400">-${chartAnalytics.maxDrawdown.toFixed(2)}</span></div>
        </div>

        <div className="h-36 w-full pt-1">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={pnlHistory} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="pnlGreenGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.4} /><stop offset="95%" stopColor="#10b981" stopOpacity={0.0} /></linearGradient>
                <linearGradient id="pnlRedGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f43f5e" stopOpacity={0.4} /><stop offset="95%" stopColor="#f43f5e" stopOpacity={0.0} /></linearGradient>
              </defs>
              <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 10 }} stroke="#334155" />
              <YAxis tick={{ fill: '#64748b', fontSize: 10 }} stroke="#334155" tickFormatter={(v) => `$${v}`} />
              <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
              <Tooltip content={({ active, payload }) => {
                if (active && payload && payload.length) {
                  const dataPoint = payload[0].payload as PnLPoint;
                  return (
                    <div className="rounded-xl bg-slate-900 border border-slate-700 p-2 text-[11px] shadow-xl font-mono">
                      <div className="text-slate-400 font-bold mb-0.5">{dataPoint.label}</div>
                      <div className={dataPoint.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>Trade Result: {dataPoint.pnl >= 0 ? '+' : ''}${dataPoint.pnl.toFixed(2)}</div>
                      <div className="text-slate-200 font-bold mt-0.5 border-t border-slate-800 pt-0.5">Cumulative P&amp;L: {dataPoint.cumPnL >= 0 ? '+' : ''}${dataPoint.cumPnL.toFixed(2)}</div>
                    </div>
                  );
                }
                return null;
              }} />
              <Area type="monotone" dataKey="cumPnL" stroke={chartAnalytics.currentNetPnL >= 0 ? '#10b981' : '#f43f5e'} strokeWidth={2} fill={chartAnalytics.currentNetPnL >= 0 ? 'url(#pnlGreenGradient)' : 'url(#pnlRedGradient)'} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <DerivTradeConfigFields
        allowEquals={allowEquals}
        onAllowEqualsChange={onAllowEqualsChange}
        stake={stake}
        onStakeChange={onStakeChange}
        duration={duration}
        onDurationChange={onDurationChange || (() => {})}
        durationUnit={durationUnit}
        onDurationUnitChange={onDurationUnitChange || (() => {})}
        durationOptions={durationOptions}
        isAutoDuration={isAutoDuration}
        onAutoDurationChange={onAutoDurationChange}
        autoHorizonMode={autoHorizonMode}
        onAutoHorizonModeChange={onAutoHorizonModeChange}
        decisionSnapshot={decisionSnapshot || lastDecisionSnapshot}
        endDate={endDate}
        onEndDateChange={onEndDateChange}
        endTime={endTime}
        onEndTimeChange={onEndTimeChange}
        ws={ws}
        isConnected={isConnected}
        activeSymbol={activeSymbol}
        prices={prices}
      />

      <RiskManagementConfigPanel
        baseStake={Number(stake) || 10}
        config={riskConfig}
        onChange={setRiskConfig}
        disabled={isRunning}
        liveMetrics={liveMetrics}
      />

      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/50">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Number of trades</Label>
          <div className="flex items-center rounded-xl bg-card border border-border overflow-hidden h-10 shadow-sm">
            <button type="button" disabled={isRunning} onClick={() => setNumTrades(Math.max(1, numTrades - 1))} className="w-10 h-full flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground active:bg-muted/80 transition-colors"><Minus className="w-3.5 h-3.5" /></button>
            <span className="flex-1 text-center text-sm font-bold text-foreground">{numTrades}</span>
            <button type="button" disabled={isRunning} onClick={() => setNumTrades(numTrades + 1)} className="w-10 h-full flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground active:bg-muted/80 transition-colors"><Plus className="w-3.5 h-3.5" /></button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Staking Mode</Label>
          <Select disabled={isRunning} value={strategy} onValueChange={setStrategy}>
            <SelectTrigger className="h-10 rounded-xl bg-card border-border text-xs font-medium"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="Anti-Martingale">Anti-Martingale</SelectItem>
              <SelectItem value="Martingale">Martingale</SelectItem>
              <SelectItem value="D'Alembert">D'Alembert</SelectItem>
              <SelectItem value="Oscar's Grind">Oscar's Grind</SelectItem>
              <SelectItem value="Flat Staking">Flat Staking</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2 pt-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Recovery Sequence Mode</Label>
            <UITooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Recovery sequence info"
                  className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors p-0.5"
                >
                  <Info className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-xs p-2.5 bg-popover/95 backdrop-blur border-border/80 shadow-xl">
                Controls how consecutive recovery/Martingale steps adapt when recovering from an initial trade loss.
              </TooltipContent>
            </UITooltip>
          </div>
          <span className="text-[10px] text-primary font-mono font-medium">
            {sessionExecutionMode === 'hybrid'
              ? 'Anti-Whipsaw · Recommended'
              : sessionExecutionMode === 'adaptive'
              ? 'Full AI Dynamic'
              : 'Fixed Direction & Duration'}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {/* HYBRID BUTTON */}
          <button
            type="button"
            disabled={isRunning}
            onClick={() => setSessionExecutionMode('hybrid')}
            className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-center transition-all duration-150 ${
              sessionExecutionMode === 'hybrid'
                ? 'bg-primary/15 border-primary text-primary shadow-sm ring-1 ring-primary/40 font-bold'
                : 'bg-card border-border/80 text-muted-foreground hover:bg-muted/70 hover:text-foreground hover:border-border'
            } ${isRunning ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer active:scale-95'}`}
          >
            <div className="flex items-center gap-1 text-xs font-bold leading-tight">
              <Shuffle className="w-3.5 h-3.5" />
              <span>Hybrid ⭐</span>
            </div>
            <span className="text-[10px] font-normal opacity-80 mt-0.5">Anti-Whipsaw</span>
          </button>

          {/* ADAPTIVE BUTTON */}
          <button
            type="button"
            disabled={isRunning}
            onClick={() => setSessionExecutionMode('adaptive')}
            className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-center transition-all duration-150 ${
              sessionExecutionMode === 'adaptive'
                ? 'bg-primary/15 border-primary text-primary shadow-sm ring-1 ring-primary/40 font-bold'
                : 'bg-card border-border/80 text-muted-foreground hover:bg-muted/70 hover:text-foreground hover:border-border'
            } ${isRunning ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer active:scale-95'}`}
          >
            <div className="flex items-center gap-1 text-xs font-bold leading-tight">
              <Zap className="w-3.5 h-3.5" />
              <span>Adaptive</span>
            </div>
            <span className="text-[10px] font-normal opacity-80 mt-0.5">Full Dynamic</span>
          </button>

          {/* LOCKED BUTTON */}
          <button
            type="button"
            disabled={isRunning}
            onClick={() => setSessionExecutionMode('locked')}
            className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-center transition-all duration-150 ${
              sessionExecutionMode === 'locked'
                ? 'bg-primary/15 border-primary text-primary shadow-sm ring-1 ring-primary/40 font-bold'
                : 'bg-card border-border/80 text-muted-foreground hover:bg-muted/70 hover:text-foreground hover:border-border'
            } ${isRunning ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer active:scale-95'}`}
          >
            <div className="flex items-center gap-1 text-xs font-bold leading-tight">
              <Lock className="w-3.5 h-3.5" />
              <span>Locked</span>
            </div>
            <span className="text-[10px] font-normal opacity-80 mt-0.5">Fixed Direct</span>
          </button>
        </div>

        {/* Dynamic Mode Explainer Text */}
        <div className="text-[11px] text-muted-foreground bg-muted/30 border border-border/50 rounded-lg px-2.5 py-1.5 leading-relaxed">
          {sessionExecutionMode === 'hybrid' && (
            <p>
              <strong className="text-foreground">Hybrid Mode:</strong> Locks trade direction (<span className="text-primary font-mono">CALL/PUT</span>) during recovery steps to prevent whipsaw losses, while AI dynamically optimizes expiration duration.
            </p>
          )}
          {sessionExecutionMode === 'adaptive' && (
            <p>
              <strong className="text-foreground">Adaptive Mode:</strong> Re-evaluates both direction and duration dynamically on every recovery step based on real-time tick microstructure.
            </p>
          )}
          {sessionExecutionMode === 'locked' && (
            <p>
              <strong className="text-foreground">Locked Mode:</strong> Strictly fixes both the initial trade direction and duration for the entire Martingale recovery sequence.
            </p>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[10px] leading-relaxed text-amber-200/80">
        Auto execution obtains a fresh server-authoritative AI execution plan for every trade. The client optimizer and consensus panels are advisory; the selected server horizon is the only horizon submitted to Deriv.
      </div>

      <div className="pt-2">
        <button
          type="button"
          disabled={!isConnected || isBuying}
          onClick={handleStartAiSession}
          className={`w-full h-12 rounded-xl font-black text-sm tracking-wider uppercase flex items-center justify-center gap-2 shadow-lg transition-all duration-200 active:scale-95 ${isRunning ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-950/50' : 'bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white shadow-purple-900/30 border border-purple-400/30'}`}
        >
          {isRunning ? (
            <><Square className="w-4 h-4 fill-current" /><span>STOP AUTOMATED AI TRADING</span></>
          ) : (
            <><span>START AI AUTOMATED TRADING</span><div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center"><Play className="w-3.5 h-3.5 fill-current ml-0.5" /></div></>
          )}
        </button>
      </div>
    </div>
  );
}
