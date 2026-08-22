import { getDb, initDbSchema } from './db';
import {
  refreshLiveMarketRankings,
  type RankedAssetItem,
  type LiveMarketRankingSnapshot,
} from './live-market-ranking';

export type { RankedAssetItem, LiveMarketRankingSnapshot };
export { refreshLiveMarketRankings };

/**
 * Compatibility API for the admin control plane.
 *
 * Ranking results are no longer cached. A health/status request therefore
 * performs a fresh live ranking operation rather than reading a stored snapshot.
 */
export async function getValidMarketRankingSnapshot(): Promise<LiveMarketRankingSnapshot | null> {
  return refreshLiveMarketRankings();
}

/**
 * Removes the legacy persisted GLOBAL_RANKINGS row. No new ranking cache is
 * created or read by the live ranking implementation.
 */
export async function clearMarketRankingCache(): Promise<void> {
  try {
    const sql = getDb();
    if (sql && (await initDbSchema())) {
      await sql`
        DELETE FROM market_assets
        WHERE symbol = 'GLOBAL_RANKINGS'
      `;
    }
  } catch (err) {
    console.warn(
      '[MarketRankingCache] Legacy ranking-row cleanup failed:',
      err instanceof Error ? err.message : 'unknown',
    );
  }
}
