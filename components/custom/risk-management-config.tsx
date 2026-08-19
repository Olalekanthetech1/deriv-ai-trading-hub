'use client';

import { useState, useEffect, useCallback } from 'react';
import { Shield, ShieldAlert, Sliders, RotateCcw, ChevronDown, ChevronUp, AlertCircle, DollarSign, Target, TrendingDown } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';

export interface RiskRuleConfig {
  enabled: boolean;
  value: number;
}

export interface DynamicRiskConfig {
  maxConsecutiveLosses: RiskRuleConfig;
  maxStakeCap: RiskRuleConfig;
  maxSequenceLoss: RiskRuleConfig;
  takeProfit: RiskRuleConfig;
  stopLoss: RiskRuleConfig;
}

export interface LiveRiskMetrics {
  consecutiveLosses: number;
  sessionPnL: number;
  sequencePnL: number;
  currentStake: number;
}

interface RiskManagementConfigProps {
  baseStake: number;
  config: DynamicRiskConfig;
  onChange: (newConfig: DynamicRiskConfig) => void;
  disabled?: boolean;
  liveMetrics?: LiveRiskMetrics;
}

const STORAGE_KEY = 'deriv_ai_trader_risk_config_v3';

export function getDefaultRiskConfig(baseStake: number): DynamicRiskConfig {
  const stake = Math.max(0.35, baseStake || 10);
  return {
    maxConsecutiveLosses: { enabled: true, value: 5 },
    maxStakeCap: { enabled: true, value: Math.round(stake * 10 * 100) / 100 },
    maxSequenceLoss: { enabled: true, value: Math.round(stake * 20 * 100) / 100 },
    takeProfit: { enabled: true, value: Math.round(stake * 5 * 100) / 100 },
    stopLoss: { enabled: true, value: Math.round(stake * 3 * 100) / 100 },
  };
}

export function parseSavedRiskConfig(savedJson: string, baseStake: number): DynamicRiskConfig {
  const defaults = getDefaultRiskConfig(baseStake);
  try {
    const parsed = JSON.parse(savedJson);
    const parseRule = (raw: any, defaultVal: RiskRuleConfig): RiskRuleConfig => {
      if (typeof raw === 'object' && raw !== null) {
        return {
          enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaultVal.enabled,
          value: typeof raw.value === 'number' && !isNaN(raw.value) && raw.value >= 0 ? raw.value : defaultVal.value,
        };
      } else if (typeof raw === 'number' && !isNaN(raw)) {
        return {
          enabled: raw > 0,
          value: raw > 0 ? raw : defaultVal.value,
        };
      }
      return defaultVal;
    };

    return {
      maxConsecutiveLosses: parseRule(parsed.maxConsecutiveLosses, defaults.maxConsecutiveLosses),
      maxStakeCap: parseRule(parsed.maxStakeCap, defaults.maxStakeCap),
      maxSequenceLoss: parseRule(parsed.maxSequenceLoss, defaults.maxSequenceLoss),
      takeProfit: parseRule(parsed.takeProfit, defaults.takeProfit),
      stopLoss: parseRule(parsed.stopLoss, defaults.stopLoss),
    };
  } catch (e) {
    return defaults;
  }
}

interface RiskRuleBoxProps {
  label: string;
  icon: React.ReactNode;
  rule: RiskRuleConfig;
  onRuleChange: (updated: RiskRuleConfig) => void;
  disabled?: boolean;
  min?: number;
  step?: number;
  unitPrefix?: string;
  unitSuffix?: string;
  presets?: { label: string; value: number }[];
  accentColor?: 'amber' | 'indigo' | 'emerald' | 'rose' | 'purple';
  description?: string;
  currentValue?: number;
}

