import { getSymbolDisplayName } from './active-symbols-display-names';

export type DisplayDurationUnit = 't' | 's' | 'm' | 'h' | 'd' | string;

const UNIT_LABELS: Record<string, string> = {
  t: 'tick',
  s: 'second',
  m: 'minute',
  h: 'hour',
  d: 'day',
};

export function formatReadableDuration(value: unknown, unit: DisplayDurationUnit): string {
  const numericValue = Number(value);
  const normalizedUnit = String(unit || '').toLowerCase();
  if (!Number.isFinite(numericValue) || numericValue <= 0) return '';
  const label = UNIT_LABELS[normalizedUnit] || normalizedUnit || 'unit';
  const count = Number.isInteger(numericValue) ? numericValue.toLocaleString() : numericValue.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return `${count} ${label}${numericValue === 1 ? '' : 's'}`;
}

function canonicalAssetName(symbol: string, displayName: unknown): string {
  const canonical = symbol ? getSymbolDisplayName(symbol) : '';
  const supplied = String(displayName || '').trim();
  if (!supplied) return canonical || 'Unknown asset';
  if (!symbol) return supplied;
  const normalizedSymbol = symbol.toUpperCase();
  const normalizedSupplied = supplied.toUpperCase();
  if (normalizedSupplied === normalizedSymbol || normalizedSupplied === `${normalizedSymbol} (${normalizedSymbol})`) return canonical || supplied;
  if (supplied.includes(`(${symbol})`) || supplied.includes(`(${normalizedSymbol})`)) return supplied;
  return supplied;
}

export function formatReadableDatasetName(input: {
  name?: unknown;
  assetSymbol?: unknown;
  assetDisplayName?: unknown;
  durationValue?: unknown;
  durationUnit?: unknown;
  taskLabel?: string;
}): string {
  const symbol = String(input.assetSymbol || '').trim();
  const assetName = canonicalAssetName(symbol, input.assetDisplayName);
  const assetLabel = symbol && !assetName.toUpperCase().includes(`(${symbol.toUpperCase()})`) ? `${assetName} (${symbol})` : assetName;
  const duration = formatReadableDuration(input.durationValue, String(input.durationUnit || ''));
  const task = input.taskLabel?.trim() || 'Direction Dataset';
  return duration ? `${assetLabel} — ${duration} ${task}` : `${assetLabel} — ${task}`;
}

export function formatReadableAsset(input: unknown): string {
  const symbol = String(input || '').trim();
  if (!symbol) return 'Unknown asset';
  return `${getSymbolDisplayName(symbol)} (${symbol})`;
}