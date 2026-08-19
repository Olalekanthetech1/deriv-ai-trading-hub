'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useBuy } from '@deriv/core';
import type { DerivWS, ActiveSymbol, Tick, ProposalInfo, ProposalParams, BuyResult } from '@deriv/core';
import { useBaseTrading } from '@/hooks/use-base-trading';
import type { UseBaseTradingParams } from '@/hooks/use-base-trading';
import type { Direction, DurationSelectUnit, DurationOption, OpenPosition, ClosedPosition } from '../lib/types';
import { getDurationOptions, computeEndTimeEpoch, type AutoHorizonMode } from '@/lib/duration-utils';
import { ProposalSubmissionManager } from '@/lib/proposal-submission-manager';
import { useRealtimeSignals } from '@/hooks/use-realtime-signals';

const CONTRACT_TYPES = ['CALL', 'PUT'];

export interface BuyExecutionOverrides {
  duration?: number;
  durationUnit?: DurationSelectUnit;
  stake?: number;
  executionPlanId?: string;
}

interface UseRiseFallTradingReturn {
  ws: DerivWS | null;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  symbols: ActiveSymbol[];
  activeSymbol: ActiveSymbol | null;
  selectSymbol: (symbol: string) => void;
  currentTick: Tick | null;
  prices: number[];
  pipSize: number;
  direction: Direction;
  setDirection: (direction: Direction) => void;
  allowEquals: boolean;
  setAllowEquals: (value: boolean) => void;
  stake: string;
  setStake: (value: string) => void;
  duration: number;
  setDuration: (value: number) => void;
  durationOptions: DurationOption[];
  durationUnit: DurationSelectUnit;
  setDurationUnit: (unit: DurationSelectUnit) => void;
  endDate: Date | undefined;
  setEndDate: (date: Date | undefined) => void;
  endTime: string;
  setEndTime: (time: string) => void;
  proposal: ProposalInfo | null;
  buyContract: (targetDir?: Direction, overrides?: BuyExecutionOverrides) => Promise<any>;
  buyWithCustomParams: (params: { direction: Direction; duration: number; durationUnit: DurationSelectUnit; executionPlanId?: string }) => Promise<any>;
  isBuying: boolean;
  buyResult: BuyResult | null;
  buyError: string | null;
  clearBuyResult: () => void;
  openPositions: OpenPosition[];
  closedPositions: ClosedPosition[];
  sellContract: (contractId: number, bidPrice: string) => Promise<void>;
  sellingId: number | null;
  sellError: string | null;
  clearSellError: () => void;
  // Optimizer config & state
  isAutoDuration: boolean;
  setIsAutoDuration: (value: boolean) => void;
  autoHorizonMode: AutoHorizonMode;
  setAutoHorizonMode: (mode: AutoHorizonMode) => void;
  realtimeSignals: ReturnType<typeof useRealtimeSignals>;
}

export type UseRiseFallTradingParams = Pick<UseBaseTradingParams, 'ws' | 'isConnected' | 'isExhausted' | 'isAuthenticated' | 'onAuthWSFailed'>;

