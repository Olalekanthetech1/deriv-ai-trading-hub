import { getLiveRiseFallSymbols, type RiseFallSymbolMetadata } from './rise-fall-symbols';

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
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) throw new Error('SYMBOL_REQUIRED');

  const discovered = await getLiveRiseFallSymbols(false, false);
  const metadata = discovered.find((item) => item.symbol === normalized && item.isAvailable && item.isRiseFallSupported);
  if (!metadata) throw new Error(`AUTHORITATIVE_ASSET_CONTEXT_UNAVAILABLE:${normalized}`);

  const market = String(metadata.market || '').trim().toLowerCase();
  switch (market) {
    case 'synthetic_index':
      return { symbol: normalized, assetCategory: 0, assetClass: 'synthetic', marketType: 'synthetic', metadata };
    case 'forex':
      return { symbol: normalized, assetCategory: 1, assetClass: 'forex', marketType: 'spot', metadata };
    case 'commodity':
      return { symbol: normalized, assetCategory: 2, assetClass: 'commodity', marketType: 'cfd', metadata };
    case 'cryptocurrency':
    case 'crypto':
      return { symbol: normalized, assetCategory: 3, assetClass: 'crypto', marketType: 'spot', metadata };
    default:
      throw new Error(`AUTHORITATIVE_ASSET_CONTEXT_UNAVAILABLE:${normalized}:${market || 'UNKNOWN_MARKET'}`);
  }
}
