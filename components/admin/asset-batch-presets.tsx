import { CheckSquare, Square, Sparkles } from 'lucide-react';
import type { RiseFallSymbolMetadata } from '@/lib/rise-fall-symbols';

interface AssetBatchPresetsProps {
  availableAssets: RiseFallSymbolMetadata[];
  onSelectSymbols: (symbols: string[]) => void;
  onClear: () => void;
  selectedCount?: number;
}

type PresetDefinition = {
  key: string;
  label: string;
  tone: string;
};

const PRESETS: PresetDefinition[] = [
  { key: 'synthetic', label: 'All Synthetics', tone: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30 hover:bg-cyan-500/20' },
  { key: 'volatility_1s', label: 'Vol (1s)', tone: 'text-indigo-300 bg-indigo-500/10 border-indigo-500/30 hover:bg-indigo-500/20' },
  { key: 'volatility_standard', label: 'Vol (Standard)', tone: 'text-blue-300 bg-blue-500/10 border-blue-500/30 hover:bg-blue-500/20' },
  { key: 'volatility', label: 'Volatility (All)', tone: 'text-slate-300 bg-white/5 border-white/10 hover:bg-white/10' },
  { key: 'step', label: 'Step', tone: 'text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/30 hover:bg-fuchsia-500/20' },
  { key: 'jump', label: 'Jump', tone: 'text-amber-300 bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20' },
  { key: 'crash_boom', label: 'Crash / Boom', tone: 'text-rose-300 bg-rose-500/10 border-rose-500/30 hover:bg-rose-500/20' },
  { key: 'forex_major', label: 'Forex (Majors)', tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20' },
];

export function AssetBatchPresets({ availableAssets, onSelectSymbols, onClear, selectedCount }: AssetBatchPresetsProps) {
  if (!availableAssets.length) return null;

  const presets = PRESETS
    .map((preset) => ({
      ...preset,
      assets: availableAssets.filter((asset) => asset.categoryKeys.includes(preset.key)),
    }))
    .filter((preset) => preset.assets.length > 0);

  const handleApply = (assets: RiseFallSymbolMetadata[]) => {
    onSelectSymbols(assets.map((asset) => asset.symbol));
  };

  return (
    <div className="flex flex-col gap-2 pt-3 border-t border-white/5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1 mr-1">
          <Sparkles className="h-3 w-3 text-cyan-400" />
          Server asset groups:
        </span>
        {presets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            title={`${preset.assets.length} currently available assets in the server-defined ${preset.label} group`}
            onClick={() => handleApply(preset.assets)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition font-medium cursor-pointer ${preset.tone}`}
          >
            {preset.label}
            <span className="inline-block rounded-md bg-black/40 px-1.5 py-0.5 text-[9px] font-bold opacity-90">
              {preset.assets.length}
            </span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 text-[11px] font-semibold">
        <button
          type="button"
          onClick={() => handleApply(availableAssets)}
          className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1 cursor-pointer"
        >
          <CheckSquare className="h-3 w-3" /> Select All ({availableAssets.length})
        </button>
        <button
          type="button"
          onClick={onClear}
          className="text-slate-400 hover:text-slate-300 inline-flex items-center gap-1 cursor-pointer"
        >
          <Square className="h-3 w-3" /> Clear Selection
        </button>
        {selectedCount !== undefined && selectedCount > 0 && (
          <span className="text-emerald-400 ml-auto flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {selectedCount} selected
          </span>
        )}
      </div>
    </div>
  );
}
