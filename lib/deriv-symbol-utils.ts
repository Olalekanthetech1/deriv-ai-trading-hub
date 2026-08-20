import { SYMBOL_DISPLAY_NAMES } from './active-symbols-display-names';

// Build a fast lookup table from lower-cased symbol keys to their exact Deriv canonical casing.
const LOWER_TO_CANONICAL_MAP = new Map<string, string>();

for (const canonical of Object.keys(SYMBOL_DISPLAY_NAMES)) {
  LOWER_TO_CANONICAL_MAP.set(canonical.toLowerCase(), canonical);
}

// Ensure critical Step, Forex, Metals, Commodities, and Crypto canonical symbols are explicitly registered
const EXPLICIT_CANONICAL_REGISTRY: Record<string, string> = {
  // Step Indices
  stprng: 'stpRNG',
  stprng2: 'stpRNG2',
  stprng3: 'stpRNG3',
  stprng4: 'stpRNG4',
  stprng5: 'stpRNG5',
  stpidx100: 'STPIDX100',
  stpidx200: 'STPIDX200',
  stpidx300: 'STPIDX300',
  stpidx400: 'STPIDX400',
  stpidx500: 'STPIDX500',
  step_index: 'stpRNG',
  stepindex: 'stpRNG',

  // Metals & Commodities
  frxxauusd: 'frxXAUUSD',
  frxxagusd: 'frxXAGUSD',
  frxxpdusd: 'frxXPDUSD',
  frxxptusd: 'frxXPTUSD',
  frxbrousd: 'frxBROUSD',

  // Major & Minor Forex
  frxaudjpy: 'frxAUDJPY',
  frxaudusd: 'frxAUDUSD',
  frxeuraud: 'frxEURAUD',
  frxeurcad: 'frxEURCAD',
  frxeurchf: 'frxEURCHF',
  frxeurgbp: 'frxEURGBP',
  frxeurjpy: 'frxEURJPY',
  frxeurusd: 'frxEURUSD',
  frxgbpaud: 'frxGBPAUD',
  frxgbpjpy: 'frxGBPJPY',
  frxgbpnok: 'frxGBPNOK',
  frxgbpusd: 'frxGBPUSD',
  frxusdcad: 'frxUSDCAD',
  frxusdchf: 'frxUSDCHF',
  frxusdjpy: 'frxUSDJPY',
  frxusdnok: 'frxUSDNOK',
  frxusdsek: 'frxUSDSEK',
  frxgbppln: 'frxGBPPLN',
  frxaudcad: 'frxAUDCAD',
  frxaudchf: 'frxAUDCHF',
  frxaudnzd: 'frxAUDNZD',
  frxeurnzd: 'frxEURNZD',
  frxgbpcad: 'frxGBPCAD',
  frxgbpchf: 'frxGBPCHF',
  frxgbpnzd: 'frxGBPNZD',
  frxnzdjpy: 'frxNZDJPY',
  frxnzdusd: 'frxNZDUSD',
  frxusdmxn: 'frxUSDMXN',
  frxusdpln: 'frxUSDPLN',
  frxcadjpy: 'frxCADJPY',
  frxchfjpy: 'frxCHFJPY',
  frxcadchf: 'frxCADCHF',
  frxnzdcad: 'frxNZDCAD',
  frxnzdchf: 'frxNZDCHF',

  // Cryptocurrencies
  crybtcusd: 'cryBTCUSD',
  cryethusd: 'cryETHUSD',
  cryltcusd: 'cryLTCUSD',
  crybchusd: 'cryBCHUSD',
  cryxrpusd: 'cryXRPUSD',
  cryadausd: 'cryADAUSD',
  crydotusd: 'cryDOTUSD',
};

for (const [lower, canonical] of Object.entries(EXPLICIT_CANONICAL_REGISTRY)) {
  LOWER_TO_CANONICAL_MAP.set(lower.toLowerCase(), canonical);
}

/**
 * Dynamically resolves and converts any input symbol string into Deriv's strictly
 * case-sensitive canonical symbol string.
 *
 * Examples:
 * - 'FRXXAGUSD' -> 'frxXAGUSD' (Silver / USD)
 * - 'FRXXAUUSD' -> 'frxXAUUSD' (Gold / USD)
 * - 'FRXXPDUSD' -> 'frxXPDUSD' (Palladium / USD)
 * - 'FRXXPTUSD' -> 'frxXPTUSD' (Platinum / USD)
 * - 'FRXEURUSD' -> 'frxEURUSD' (EUR / USD)
 * - 'STPRNG'    -> 'stpRNG'    (Step Index)
 * - 'STPRNG2'   -> 'stpRNG2'   (Step Index 200)
 * - '1hz100v'   -> '1HZ100V'   (1s Volatility 100)
 * - 'r_100'     -> 'R_100'     (Volatility 100)
 */
export function canonicalizeDerivSymbol(rawSymbol: string): string {
  if (typeof rawSymbol !== 'string') return '';
  const trimmed = rawSymbol.trim();
  if (!trimmed) return '';

  const lower = trimmed.toLowerCase();

  // 1. Direct dictionary match
  const directMatch = LOWER_TO_CANONICAL_MAP.get(lower);
  if (directMatch) return directMatch;

  // 2. Pattern-based normalization for Forex & Metals (starts with 'frx')
  if (/^frx/i.test(trimmed)) {
    const body = trimmed.slice(3).toUpperCase();
    return `frx${body}`;
  }

  // 3. Pattern-based normalization for Cryptocurrencies (starts with 'cry')
  if (/^cry/i.test(trimmed)) {
    const body = trimmed.slice(3).toUpperCase();
    return `cry${body}`;
  }

  // 4. Pattern-based normalization for Step Indices (starts with 'stp')
  if (/^stp/i.test(trimmed)) {
    const match = trimmed.match(/^stp(?:rng)?(\d*)$/i);
    if (match) {
      const indexNum = match[1] || '';
      return indexNum ? `stpRNG${indexNum}` : 'stpRNG';
    }
    if (/^stpr_/i.test(trimmed)) {
      return `stpR_${trimmed.slice(5).toUpperCase()}`;
    }
    return trimmed;
  }

  // 5. 1-second Volatility indices (starts with '1hz')
  if (/^1hz/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  // 6. Standard Synthetics, Jumps, Booms, Crashes, Baskets, OTC (all uppercase)
  return trimmed.toUpperCase();
}

/**
 * Validates whether a symbol meets Deriv's identifier syntax (letters, digits, underscores, dashes, colons).
 */
export function isValidDerivSymbol(symbol: string): boolean {
  if (typeof symbol !== 'string') return false;
  const canonical = canonicalizeDerivSymbol(symbol);
  return /^[a-zA-Z0-9_./:-]{2,64}$/.test(canonical);
}
