import { getDb, initDbSchema } from './db';
import { getDerivDurationDiscovery, type DerivDurationDiscovery } from './deriv-duration-registry';

// Bump the persistent cache namespace whenever duration semantics change so
// old cross-unit ranges (for example seconds > 60) cannot survive a deploy.
const CACHE_KEY = 'derivDurationDiscoveryV2';
const FRESH_TTL_MS = 10 * 60 * 1000;

export type CachedDurationDiscovery = {
  discovery: DerivDurationDiscovery;
  cachedAt: string;
};

export async function readCachedDurationDiscovery(symbol: string): Promise<CachedDurationDiscovery | null> {
  const normalized = String(symbol ?? '').trim().toUpperCase();
  if (!normalized) return null;
  const sql = getDb();
  if (!sql || !(await initDbSchema())) return null;
  try {
    const rows = await sql`
      SELECT metadata->${CACHE_KEY} AS cached
      FROM market_assets
      WHERE symbol = ${normalized}
      LIMIT 1
    `;
    const cached = rows?.[0]?.cached as CachedDurationDiscovery | null | undefined;
    if (!cached?.discovery?.ranges?.length) return null;
    return cached;
  } catch (error) {
    console.warn(`[DerivDurationCache] read failed for ${normalized}:`, error);
    return null;
  }
}

export async function writeCachedDurationDiscovery(discovery: DerivDurationDiscovery): Promise<void> {
  const normalized = discovery.symbol.trim().toUpperCase();
  if (!normalized) return;
  const sql = getDb();
  if (!sql || !(await initDbSchema())) return;
  const cached: CachedDurationDiscovery = {
    discovery: { ...discovery, symbol: normalized },
    cachedAt: new Date().toISOString(),
  };
  try {
    await sql`
      INSERT INTO market_assets (symbol, asset_class, market_type, source, metadata)
      VALUES (${normalized}, 'unknown', 'unknown', 'deriv', ${JSON.stringify({ [CACHE_KEY]: cached })}::jsonb)
      ON CONFLICT (symbol) DO UPDATE
      SET metadata = COALESCE(market_assets.metadata, '{}'::jsonb) || ${JSON.stringify({ [CACHE_KEY]: cached })}::jsonb,
          updated_at = NOW()
    `;
  } catch (error) {
    console.warn(`[DerivDurationCache] write failed for ${normalized}:`, error);
  }
}

async function refreshDurationDiscovery(symbol: string): Promise<DerivDurationDiscovery> {
  const discovery = await getDerivDurationDiscovery(symbol);
  await writeCachedDurationDiscovery(discovery);
  return discovery;
}

export async function getCachedOrDiscoverDuration(symbol: string): Promise<{
  discovery: DerivDurationDiscovery;
  source: 'persistent-cache' | 'persistent-stale-cache' | 'deriv-live';
  refreshing: boolean;
  cachedAt?: string;
}> {
  const normalized = String(symbol ?? '').trim().toUpperCase();
  if (!normalized) throw new Error('A Deriv symbol is required for duration discovery.');

  const cached = await readCachedDurationDiscovery(normalized);
  if (cached) {
    const ageMs = Date.now() - Date.parse(cached.cachedAt || cached.discovery.fetchedAt);
    if (Number.isFinite(ageMs) && ageMs < FRESH_TTL_MS) {
      return { discovery: cached.discovery, source: 'persistent-cache', refreshing: false, cachedAt: cached.cachedAt };
    }

    void refreshDurationDiscovery(normalized).catch(error => {
      console.warn(`[DerivDurationCache] background refresh failed for ${normalized}:`, error);
    });
    return { discovery: cached.discovery, source: 'persistent-stale-cache', refreshing: true, cachedAt: cached.cachedAt };
  }

  const discovery = await refreshDurationDiscovery(normalized);
  return { discovery, source: 'deriv-live', refreshing: false };
}
