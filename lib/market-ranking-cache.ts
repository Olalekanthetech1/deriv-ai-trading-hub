/**
 * Compatibility export retained for existing Telegram controller imports.
 *
 * Ranking state is intentionally NOT cached. The implementation lives in
 * `live-market-ranking.ts` and performs a fresh server-side signal request on
 * every invocation.
 */
export {
  refreshLiveMarketRankings,
  type RankedAssetItem,
  type LiveMarketRankingSnapshot,
} from './live-market-ranking';
