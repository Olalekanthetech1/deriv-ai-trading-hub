'use client';

import { useMemo, useState, useEffect } from 'react';
import { Sparkles, Layers } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { EndTimePicker } from '@/components/custom/end-time-picker';
import { AiAutoOptimizerPanel } from '@/components/custom/ai-auto-optimizer-panel';
import type { DerivWS, ActiveSymbol } from '@deriv/core';
import type { DurationSelectUnit, DurationOption } from '@/lib/types';
import type { AutoHorizonMode } from '@/lib/duration-utils';
import type { HorizonDecisionSnapshot } from '@/lib/horizon-decision-engine';

export interface DerivTradeConfigFieldsProps {
  allowEquals?: boolean;
  onAllowEqualsChange?: (val: boolean) => void;
  stake: string;
  onStakeChange: (val: string) => void;
  duration: number;
  onDurationChange: (val: number) => void;
  durationUnit: DurationSelectUnit;
  onDurationUnitChange: (unit: DurationSelectUnit) => void;
  durationOptions: DurationOption[];
  isAutoDuration?: boolean;
  onAutoDurationChange?: (isAuto: boolean) => void;
  autoHorizonMode?: AutoHorizonMode;
  onAutoHorizonModeChange?: (mode: AutoHorizonMode) => void;
  decisionSnapshot?: HorizonDecisionSnapshot | null;
  multiContractMultiplier?: number;
  onMultiContractMultiplierChange?: (multiplier: number) => void;
  endDate?: Date;
  onEndDateChange?: (date: Date | undefined) => void;
  endTime?: string;
  onEndTimeChange?: (time: string) => void;
  ws?: DerivWS | null;
  isConnected?: boolean;
  activeSymbol?: ActiveSymbol | null;
  prices?: number[];
  showAllowEquals?: boolean;
  showMultiContract?: boolean;
}