export function useRiseFallTrading({ ws, isConnected, isExhausted, isAuthenticated, onAuthWSFailed }: UseRiseFallTradingParams): UseRiseFallTradingReturn {
  const {
    ws: tradingWs,
    isConnected: tradingIsConnected,
    isLoading,
    error,
    symbols,
    activeSymbol,
    selectSymbol,
    currentTick,
    prices,
    pipSize,
    contracts,
    openPositions,
    closedPositions,
    sellContract,
    sellingId,
    sellError,
    clearSellError,
  } = useBaseTrading({ ws, isConnected, isExhausted, isAuthenticated, onAuthWSFailed, contractTypes: CONTRACT_TYPES });

  const [direction, setDirection] = useState<Direction>('CALL');
  const [allowEquals, setAllowEquals] = useState(false);
  const [stake, setStake] = useState('10');
  const [duration, setDuration] = useState(1);
  const [durationUnit, setDurationUnitRaw] = useState<DurationSelectUnit>('t');
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);
  const [endTime, setEndTime] = useState('');
  const [proposal, setProposal] = useState<ProposalInfo | null>(null);
  const [durationOptionsSymbol, setDurationOptionsSymbol] = useState<string | null>(null);

  const [isAutoDuration, setIsAutoDuration] = useState(false);
  const [autoHorizonMode, setAutoHorizonMode] = useState<AutoHorizonMode>('auto');

  const durationOptions = useMemo(() => getDurationOptions(contracts), [contracts]);

  const realtimeSignals = useRealtimeSignals(
    activeSymbol,
    currentTick,
    prices,
    duration,
    durationUnit,
    autoHorizonMode,
    durationOptions,
    isAutoDuration
  );

  const proposalManager = useMemo(() => (tradingWs ? new ProposalSubmissionManager(tradingWs) : null), [tradingWs]);

  const durationUnitRef = useRef(durationUnit);
  const activeSymbolKeyRef = useRef(activeSymbol?.underlying_symbol);

  useEffect(() => {
    durationUnitRef.current = durationUnit;
  }, [durationUnit]);

  useEffect(() => {
    activeSymbolKeyRef.current = activeSymbol?.underlying_symbol;
  }, [activeSymbol?.underlying_symbol]);

  /* eslint-disable react-hooks/set-state-in-effect -- reset duration/end-time state when contract limits change */
  useEffect(() => {
    if (!durationOptions.length) return;
    setEndDate(undefined);
    setEndTime('');
    setDurationOptionsSymbol(activeSymbolKeyRef.current ?? null);
    const currentOpt = durationOptions.find(o => o.unit === durationUnitRef.current);
    if (!currentOpt) {
      const first = durationOptions[0];
      setDurationUnitRaw(first.unit);
      if (first.unit !== 'end-time') setDuration(first.min);
    } else if (currentOpt.unit !== 'end-time') {
      setDuration(prev => (prev < currentOpt.min || prev > currentOpt.max) ? currentOpt.min : prev);
    }
  }, [durationOptions]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const setDurationUnit = useCallback((unit: DurationSelectUnit) => {
    setDurationUnitRaw(unit);
    const opt = durationOptions.find(o => o.unit === unit);
    if (opt && unit !== 'end-time') setDuration(opt.min);
  }, [durationOptions]);

  const buildProposalParams = useCallback((dir: Direction, customDuration = duration, customUnit = durationUnit, overrideStake?: number): ProposalParams | null => {
    if (!activeSymbol || !durationOptions.length || durationOptionsSymbol !== activeSymbol.underlying_symbol) return null;
    const stakeNum = overrideStake ?? parseFloat(stake);
    if (!stakeNum || stakeNum <= 0) return null;

    const base = {
      contractType: allowEquals ? (dir === 'CALL' ? 'CALLE' : 'PUTE') : dir,
      symbol: activeSymbol.underlying_symbol,
      amount: stakeNum,
      basis: 'stake' as const,
      currency: 'USD',
    };

    if (customUnit === 'end-time') {
      const dateExpiry = computeEndTimeEpoch(endDate, endTime);
      if (!dateExpiry) return null;
      return { ...base, duration: 0, durationUnit: 'd', dateExpiry };
    }

    const opt = durationOptions.find(o => o.unit === customUnit);
    if (!opt || customDuration < opt.min || customDuration > opt.max) return null;
    if (customUnit === 'h') return { ...base, duration: customDuration * 60, durationUnit: 'm' };
    return { ...base, duration: customDuration, durationUnit: customUnit };
  }, [activeSymbol, durationOptions, durationOptionsSymbol, stake, allowEquals, duration, durationUnit, endDate, endTime]);

  // A one-shot proposal is fetched for the selected direction. This removes
  // the two background useProposal subscriptions that were colliding with
  // each other and causing Deriv's AlreadySubscribed response.
  useEffect(() => {
    let cancelled = false;
    const manager = proposalManager;
    const params = buildProposalParams(direction);

    setProposal(null);
    if (!manager || !tradingIsConnected || !params) return;

    manager.getProposal(params)
      .then(result => {
        if (!cancelled) setProposal(result);
      })
      .catch(err => {
        if (!cancelled) console.error('[ProposalManager] proposal request failed:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [proposalManager, tradingIsConnected, direction, buildProposalParams]);

  useEffect(() => {
    return () => proposalManager?.clear();
  }, [proposalManager]);

  const { buyContract: buyWithProposal, isBuying, buyResult, buyError, clearBuyResult } = useBuy(tradingWs, tradingIsConnected);

  const buyContract = useCallback(async (targetDir?: Direction, overrides?: BuyExecutionOverrides) => {
    const dir = targetDir || direction;
    const proposalDuration = overrides?.duration ?? duration;
    const proposalUnit = overrides?.durationUnit ?? durationUnit;
    const executionStake = overrides?.stake ?? parseFloat(stake);
    const params = buildProposalParams(dir, proposalDuration, proposalUnit, overrides?.stake);

    if (!params || !proposalManager || !tradingIsConnected || !tradingWs) {
      throw new Error('Trading parameters are not ready. Please wait for the market connection.');
    }

    const startTime = performance.now();
    const targetProposal = await proposalManager.getProposal(params);
    if (!targetProposal) {
      throw new Error('Deriv did not return a valid proposal for this contract.');
    }

    const response = await tradingWs.send<any>({
      buy: targetProposal.id,
      price: String(targetProposal.askPrice),
    });

    if (!response.buy?.contract_id) {
      throw new Error('Deriv accepted the buy request without returning a contract ID.');
    }

    const result = {
      contractId: response.buy.contract_id,
      buyPrice: response.buy.buy_price,
      payout: response.buy.payout,
      longcode: response.buy.longcode,
      balanceAfter: response.buy.balance_after,
    };

    const latencyMs = Math.round(performance.now() - startTime);

    // Persist trade execution telemetry asynchronously
    void fetch('/api/trades/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: activeSymbol?.underlying_symbol || 'UNKNOWN',
        contract_type: params.contractType,
        stake: String(executionStake),
        buy_price: targetProposal.askPrice,
        status: 'EXECUTED',
        strategy: 'Horizon Decision Engine',
        target_horizon: `${proposalDuration}${proposalUnit}`,
        executed_duration: `${proposalDuration}${proposalUnit}`,
        proposal_latency_ms: latencyMs,
        execution_plan_id: overrides?.executionPlanId ?? null,
      }),
    }).catch((err) => console.warn('[Trade Telemetry Log Error]:', err));

    return result;
  }, [direction, duration, durationUnit, buildProposalParams, proposalManager, tradingIsConnected, tradingWs, activeSymbol, stake]);

  const buyWithCustomParams = useCallback(async (params: { direction: Direction; duration: number; durationUnit: DurationSelectUnit; executionPlanId?: string }) => {
    if (!tradingWs || !tradingIsConnected || !activeSymbol || !proposalManager) {
      throw new Error('Trading connection is not ready. Please wait for the market connection.');
    }
    if (!parseFloat(stake) || parseFloat(stake) <= 0) {
      throw new Error('Enter a valid stake before executing the signal.');
    }

    const proposalParams = buildProposalParams(params.direction, params.duration, params.durationUnit);
    if (!proposalParams) {
      throw new Error(`Unable to build a valid ${params.duration}${params.durationUnit} ${params.direction} contract proposal.`);
    }

    const startTime = performance.now();
    const targetProposal = await proposalManager.getProposal(proposalParams);
    if (!targetProposal) {
      throw new Error('Deriv did not return a valid proposal for this signal.');
    }

    const response = await tradingWs.send<any>({
      buy: targetProposal.id,
      price: String(targetProposal.askPrice),
    });

    if (!response.buy?.contract_id) {
      throw new Error('Deriv accepted the buy request without returning a contract ID.');
    }

    const result = {
      contractId: response.buy.contract_id,
      buyPrice: response.buy.buy_price,
      payout: response.buy.payout,
      longcode: response.buy.longcode,
      balanceAfter: response.buy.balance_after,
    };

    const latencyMs = Math.round(performance.now() - startTime);

    void fetch('/api/trades/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: activeSymbol?.underlying_symbol || 'UNKNOWN',
        contract_type: proposalParams.contractType,
        stake: stake,
        buy_price: targetProposal.askPrice,
        status: 'EXECUTED',
        strategy: 'AI Signal Execution',
        target_horizon: `${params.duration}${params.durationUnit}`,
        executed_duration: `${params.duration}${params.durationUnit}`,
        proposal_latency_ms: latencyMs,
        execution_plan_id: params.executionPlanId ?? null,
      }),
    }).catch((err) => console.warn('[Trade Telemetry Log Error]:', err));

    setDirection(params.direction);
    setDurationUnit(params.durationUnit);
    setDuration(params.duration);
    return result;
  }, [tradingWs, tradingIsConnected, activeSymbol, proposalManager, stake, buildProposalParams, setDurationUnit]);

  return {
    ws: tradingWs,
    isConnected: tradingIsConnected,
    isLoading,
    error,
    symbols,
    activeSymbol,
    selectSymbol,
    currentTick,
    prices,
    pipSize,
    direction,
    setDirection,
    allowEquals,
    setAllowEquals,
    stake,
    setStake,
    duration,
    setDuration,
    durationOptions,
    durationUnit,
    setDurationUnit,
    endDate,
    setEndDate,
    endTime,
    setEndTime,
    proposal,
    buyContract,
    buyWithCustomParams,
    isBuying,
    buyResult,
    buyError,
    clearBuyResult,
    openPositions,
    closedPositions,
    sellContract,
    sellingId,
    sellError,
    clearSellError,
    isAutoDuration,
    setIsAutoDuration,
    autoHorizonMode,
    setAutoHorizonMode,
    realtimeSignals,
  };
}
