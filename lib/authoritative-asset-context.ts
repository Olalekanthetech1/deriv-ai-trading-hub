import { getLiveRiseFallSymbols, type RiseFallSymbolMetadata } from './rise-fall-symbols';
import { canonicalizeDerivSymbol } from './deriv-symbol-utils';

export type AuthoritativeAssetClass = 'synthetic' | 'forex' | 'commodity' | 'crypto';
export type AuthoritativeMarketType = 'synthetic' | 'spot' | 'cfd';

export interface AuthoritativeAssetContext {
  symbol: string;
  assetCategory: number;
  assetClass: AuthoritativeAssetClass;
  marketType: AuthoritativeMarketType;
  metadata: RiseFallSymbolMetadata;
}

export async function resolveAuthoritativeAssetContext(symbol: string): Promise<AuthoritativeAssetContext> {
  const canonical = canonicalizeDerivSymbol(symbol);
  if (!canonical) throw new Error('SYMBOL_REQUIRED');

  const discovered = await getLiveRiseFallSymbols(false, false);
  const metadata = discovered.find(
    (item) => item.symbol.toLowerCase() === canonical.toLowerCase() && item.isAvailable && item.isRiseFallSupported
  );
  if (!metadata) throw new Error(`AUTHORITATIVE_ASSET_CONTEXT_UNAVAILABLE:${canonical}`);

  const market = String(metadata.market || '').trim().toLowerCase();
  const submarket = String(metadata.submarket || '').trim().toLowerCase();

  if (market === 'synthetic_index' || submarket.includes('step') || submarket.includes('random') || submarket.includes('crash') || canonical.startsWith('stp')) {
    return { symbol: metadata.symbol, assetCategory: 0, assetClass: 'synthetic', marketType: 'synthetic', metadata };
  }
  if (market === 'forex' || (canonical.startsWith('frx') && !/(XAU|XAG|XPD|XPT|BRO)/i.test(canonical))) {
    return { symbol: metadata.symbol, assetCategory: 1, assetClass: 'forex', marketType: 'spot', metadata };
  }
  if (market === 'commodity' || market === 'commodities' || /(XAU|XAG|XPD|XPT|BRO)/i.test(canonical)) {
    return { symbol: metadata.symbol, assetCategory: 2, assetClass: 'commodity', marketType: 'cfd', metadata };
  }
  if (market === 'cryptocurrency' || market === 'crypto' || canonical.startsWith('cry')) {
    return { symbol: metadata.symbol, assetCategory: 3, assetClass: 'crypto', marketType: 'spot', metadata };
  }

  throw new Error(`AUTHORITATIVE_ASSET_CONTEXT_UNAVAILABLE:${canonical}:${market || 'UNKNOWN_MARKET'}`);
}
