'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EndTimePicker } from '@/components/custom/end-time-picker';
import { AiAutoOptimizerPanel } from '@/components/custom/ai-auto-optimizer-panel';
import type { DerivWS, ActiveSymbol, ProposalInfo, BuyResult } from '@deriv/core';
import type { Direction, DurationSelectUnit, DurationOption } from '../lib/types';
import { formatDurationLabel } from '@/lib/duration-formatter';
import type { AutoHorizonMode } from '../lib/duration-utils';
import type { HorizonDecisionSnapshot } from '@/lib/horizon-decision-engine';

interface TradeControlsProps {
  direction: Direction;
  onDirectionChange: (direction: Direction) => void;
  allowEquals: boolean;
  onAllowEqualsChange: (value: boolean) => void;
  isConnected: boolean;
  stake: string;
  onStakeChange: (value: string) => void;
  duration: number;
  onDurationChange: (value: number) => void;
  durationOptions: DurationOption[];
  durationUnit: DurationSelectUnit;
  onDurationUnitChange: (unit: DurationSelectUnit) => void;
  endDate: Date | undefined;
  onEndDateChange: (date: Date | undefined) => void;
  endTime: string;
  onEndTimeChange: (time: string) => void;
  ws: DerivWS | null;
  activeSymbol: ActiveSymbol | null;
  proposal: ProposalInfo | null;
  prices?: number[];
  decisionSnapshot?: HorizonDecisionSnapshot | null;
  isAutoDuration?: boolean;
  onIsAutoDurationChange?: (val: boolean) => void;
  autoHorizonMode?: AutoHorizonMode;
  onAutoHorizonModeChange?: (mode: AutoHorizonMode) => void;

  onBuy: () => void;
  isBuying: boolean;
  buyResult: BuyResult | null;
  buyError: string | null;
  onClearBuyResult: () => void;
  isAuthenticated?: boolean;
  onLogin?: () => void;
  onOpenPositions?: () => void;
}

