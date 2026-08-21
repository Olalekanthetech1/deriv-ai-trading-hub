import WebSocket from 'ws';
import { openDerivPublicWebSocket } from '@/lib/deriv-public-websocket';
import { logger } from '@/lib/logger';

export interface RiseFallSymbolMetadata {
  symbol: string;
  displayName: string;
  market: string;
  submarket: string;
  isOpen: boolean;
  isAvailable: boolean;
  tradeTypes: string[];
  isRiseFallSupported: boolean;
  /** Server-derived taxonomy used by admin asset filters. */
  categoryKeys: string[];
}

let cachedSymbols: RiseFallSymbolMetadata[] | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 15 * 60 * 1000;
let inFlightDiscovery: Promise<RiseFallSymbolMetadata[]> | null = null;

export function hasRiseFallContracts(contractTypes: Iterable<string>): boolean {
  const set = new Set(Array.from(contractTypes).map((t) => String(t).trim().toUpperCase()));
  return set.has('CALL') && set.has('PUT');
}

export async function checkDerivSymbolRiseFall(
  ws: WebSocket,
  symbol: string,
  timeoutMs = 5000
): Promise<{ isRiseFallSupported: boolean; contractTypes: string[] }> {
  const reqId = Math.floor(Math.random() * 1_000_000);

  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.off('message', onMessage);
        resolve({ isRiseFallSupported: false, contractTypes: [] });
      }
    }, timeoutMs);

    const onMessage = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.req_id !== reqId || resolved) return;
        resolved = true;
        clearTimeout(timer);
        ws.off('message', onMessage);

        const available = msg.contracts_for?.available;
        if (!Array.isArray(available)) {
          resolve({ isRiseFallSupported: false, contractTypes: [] });
          return;
        }
        const types = Array.from(
          new Set(available.map((c: any) => String(c?.contract_type || '').toUpperCase()))
        ).filter(Boolean);
        resolve({ isRiseFallSupported: hasRiseFallContracts(types), contractTypes: types });
      } catch {
        // Ignore unrelated concurrent websocket messages.
      }
    };

    ws.on('message', onMessage);
    try {
      ws.send(JSON.stringify({ contracts_for: symbol, req_id: reqId }));
    } catch {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve({ isRiseFallSupported: false, contractTypes: [] });
      }
    }
  });
}

/**
 * Deriv market/submarket metadata is the source of truth for UI taxonomy.
 * Symbol syntax is used only where Deriv's active_symbols response does not expose
 * a finer-grained taxonomy (currently the 1-second volatility family).
 */
function deriveCategoryKeys(item: any, symbol: string): string[] {
  const market = String(item.market || '').trim().toLowerCase();
  const submarket = String(item.submarket || '').trim().toLowerCase();
  const upperSymbol = symbol.toUpperCase();
  const categories = new Set<string>();

  if (market === 'synthetic_index') categories.add('synthetic');
  if (market === 'forex' || submarket === 'major_pairs' || submarket === 'minor_pairs' || (upperSymbol.startsWith('FRX') && !/(XAU|XAG|XPD|XPT|BRO)/i.test(symbol))) {
    categories.add('forex');
    if (submarket === 'major_pairs') categories.add('forex_major');
  }

  if (market === 'commodities' || market === 'commodity' || submarket === 'metals' || submarket === 'energy' || /(XAU|XAG|XPD|XPT|BRO)/i.test(symbol)) {
    categories.add('commodities');
    categories.add('metals');
  }

  if (submarket === 'random_index') {
    categories.add('volatility');
    const is1s = upperSymbol.startsWith('1HZ') || (upperSymbol.startsWith('HZ') && upperSymbol.endsWith('V')) || /^\d*HZ/i.test(upperSymbol);
    categories.add(is1s ? 'volatility_1s' : 'volatility_standard');
  }
  if (submarket === 'step_index' || upperSymbol.startsWith('STP')) {
    categories.add('step');
    categories.add('synthetic');
  }
  if (submarket === 'jump_index' || upperSymbol.startsWith('JD')) categories.add('jump');
  if (submarket === 'crash_index') categories.add('crash_boom');
  if (market === 'cryptocurrency' || market === 'crypto' || upperSymbol.startsWith('CRY')) {
    categories.add('crypto');
  }

  return [...categories];
}

/**
 * Dynamically discover active Deriv instruments and expose a server-authoritative
 * catalogue. The client must consume categoryKeys rather than reclassifying symbols.
 */
export async function getLiveRiseFallSymbols(
  forceRefresh = false,
  allowCachedOnError = true
): Promise<RiseFallSymbolMetadata[]> {
  const now = Date.now();
  if (!forceRefresh && cachedSymbols && cacheExpiresAt > now) return cachedSymbols;
  if (inFlightDiscovery) return inFlightDiscovery;

  inFlightDiscovery = (async () => {
    let ws: WebSocket | null = null;
    try {
      ws = await openDerivPublicWebSocket(10_000);

      const activeSymbols = await new Promise<any[]>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Deriv active_symbols request timed out')), 8000);
        const onMsg = (data: WebSocket.Data) => {
          try {
            const parsed = JSON.parse(data.toString());
            if (parsed.msg_type === 'active_symbols' && Array.isArray(parsed.active_symbols)) {
              clearTimeout(timeout);
              ws?.off('message', onMsg);
              resolve(parsed.active_symbols);
            } else if (parsed.error) {
              clearTimeout(timeout);
              ws?.off('message', onMsg);
              reject(new Error(parsed.error.message || 'Deriv active_symbols error'));
            }
          } catch {
            // Ignore malformed concurrent messages.
          }
        };
        ws!.on('message', onMsg);
        ws!.send(JSON.stringify({ active_symbols: 'brief', req_id: 1 }));
      });

      const excludedSubmarkets = new Set([
        'crash_index',
        'range_index',
        'non_stable_coin',
        'forex_basket',
        'commodity_basket',
      ]);

      const riseFallSymbols: RiseFallSymbolMetadata[] = [];
      for (const item of activeSymbols) {
        const symbol = String(item.underlying_symbol || '').trim();
        if (!symbol) continue;
        const submarket = String(item.submarket || '').trim().toLowerCase();
        if (excludedSubmarkets.has(submarket)) continue;

        const exchangeIsOpen = item.exchange_is_open === true || item.exchange_is_open === 1 || item.exchange_is_open === '1';
        const tradingSuspended = item.is_trading_suspended === true || item.is_trading_suspended === 1 || item.is_trading_suspended === '1';

        riseFallSymbols.push({
          symbol,
          displayName: String(item.underlying_symbol_name || symbol),
          market: String(item.market || ''),
          submarket,
          isOpen: exchangeIsOpen && !tradingSuspended,
          isAvailable: !tradingSuspended,
          tradeTypes: ['CALL', 'PUT'],
          isRiseFallSupported: true,
          categoryKeys: deriveCategoryKeys(item, symbol),
        });
      }

      cachedSymbols = riseFallSymbols;
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      logger.info(`[Deriv Symbols] Dynamically discovered ${riseFallSymbols.length} Rise/Fall supported instruments.`);
      return riseFallSymbols;
    } catch (err: any) {
      logger.error(`[Deriv Symbols] Failed to discover Rise/Fall symbols: ${err?.message || err}`);
      if (allowCachedOnError && cachedSymbols && cachedSymbols.length > 0) return cachedSymbols;
      throw err;
    } finally {
      if (ws) {
        try { ws.close(); } catch {}
      }
      inFlightDiscovery = null;
    }
  })();

  return inFlightDiscovery;
}