function RiskRuleBox({
  label,
  icon,
  rule,
  onRuleChange,
  disabled = false,
  min = 0,
  step = 1,
  unitPrefix = '',
  unitSuffix = '',
  presets,
  accentColor = 'indigo',
  description,
  currentValue,
}: RiskRuleBoxProps) {
  const [textVal, setTextVal] = useState<string>(rule.value.toString());

  useEffect(() => {
    setTextVal(rule.value.toString());
  }, [rule.value]);

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setTextVal(raw);
    if (raw.trim() !== '') {
      const num = parseFloat(raw);
      if (!isNaN(num) && num >= 0) {
        onRuleChange({ ...rule, value: Math.round(num * 100) / 100 });
      }
    }
  };

  const handleBlur = () => {
    if (textVal.trim() === '' || isNaN(parseFloat(textVal))) {
      setTextVal(rule.value.toString());
    } else {
      const parsed = Math.round(parseFloat(textVal) * 100) / 100;
      onRuleChange({ ...rule, value: parsed });
      setTextVal(parsed.toString());
    }
  };

  const toggleEnabled = (enabled: boolean) => {
    onRuleChange({ ...rule, enabled });
  };

  // Calculate live utilization bar
  let progressPercent = 0;
  let progressText = '';
  if (rule.enabled && typeof currentValue === 'number') {
    if (label.includes('Consecutive Losses')) {
      progressPercent = Math.min(100, Math.max(0, (currentValue / (rule.value || 1)) * 100));
      progressText = `${currentValue} / ${rule.value} losses`;
    } else if (label.includes('Take-Profit')) {
      const profit = Math.max(0, currentValue);
      progressPercent = Math.min(100, Math.max(0, (profit / (rule.value || 1)) * 100));
      progressText = `+$${profit.toFixed(2)} / +$${rule.value.toFixed(2)}`;
    } else if (label.includes('Stop-Loss')) {
      const loss = Math.abs(Math.min(0, currentValue));
      progressPercent = Math.min(100, Math.max(0, (loss / (rule.value || 1)) * 100));
      progressText = `-$${loss.toFixed(2)} / -$${rule.value.toFixed(2)}`;
    } else if (label.includes('Sequence Drawdown')) {
      const seqLoss = Math.abs(Math.min(0, currentValue));
      progressPercent = Math.min(100, Math.max(0, (seqLoss / (rule.value || 1)) * 100));
      progressText = `-$${seqLoss.toFixed(2)} / -$${rule.value.toFixed(2)}`;
    }
  }

  return (
    <div
      className={`space-y-2 rounded-xl border p-3 transition-all ${
        !rule.enabled
          ? 'bg-slate-950/40 border-slate-800/80'
          : 'bg-slate-900/90 border-slate-700/60 shadow-sm'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5 cursor-pointer">
          {icon}
          <span>{label}</span>
        </Label>
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${
              rule.enabled
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                : 'bg-slate-900 text-slate-500 border border-slate-800'
            }`}
          >
            {rule.enabled ? `${unitPrefix}${rule.value}${unitSuffix}` : 'OFF'}
          </span>
          <Switch
            checked={rule.enabled}
            onCheckedChange={toggleEnabled}
            disabled={disabled}
            className="data-[state=checked]:bg-indigo-600"
          />
        </div>
      </div>

      <div className="relative flex items-center">
        {unitPrefix && rule.enabled && (
          <span className="absolute left-2.5 text-xs font-mono text-slate-400 select-none">
            {unitPrefix}
          </span>
        )}
        <Input
          type="number"
          disabled={disabled || !rule.enabled}
          min={min}
          step={step}
          value={rule.enabled ? textVal : ''}
          placeholder={rule.enabled ? 'Enter limit value' : 'Rule Inactive (OFF)'}
          onChange={handleTextChange}
          onBlur={handleBlur}
          className={`h-8 text-xs font-mono transition-colors ${
            unitPrefix && rule.enabled ? 'pl-6' : 'pl-2.5'
          } ${
            !rule.enabled
              ? 'bg-slate-950/80 border-slate-800/80 text-slate-600 placeholder:text-slate-600 cursor-not-allowed'
              : 'bg-slate-950 border-slate-700 text-white focus:border-indigo-500'
          }`}
        />
      </div>

      {presets && presets.length > 0 && (
        <div className="flex items-center gap-1 pt-0.5 flex-wrap">
          {presets.map((p) => {
            const isSelected = rule.enabled && Math.abs(rule.value - p.value) < 0.01;
            return (
              <button
                key={p.label}
                type="button"
                disabled={disabled || !rule.enabled}
                onClick={() => {
                  onRuleChange({ ...rule, value: p.value, enabled: true });
                  setTextVal(p.value.toString());
                }}
                className={`px-2 py-0.5 text-[10px] rounded font-mono transition-colors ${
                  !rule.enabled
                    ? 'bg-slate-900 text-slate-600 border border-slate-800/50 cursor-not-allowed'
                    : isSelected
                    ? 'bg-indigo-500 text-white font-bold shadow-sm'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700/50'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}

      {rule.enabled && typeof currentValue === 'number' && (
        <div className="pt-1 space-y-1">
          <div className="flex justify-between items-center text-[10px] font-mono text-slate-400">
            <span>Circuit Utilization</span>
            <span className="font-semibold text-slate-300">{progressText}</span>
          </div>
          <div className="w-full h-1.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
            <div
              className={`h-full transition-all duration-300 ${
                accentColor === 'emerald'
                  ? 'bg-emerald-500'
                  : accentColor === 'rose'
                  ? 'bg-rose-500'
                  : accentColor === 'amber'
                  ? 'bg-amber-500'
                  : accentColor === 'purple'
                  ? 'bg-purple-500'
                  : 'bg-indigo-500'
              }`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {description && (
        <p className="text-[10px] text-slate-400 leading-tight pt-0.5">
          {description}
        </p>
      )}
    </div>
  );
}

export function RiskManagementConfigPanel({
  baseStake,
  config,
  onChange,
  disabled = false,
  liveMetrics,
}: RiskManagementConfigProps) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const loaded = parseSavedRiskConfig(saved, baseStake);
        onChange(loaded);
      }
    } catch (e) {
      // ignore parsing error
    }
  }, []);

  const updateRule = useCallback(
    (field: keyof DynamicRiskConfig, updatedRule: RiskRuleConfig) => {
      const updatedConfig = {
        ...config,
        [field]: updatedRule,
      };
      onChange(updatedConfig);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedConfig));
      } catch (e) {}
    },
    [config, onChange]
  );

  const handleResetDefaults = () => {
    const defaults = getDefaultRiskConfig(baseStake);
    onChange(defaults);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
    } catch (e) {}
    toast.success('Risk Controls Reset', {
      description: `Reset parameters dynamically relative to $${baseStake.toFixed(2)} base stake.`,
    });
  };

  return (
    <div className="w-full rounded-2xl border border-indigo-500/30 bg-gradient-to-b from-indigo-950/40 via-slate-900/60 to-purple-950/30 p-3 shadow-md space-y-3">
      {/* Header / Summary Bar */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between cursor-pointer select-none group"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-300 group-hover:scale-105 transition-transform">
            <Shield className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <div className="text-xs font-bold text-white flex items-center gap-1.5">
              Risk Management & Safety Boundaries
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-indigo-500/30 text-indigo-200 font-mono font-semibold">
                Dynamic Engine
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-slate-300 font-medium mt-0.5 flex-wrap">
              <span
                className={`px-1.5 py-0.5 rounded border ${
                  config.maxConsecutiveLosses.enabled
                    ? 'bg-slate-800 border-slate-700 text-slate-200'
                    : 'bg-slate-950 border-slate-800/80 text-slate-500'
                }`}
              >
                Max Losses: {config.maxConsecutiveLosses.enabled ? `${config.maxConsecutiveLosses.value}` : 'OFF'}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded border ${
                  config.maxStakeCap.enabled
                    ? 'bg-slate-800 border-slate-700 text-slate-200'
                    : 'bg-slate-950 border-slate-800/80 text-slate-500'
                }`}
              >
                Max Stake: {config.maxStakeCap.enabled ? `$${config.maxStakeCap.value.toFixed(2)}` : 'OFF'}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded border ${
                  config.takeProfit.enabled
                    ? 'bg-emerald-950/60 border-emerald-500/30 text-emerald-300'
                    : 'bg-slate-950 border-slate-800/80 text-slate-500'
                }`}
              >
                TP: {config.takeProfit.enabled ? `+$${config.takeProfit.value.toFixed(2)}` : 'OFF'}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded border ${
                  config.stopLoss.enabled
                    ? 'bg-rose-950/60 border-rose-500/30 text-rose-300'
                    : 'bg-slate-950 border-slate-800/80 text-slate-500'
                }`}
              >
                SL: {config.stopLoss.enabled ? `-$${config.stopLoss.value.toFixed(2)}` : 'OFF'}
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          className="w-7 h-7 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors"
        >
          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {/* Expandable Configuration Form */}
      {isOpen && (
        <div className="pt-2 space-y-4 border-t border-indigo-500/20">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1">
              <Sliders className="w-3.5 h-3.5 text-indigo-400" /> Session Risk Rule Controls
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={handleResetDefaults}
              className="text-[10px] text-indigo-300 hover:text-indigo-200 flex items-center gap-1 underline font-medium"
            >
              <RotateCcw className="w-3 h-3" /> Reset to Base Stake Ratios
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Max Consecutive Losses */}
            <RiskRuleBox
              label="Max Consecutive Losses"
              icon={<ShieldAlert className="w-3.5 h-3.5 text-amber-400" />}
              rule={config.maxConsecutiveLosses}
              onRuleChange={(r) => updateRule('maxConsecutiveLosses', r)}
              disabled={disabled}
              min={1}
              step={1}
              unitSuffix=" Losses"
              accentColor="amber"
              currentValue={liveMetrics?.consecutiveLosses}
              presets={[
                { label: '3', value: 3 },
                { label: '5', value: 5 },
                { label: '8', value: 8 },
                { label: '10', value: 10 },
              ]}
            />

            {/* Max Stake Cap ($) */}
            <RiskRuleBox
              label="Max Stake Cap ($)"
              icon={<DollarSign className="w-3.5 h-3.5 text-indigo-400" />}
              rule={config.maxStakeCap}
              onRuleChange={(r) => updateRule('maxStakeCap', r)}
              disabled={disabled}
              min={0.35}
              step={0.5}
              unitPrefix="$"
              accentColor="indigo"
              presets={[
                { label: `5x ($${(baseStake * 5).toFixed(0)})`, value: Math.round(baseStake * 5 * 100) / 100 },
                { label: `10x ($${(baseStake * 10).toFixed(0)})`, value: Math.round(baseStake * 10 * 100) / 100 },
                { label: `20x ($${(baseStake * 20).toFixed(0)})`, value: Math.round(baseStake * 20 * 100) / 100 },
                { label: `50x ($${(baseStake * 50).toFixed(0)})`, value: Math.round(baseStake * 50 * 100) / 100 },
              ]}
            />

            {/* Session Take-Profit ($) */}
            <RiskRuleBox
              label="Session Take-Profit ($)"
              icon={<Target className="w-3.5 h-3.5 text-emerald-400" />}
              rule={config.takeProfit}
              onRuleChange={(r) => updateRule('takeProfit', r)}
              disabled={disabled}
              min={1}
              step={1}
              unitPrefix="+$"
              accentColor="emerald"
              currentValue={liveMetrics?.sessionPnL}
              presets={[
                { label: '+$10', value: 10 },
                { label: '+$25', value: 25 },
                { label: '+$50', value: 50 },
                { label: '+$100', value: 100 },
              ]}
            />

            {/* Session Stop-Loss ($) */}
            <RiskRuleBox
              label="Session Stop-Loss ($)"
              icon={<TrendingDown className="w-3.5 h-3.5 text-rose-400" />}
              rule={config.stopLoss}
              onRuleChange={(r) => updateRule('stopLoss', r)}
              disabled={disabled}
              min={1}
              step={1}
              unitPrefix="-$"
              accentColor="rose"
              currentValue={liveMetrics?.sessionPnL}
              presets={[
                { label: '-$10', value: 10 },
                { label: '-$25', value: 25 },
                { label: '-$50', value: 50 },
                { label: '-$100', value: 100 },
              ]}
            />
          </div>

          {/* Max Sequence Drawdown ($) */}
          <RiskRuleBox
            label="Max Sequence Drawdown ($)"
            icon={<AlertCircle className="w-3.5 h-3.5 text-purple-400" />}
            rule={config.maxSequenceLoss}
            onRuleChange={(r) => updateRule('maxSequenceLoss', r)}
            disabled={disabled}
            min={1}
            step={5}
            unitPrefix="-$"
            accentColor="purple"
            currentValue={liveMetrics?.sequencePnL}
            description="Applies to recovery progression strategies like Martingale, D'Alembert, and Oscar's Grind. Prevents sequence loss from exceeding this threshold."
          />
        </div>
      )}
    </div>
  );
}