export function DerivTradeConfigFields({
  allowEquals = false,
  onAllowEqualsChange,
  stake,
  onStakeChange,
  duration,
  onDurationChange,
  durationUnit,
  onDurationUnitChange,
  durationOptions,
  isAutoDuration: propIsAutoDuration,
  onAutoDurationChange,
  autoHorizonMode: propAutoHorizonMode,
  onAutoHorizonModeChange,
  decisionSnapshot,
  multiContractMultiplier = 1,
  onMultiContractMultiplierChange,
  endDate,
  onEndDateChange,
  endTime = '23:59',
  onEndTimeChange,
  ws = null,
  isConnected = false,
  activeSymbol = null,
  prices,
  showAllowEquals = true,
  showMultiContract = true,
}: DerivTradeConfigFieldsProps) {
  const [internalAutoDuration, setInternalAutoDuration] = useState(false);
  const [internalAutoHorizonMode, setInternalAutoHorizonMode] = useState<AutoHorizonMode>('auto');
  const isAuto = propIsAutoDuration !== undefined ? propIsAutoDuration : internalAutoDuration;
  const autoHorizonMode = propAutoHorizonMode !== undefined ? propAutoHorizonMode : internalAutoHorizonMode;

  const setAutoHorizonMode = (mode: AutoHorizonMode) => {
    if (onAutoHorizonModeChange) {
      onAutoHorizonModeChange(mode);
    } else {
      setInternalAutoHorizonMode(mode);
    }
  };

  // The optimizer is strictly server-authoritative. No client duration option,
  // current duration, or market-price heuristic may be presented as an optimizer
  // decision when the server has not supplied a HorizonDecisionSnapshot.
  const dynamicOptimal = useMemo(() => {
    const serverHorizon = decisionSnapshot?.decision?.horizon;
    if (!serverHorizon) {
      return null;
    }

    const candidateUnits = (decisionSnapshot?.horizonRanking ?? []).map((item) => item.unit);
    const contractUnits = (durationOptions ?? []).map((opt) => opt.unit);
    const availableUnits = Array.from(
      new Set(
        [...contractUnits, ...candidateUnits, ...(serverHorizon.unit ? [serverHorizon.unit] : [])].filter(
          (u) => u === 't' || u === 's' || u === 'm' || u === 'h' || u === 'd'
        )
      )
    );

    return {
      duration: serverHorizon.value,
      unit: serverHorizon.unit,
      label: serverHorizon.label,
      explanation: decisionSnapshot?.decisionReason?.summary ?? decisionSnapshot.decision.reasons.join(' • '),
      availableUnits,
    };
  }, [decisionSnapshot]);

  // Keep parent duration and durationUnit synchronized with the authoritative server
  // horizon whenever Auto mode is active. There is intentionally no client fallback.
  useEffect(() => {
    if (isAuto && decisionSnapshot?.decision?.horizon) {
      const serverHorizon = decisionSnapshot.decision.horizon;
      if (duration !== serverHorizon.value) {
        onDurationChange(serverHorizon.value);
      }
      if (durationUnit !== serverHorizon.unit) {
        onDurationUnitChange(serverHorizon.unit);
      }
    }
  }, [isAuto, decisionSnapshot, duration, durationUnit, onDurationChange, onDurationUnitChange]);

  const handleToggleAuto = (val: boolean) => {
    if (val && decisionSnapshot?.decision?.horizon) {
      const serverHorizon = decisionSnapshot.decision.horizon;
      onDurationChange(serverHorizon.value);
      onDurationUnitChange(serverHorizon.unit);
    }
    if (onAutoDurationChange) {
      onAutoDurationChange(val);
    } else {
      setInternalAutoDuration(val);
    }
  };

  const activeOption = durationOptions.find((o) => o.unit === durationUnit);

  const endTimeOption = durationOptions.find((o) => o.unit === 'end-time');
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

  const quickStakes = ['5', '10', '25', '50'];
  const multiplierOptions = [1, 2, 3, 5];

  return (
    <div className="w-full space-y-3.5">
      {showAllowEquals && onAllowEqualsChange && (
        <div className="flex items-center justify-between py-1">
          <Label htmlFor="allow-equals-field" className="text-sm font-semibold cursor-pointer text-foreground">
            Allow equals
          </Label>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {allowEquals ? 'On' : 'Off'}
            </span>
            <Switch
              id="allow-equals-field"
              checked={allowEquals}
              onCheckedChange={onAllowEqualsChange}
            />
          </div>
        </div>
      )}

      {showMultiContract && onMultiContractMultiplierChange && (
        <div className="space-y-1.5 p-2 bg-card/60 rounded-xl border border-border/60">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              <Label className="text-xs font-bold text-foreground">Multi-Contract Batch Execution</Label>
            </div>
            <span className="text-[10px] font-bold text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20">
              {multiContractMultiplier}x Contracts
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5 pt-1">
            {multiplierOptions.map((mult) => {
              const isSelected = multiContractMultiplier === mult;
              return (
                <button
                  key={mult}
                  type="button"
                  onClick={() => onMultiContractMultiplierChange(mult)}
                  className={`py-1 text-xs font-bold rounded-lg border transition-all ${
                    isSelected
                      ? 'bg-cyan-500 text-white border-cyan-400 shadow-sm'
                      : 'bg-card text-muted-foreground border-border hover:text-foreground'
                  }`}
                >
                  {mult}x
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label className="text-xs font-semibold text-muted-foreground">Stake</Label>
        <div className="grid grid-cols-4 gap-2">
          {quickStakes.map((amt) => {
            const isSelected = stake === amt;
            return (
              <button
                key={amt}
                type="button"
                onClick={() => onStakeChange(amt)}
                className={`h-10 rounded-xl text-xs font-bold transition-all border ${
                  isSelected
                    ? 'bg-emerald-500 text-white border-emerald-400 shadow-md shadow-emerald-950/40'
                    : 'bg-card/70 text-foreground border-border/80 hover:bg-muted hover:border-border'
                }`}
              >
                {amt}
              </button>
            );
          })}
        </div>

        <div className="relative flex items-center">
          <Input
            type="number"
            value={stake}
            onChange={(e) => onStakeChange(e.target.value)}
            onKeyDown={(e) => {
              if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault();
            }}
            min={0}
            step="0.01"
            className="h-11 rounded-xl bg-card border-border pr-12 text-sm font-bold text-foreground"
          />
          <span className="absolute right-3 text-xs font-bold text-muted-foreground pointer-events-none uppercase">
            USD
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold text-muted-foreground">Duration</Label>
          <div className="flex items-center p-0.5 bg-card/90 rounded-lg border border-border/80 text-xs">
            <button
              type="button"
              onClick={() => handleToggleAuto(false)}
              className={`px-3 py-1 rounded-md font-medium transition-all text-[11px] ${
                !isAuto
                  ? 'bg-muted text-foreground font-semibold shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Manual
            </button>
            <button
              type="button"
              onClick={() => handleToggleAuto(true)}
              className={`px-3 py-1 rounded-md font-medium transition-all text-[11px] ${
                isAuto
                  ? 'bg-indigo-600 text-white font-semibold shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Auto
            </button>
          </div>
        </div>

        {isAuto ? (
          <AiAutoOptimizerPanel
            dynamicOptimal={dynamicOptimal}
            autoHorizonMode={autoHorizonMode}
            onAutoHorizonModeChange={setAutoHorizonMode}
            decisionSnapshot={decisionSnapshot}
            durationOptions={durationOptions}
            prices={prices}
          />
        ) : (
          <>
            <div className="flex items-center gap-1 overflow-x-auto p-1 bg-card/80 rounded-xl border border-border/80 no-scrollbar">
              {durationOptions.map((opt) => {
                const isSelected = durationUnit === opt.unit;
                return (
                  <button
                    key={opt.unit}
                    type="button"
                    onClick={() => onDurationUnitChange(opt.unit)}
                    className={`flex-1 min-w-[60px] py-1.5 px-2 text-[11px] font-semibold rounded-lg whitespace-nowrap transition-all text-center ${
                      isSelected
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-bold shadow-sm'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {durationUnit !== 'end-time' ? (
              <Input
                type="number"
                value={duration === 0 || isNaN(duration) ? '' : duration}
                onChange={(e) => {
                  if (e.target.value === '') {
                    onDurationChange(0);
                  } else {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val)) onDurationChange(val);
                  }
                }}
                min={activeOption?.min || 1}
                max={activeOption?.max || 10}
                step={1}
                className="h-11 rounded-xl bg-card border-border text-sm font-bold text-foreground"
              />
            ) : (
              onEndDateChange && onEndTimeChange && (
                <EndTimePicker
                  ws={ws}
                  isConnected={isConnected}
                  activeSymbol={activeSymbol}
                  endDate={endDate}
                  onEndDateChange={onEndDateChange}
                  endTime={endTime}
                  onEndTimeChange={onEndTimeChange}
                  minDate={endTimeMinDate}
                  maxDate={endTimeMaxDate}
                />
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}