export function TradeControls({
  direction,
  onDirectionChange,
  allowEquals,
  onAllowEqualsChange,
  isConnected,
  stake,
  onStakeChange,
  duration,
  onDurationChange,
  durationOptions,
  durationUnit,
  onDurationUnitChange,
  endDate,
  onEndDateChange,
  endTime,
  onEndTimeChange,
  ws,
  activeSymbol,
  proposal,
  prices,
  decisionSnapshot = null,
  isAutoDuration: isAutoDurationProp,
  onIsAutoDurationChange,
  autoHorizonMode: autoHorizonModeProp,
  onAutoHorizonModeChange,
  onBuy,
  isBuying,
  buyResult,
  buyError,
  onClearBuyResult,
  isAuthenticated,
  onLogin,
  onOpenPositions,
}: TradeControlsProps) {
  useEffect(() => {
    if (buyError) {
      toast.error('Purchase Failed', { description: buyError });
      onClearBuyResult();
    }
  }, [buyError, onClearBuyResult]);

  useEffect(() => {
    if (buyResult) {
      const durationStr = formatDurationLabel(duration, durationUnit);
      toast.success(`Contract Purchased (${durationStr})`, {
        description: `Duration: ${durationStr} | Stake: ${buyResult.buyPrice.toFixed(2)} USD | Payout: ${buyResult.payout.toFixed(2)} USD | Balance: ${buyResult.balanceAfter.toFixed(2)} USD`,
      });
      onClearBuyResult();
    }
  }, [buyResult, onClearBuyResult, duration, durationUnit]);

  const isAuto = isAutoDurationProp !== undefined ? isAutoDurationProp : false;
  const autoHorizonMode = autoHorizonModeProp !== undefined ? autoHorizonModeProp : 'auto';

  // The optimizer display is a projection of the latest server decision only.
  // No client-side horizon calculation is performed here.
  const dynamicOptimal = useMemo(() => {
    const horizon = decisionSnapshot?.decision?.horizon;
    if (!horizon) return null;

    const availableUnits = Array.from(new Set([
      ...(decisionSnapshot?.horizonRanking ?? []).map((item) => item.unit),
      horizon.unit,
    ]));

    return {
      duration: horizon.value,
      unit: horizon.unit,
      label: horizon.label || formatDurationLabel(horizon.value, horizon.unit),
      explanation: decisionSnapshot.decisionReason?.summary || 'Server Horizon Decision Engine',
      availableUnits,
    };
  }, [decisionSnapshot]);

  const setIsAuto = (val: boolean) => {
    if (val && dynamicOptimal) {
      if (duration !== dynamicOptimal.duration) onDurationChange(dynamicOptimal.duration);
      if (durationUnit !== dynamicOptimal.unit) onDurationUnitChange(dynamicOptimal.unit);
    }
    onIsAutoDurationChange?.(val);
  };

  const setHorizonMode = (mode: AutoHorizonMode) => {
    onAutoHorizonModeChange?.(mode);
  };

  useEffect(() => {
    if (isAuto && dynamicOptimal) {
      if (duration !== dynamicOptimal.duration) onDurationChange(dynamicOptimal.duration);
      if (durationUnit !== dynamicOptimal.unit) onDurationUnitChange(dynamicOptimal.unit);
    }
  }, [isAuto, dynamicOptimal, duration, durationUnit, onDurationChange, onDurationUnitChange]);

  const activeOption = durationOptions.find(o => o.unit === durationUnit);
  const endTimeOption = durationOptions.find(o => o.unit === 'end-time');
  const { endTimeMinDate, endTimeMaxDate } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return {
      endTimeMinDate: today,
      endTimeMaxDate: endTimeOption
        ? new Date(today.getTime() + endTimeOption.max * 86400000)
        : new Date(today.getTime() + 365 * 86400000),
    };
  }, [endTimeOption]);

  return (
    <div className="w-full space-y-2 lg:max-w-[400px] lg:space-y-4">
      <ToggleGroup
        type="single"
        value={direction}
        onValueChange={(value) => {
          if (value === 'CALL' || value === 'PUT') onDirectionChange(value);
        }}
        className="w-full gap-0 rounded-full bg-muted p-1"
      >
        <ToggleGroupItem value="CALL" className="flex-1 rounded-full text-sm font-medium text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-green-600 data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">Rise</ToggleGroupItem>
        <ToggleGroupItem value="PUT" className="flex-1 rounded-full text-sm font-medium text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-destructive data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">Fall</ToggleGroupItem>
      </ToggleGroup>

      <div className="flex items-center justify-between">
        <Label htmlFor="allow-equals" className="text-sm cursor-pointer">Allow equals</Label>
        <Switch id="allow-equals" checked={allowEquals} onCheckedChange={onAllowEqualsChange} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="stake" className="text-xs text-muted-foreground">Stake</Label>
        <Input id="stake" type="number" value={stake} onChange={(e) => onStakeChange(e.target.value)} onKeyDown={(e) => { if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault(); }} min={0} step="0.01" labelRight="USD" />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground font-semibold">Duration</Label>
          <div className="flex items-center p-0.5 bg-card/90 rounded-lg border border-border/80 text-xs">
            <button type="button" onClick={() => setIsAuto(false)} className={`px-3 py-1 rounded-md font-medium transition-all text-[11px] ${!isAuto ? 'bg-muted text-foreground font-semibold shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Manual</button>
            <button type="button" onClick={() => setIsAuto(true)} className={`px-3 py-1 rounded-md font-medium transition-all text-[11px] ${isAuto ? 'bg-indigo-600 text-white font-semibold shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Auto</button>
          </div>
        </div>

        {isAuto ? (
          dynamicOptimal ? (
            <AiAutoOptimizerPanel
              dynamicOptimal={dynamicOptimal}
              autoHorizonMode={autoHorizonMode}
              onAutoHorizonModeChange={setHorizonMode}
              decisionSnapshot={decisionSnapshot}
              prices={prices}
            />
          ) : (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-center text-xs text-amber-300">
              Waiting for the server Horizon Decision Engine…
            </div>
          )
        ) : (
          <>
            <Select value={durationUnit} onValueChange={(v) => { const opt = durationOptions.find(o => o.unit === v); if (opt) onDurationUnitChange(opt.unit); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{durationOptions.map(opt => <SelectItem key={opt.unit} value={opt.unit}>{opt.label}</SelectItem>)}</SelectContent>
            </Select>

            {durationUnit !== 'end-time' && (
              <Input type="number" value={duration === 0 || isNaN(duration) ? '' : duration} onChange={(e) => { if (e.target.value === '') onDurationChange(0); else { const val = parseInt(e.target.value, 10); if (!isNaN(val)) onDurationChange(val); } }} min={activeOption?.min} max={activeOption?.max} step={1} />
            )}

            {durationUnit === 'end-time' && (
              <EndTimePicker ws={ws} isConnected={isConnected} activeSymbol={activeSymbol} endDate={endDate} onEndDateChange={onEndDateChange} endTime={endTime} onEndTimeChange={onEndTimeChange} minDate={endTimeMinDate} maxDate={endTimeMaxDate} />
            )}
          </>
        )}
      </div>

      <div className="max-lg:fixed max-lg:bottom-[calc(env(safe-area-inset-bottom)+2.5rem)] max-lg:left-3 max-lg:right-3 lg:static">
        <Button
          className="w-full rounded-full bg-primary hover:bg-primary/90 text-primary-foreground"
          size="lg"
          disabled={isAuthenticated && (!isConnected || !proposal || isBuying)}
          onClick={() => {
            if (!isAuthenticated) {
              toast.error('Authentication Required', { description: 'Please log in to your Deriv account to execute trades.' });
              return;
            }
            if (isAuto) {
              if (!dynamicOptimal) {
                toast.error('Auto Duration Unavailable', { description: 'Waiting for a server-authoritative horizon decision. Trade blocked.' });
                return;
              }
              onDurationChange(dynamicOptimal.duration);
              onDurationUnitChange(dynamicOptimal.unit);
            }
            import('@/lib/trade-store').then(m => m.tradeStrategyStore.setStrategy('Manual'));
            onBuy();
          }}
        >
          {isBuying ? 'Purchasing...' : !isAuthenticated ? 'Log In to Trade' : (
            <span className="flex flex-col items-center leading-tight gap-0.5">
              <span>Buy</span>
              {proposal && <span className="text-xs font-normal opacity-90">Payout {proposal.payout.toFixed(2)} USD</span>}
            </span>
          )}
        </Button>
      </div>

      {isAuthenticated && (
        <Button type="button" variant="ghost" onClick={onOpenPositions} className="w-full text-sm text-muted-foreground hover:text-foreground">View your positions →</Button>
      )}
    </div>
  );
}
