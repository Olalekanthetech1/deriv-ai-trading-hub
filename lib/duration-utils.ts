import type { ContractInfo } from '@deriv/core';
import { DERIV_TIME_DURATION_BANDS } from './deriv-duration-policy';

export type DurationApiUnit = 't' | 's' | 'm' | 'd';
export type DurationSelectUnit = 't' | 's' | 'm' | 'h' | 'd' | 'end-time';

export interface DurationOption {
  unit: DurationSelectUnit;
  label: string;
  min: number;
  max: number;
}

export interface TradingEvent {
  dates: string;
  descrip: string;
}

export interface TradingSymbolData {
  underlying_symbol: string;
  name: string;
  times: {
    open: string[];
    close: string[];
  };
  trading_days: string[];
  events: TradingEvent[];
}

const DURATION_ORDER: DurationSelectUnit[] = ['t', 's', 'm', 'h', 'd', 'end-time'];

const DURATION_LABELS: Record<DurationSelectUnit, string> = {
  t: 'Ticks',
  s: 'Seconds',
  m: 'Minutes',
  h: 'Hours',
  d: 'Days',
  'end-time': 'End Time',
};

function parseDurationToSeconds(durationStr: string): number {
  const num = parseInt(durationStr, 10);
  const unit = durationStr.replace(/^\d+/, '');
  switch (unit) {
    case 's': return num;
    case 'm': return num * 60;
    case 'h': return num * 3600;
    case 'd': return num * 86400;
    default: return num;
  }
}

export function getDurationOptions(contracts: ContractInfo[]): DurationOption[] {
  const optMap = new Map<DurationSelectUnit, DurationOption>();

  for (const contract of contracts) {
    const minStr = contract.min_contract_duration;
    const maxStr = contract.max_contract_duration;
    const expiryType = contract.expiry_type;

    if (expiryType === 'tick') {
      if (!optMap.has('t')) {
        optMap.set('t', { unit: 't', label: DURATION_LABELS.t, min: parseInt(minStr, 10), max: parseInt(maxStr, 10) });
      }
    } else if (expiryType === 'intraday') {
      const minSec = parseDurationToSeconds(minStr);
      const maxSec = parseDurationToSeconds(maxStr);

      if (maxSec >= DERIV_TIME_DURATION_BANDS.s.min && !optMap.has('s')) {
        const sMin = Math.max(DERIV_TIME_DURATION_BANDS.s.min, minSec);
        const sMax = Math.min(DERIV_TIME_DURATION_BANDS.s.max, maxSec);
        if (sMin <= sMax) optMap.set('s', { unit: 's', label: DURATION_LABELS.s, min: sMin, max: sMax });
      }

      if (maxSec >= 60 && !optMap.has('m')) {
        const mMin = Math.max(DERIV_TIME_DURATION_BANDS.m.min, Math.ceil(minSec / 60));
        const mMax = Math.min(DERIV_TIME_DURATION_BANDS.m.max, Math.floor(maxSec / 60));
        if (mMin <= mMax) optMap.set('m', { unit: 'm', label: DURATION_LABELS.m, min: mMin, max: mMax });
      }

      if (maxSec >= 3600 && !optMap.has('h')) {
        const hMin = Math.max(DERIV_TIME_DURATION_BANDS.h.min, Math.ceil(minSec / 3600));
        const hMax = Math.min(DERIV_TIME_DURATION_BANDS.h.max, Math.floor(maxSec / 3600));
        if (hMin <= hMax) optMap.set('h', { unit: 'h', label: DURATION_LABELS.h, min: hMin, max: hMax });
      }
    } else if (expiryType === 'daily') {
      const dMin = Math.max(DERIV_TIME_DURATION_BANDS.d.min, parseInt(minStr, 10));
      const dMax = Math.min(DERIV_TIME_DURATION_BANDS.d.max, parseInt(maxStr, 10));
      if (!optMap.has('d') && dMin <= dMax) optMap.set('d', { unit: 'd', label: DURATION_LABELS.d, min: dMin, max: dMax });
      if (!optMap.has('end-time') && dMin <= dMax) optMap.set('end-time', { unit: 'end-time', label: DURATION_LABELS['end-time'], min: dMin, max: dMax });
    }
  }

  return DURATION_ORDER.reduce<DurationOption[]>((acc, u) => {
    const opt = optMap.get(u);
    if (opt) acc.push(opt);
    return acc;
  }, []);
}

export function computeEndTimeEpoch(date: Date | undefined, timeStr: string): number | null {
  if (!date || !timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const hours = parseInt(parts[0], 10);
  const mins = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(mins)) return null;
  const secs = parts.length >= 3 ? (parseInt(parts[2], 10) || 0) : 0;
  const epochMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), hours, mins, secs, 0);
  const epochSec = Math.floor(epochMs / 1000);
  if (epochSec <= Math.floor(Date.now() / 1000)) return null;
  return epochSec;
}

export function parseTradingDays(tradingDays: string[]): number[] {
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const tradingSet = new Set<number>();
  for (const d of tradingDays) {
    const idx = dayMap[d];
    if (idx !== undefined) tradingSet.add(idx);
  }
  return [0, 1, 2, 3, 4, 5, 6].filter(d => !tradingSet.has(d));
}

export function getEarlyCloseDates(events: TradingEvent[], month: Date): Date[] {
  const year = month.getFullYear();
  const monthNum = month.getMonth();
  const result: Date[] = [];
  for (const event of events) {
    if (!event.descrip.toLowerCase().includes('closes early')) continue;
    for (const dateStr of event.dates.split(',').map(d => d.trim())) {
      const parts = dateStr.split('-');
      if (parts.length !== 3) continue;
      const y = parseInt(parts[0], 10);
      const mo = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      if (isNaN(y) || isNaN(mo) || isNaN(day)) continue;
      if (y === year && mo === monthNum) result.push(new Date(y, mo, day));
    }
  }
  return result;
}

export function parseCloseTime(closeArr: string[]): string {
  if (!closeArr || closeArr.length === 0) return '';
  const parts = closeArr[closeArr.length - 1].split(':');
  if (parts.length < 2) return '';
  const hh = parts[0].padStart(2, '0');
  const mm = parts[1].padStart(2, '0');
  const ss = (parts[2] ?? '00').padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function getCloseTimeForDate(data: TradingSymbolData, date: Date): string {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayNamePlural = `${dayNames[date.getDay()]}s`;
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dateStr = `${y}-${mo}-${d}`;

  for (const event of data.events) {
    if (!event.descrip.toLowerCase().includes('closes early')) continue;
    const applies = event.dates.split(',').map(s => s.trim()).some(s => s === dayNamePlural || s === dateStr);
    if (!applies) continue;
    const match = event.descrip.match(/\(at (\d{1,2}):(\d{2})\)/);
    if (match) return `${match[1].padStart(2, '0')}:${match[2]}:00`;
  }

  return parseCloseTime(data.times.close);
}

// Horizon selection is server-authoritative. The client may select the requested
// mode, but it must never calculate an optimal horizon locally.
export type AutoHorizonMode = 'auto' | 't' | 's' | 'm' | 'h' | 'd';

export const TELEGRAM_SUPPORTED_HORIZONS: ReadonlyArray<{ value: number; unit: DurationSelectUnit }> = [
  { value: 5, unit: 't' },
  { value: 10, unit: 't' },
  { value: 15, unit: 's' },
  { value: 30, unit: 's' },
  { value: 60, unit: 's' },
] as const;

