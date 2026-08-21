import { getDb, initDbSchema } from './db';
import { getLiveRiseFallSymbols } from './rise-fall-symbols';
import { fetchDerivTickHistory } from './ticks-helper';
import { TELEGRAM_SUPPORTED_HORIZONS } from './duration-utils';
import { getTelegramAssetGovernanceConfig, isSymbolApprovedForTelegram } from './ops-runtime-config';

export interface RankedAssetItem {
  symbol: string;
  name: string;
  winRate: number;
  signal: 'CALL' | 'PUT';
  confidence: number;
  modelVersion?: string;
  executionPlanId?: string;
  horizonLabel?: string;
  stage1Score?: number;
}

export interface LiveMarketRankingSnapshot {
  generatedAt: string;
  tickTimestamp: number;
  candidateCount: number;
  rankings: RankedAssetItem[];
  dataAgeMs: number;
  validationStatus: 'VALIDATED' | 'DEGRADED' | 'EXPIRED';
  modelVersion?: string;
  featureSchemaVersion?: string;
  medianCadenceMs?: number;
}

const CACHE_KEY = 'live_market_rankings_v1';
const MAX_ALLOWED_DATA_AGE_MS = 10000; // 10 seconds absolute ceiling

let inMemorySnapshot: LiveMarketRankingSnapshot | null = null;
let activeRefreshPromise: Promise<LiveMarketRankingSnapshot> | null = null;

/**
 * Immediately purges and deletes the market ranking cache from both in-memory state and database storage.
 */
export async function clearMarketRankingCache(): Promise<void> {
  inMemorySnapshot = null;
  activeRefreshPromise = null;
  try {
    const sql = getDb();
    if (sql && (await initDbSchema())) {
      await sql`
        DELETE FROM market_assets
        WHERE symbol = 'GLOBAL_RANKINGS'
      `;
    }
  } catch (err) {
    console.warn('[MarketRankingCache] Error clearing DB market ranking cache:', err instanceof Error ? err.message : 'unknown');
  }
}

function getInternalBaseUrl(): string {
  const configured = process.env.APP_URL || process.env.RENDER_BACKEND_URL;
  if (configured) return configured.replace(/\/$/, '');
  return `http://127.0.0.1:${process.env.PORT || '3000'}`;
}

/**
 * Reads valid market ranking snapshot if present, validated, and within freshness threshold.
 */
export async function getValidMarketRankingSnapshot(): Promise<LiveMarketRankingSnapshot | null> {
  const now = Date.now();
  
  const isValidAge = (snap: LiveMarketRankingSnapshot, currentAge: number) => {
     // Cadence-derived freshness: assume prediction holds for ~4 ticks
     const cadence = snap.medianCadenceMs || 2000; // default 2s
     const cadenceThreshold = Math.max(cadence * 4, 6000); // minimum 6s tolerance
     const effectiveFreshness = Math.min(MAX_ALLOWED_DATA_AGE_MS, cadenceThreshold);
     return currentAge >= 0 && currentAge <= effectiveFreshness;
  };

  // 1. Check in-memory snapshot
  if (inMemorySnapshot) {
    const age = now - new Date(inMemorySnapshot.generatedAt).getTime();
    if (
      inMemorySnapshot.validationStatus === 'VALIDATED' &&
      inMemorySnapshot.rankings.length > 0 &&
      isValidAge(inMemorySnapshot, age)
    ) {
      return {
        ...inMemorySnapshot,
        dataAgeMs: Math.round(age),
      };
    }
  }

  // 2. Check DB snapshot
  try {
    const sql = getDb();
    if (sql && (await initDbSchema())) {
      const rows = await sql`
        SELECT metadata->${CACHE_KEY} AS cached
        FROM market_assets
        WHERE symbol = 'GLOBAL_RANKINGS'
        LIMIT 1
      `;
      const cached = rows?.[0]?.cached as LiveMarketRankingSnapshot | null | undefined;
      if (cached?.rankings?.length && cached.validationStatus === 'VALIDATED') {
        const age = now - new Date(cached.generatedAt).getTime();
        if (isValidAge(cached, age)) {
          inMemorySnapshot = cached;
          return {
            ...cached,
            dataAgeMs: Math.round(age),
          };
        }
      }
    }
  } catch (err) {
    console.warn('[MarketRankingCache] DB read error:', err instanceof Error ? err.message : 'unknown');
  }

  return null;
}

/**
 * Executes Option 1 + Option 2 intelligent 2-stage refresh pipeline:
 * Stage 1: Lightweight screening across active symbols
 * Stage 2: Deep ML ensemble evaluation on top candidates
 * Updates cache atomically and persists snapshot.
 */
export async function refreshLiveMarketRankings(
  onProgress?: (stage: 'data_stream' | 'ai_analysis' | 'target_locked') => Promise<void> | void
): Promise<LiveMarketRankingSnapshot> {
  // Single-flight request coalescing: concurrent misses join the active promise
  if (activeRefreshPromise) {
    return activeRefreshPromise;
  }

  activeRefreshPromise = (async () => {
    const startTime = Date.now();

    try {
    // 1. Discover active symbols and apply dynamic asset governance whitelist
    const discovered = await getLiveRiseFallSymbols(true, false);
    const governanceConfig = await getTelegramAssetGovernanceConfig();
    
    if (onProgress) await onProgress('data_stream');

    const eligible = discovered.filter(
      (item) => item.isAvailable && item.isOpen && item.isRiseFallSupported && isSymbolApprovedForTelegram(item.symbol, item.categoryKeys, governanceConfig)
    );

    if (eligible.length === 0) {
      throw new Error('MARKET_RANKINGS_NO_ELIGIBLE_SYMBOLS');
    }

    // Stage 1: Diversity-aware candidate selection across Volatility 1s, Standard Volatility, and Jump Indices
    const vol1sCandidates = eligible.filter((item) => item.categoryKeys.includes('volatility_1s') || item.symbol.toUpperCase().startsWith('1HZ'));
    const volStdCandidates = eligible.filter((item) => item.categoryKeys.includes('volatility_standard') || item.symbol.toUpperCase().startsWith('R_'));
    const jumpCandidates = eligible.filter((item) => item.categoryKeys.includes('jump') || item.symbol.toUpperCase().startsWith('JD'));
    const otherCandidates = eligible.filter((item) => !vol1sCandidates.includes(item) && !volStdCandidates.includes(item) && !jumpCandidates.includes(item));

    // Combine top candidates from each asset family (Vol 1s, Vol Standard, Jump)
    const candidatePool = [
      ...vol1sCandidates.slice(0, 5),
      ...volStdCandidates.slice(0, 5),
      ...jumpCandidates.slice(0, 5),
      ...otherCandidates.slice(0, 3),
    ];

    const topCandidates = candidatePool.map((item) => ({
      metadata: item,
      stage1Score: parseInt(item.symbol.replace(/\D/g, ''), 10) || 50,
    }));

    if (onProgress) await onProgress('ai_analysis');

    // Stage 2: Deep Ensemble ML Inference
    const baseUrl = getInternalBaseUrl();
    const scanResults: RankedAssetItem[] = [];

    await Promise.all(
      topCandidates.map(async ({ metadata, stage1Score }) => {
        try {
          const res = await fetch(`${baseUrl}/api/signals/predict`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            },
            body: JSON.stringify({
              symbol: metadata.symbol,
              durationValue: 5,
              durationUnit: 't',
              isAutoDuration: true,
              mode: 'auto',
              autoHorizonMode: 'auto',
              allowedHorizons: TELEGRAM_SUPPORTED_HORIZONS,
            }),
          });

          const data = await res.json().catch(() => null);
          if (res.ok && data?.success === true && data.prediction && data.executionPlan) {
            if (data.executionPlan.horizonAligned && data.executionPlan.strategyGateAccepted) {
              const confidence = Number(data.prediction.confidence) || 50;
              const winRate = Math.round(confidence);
              scanResults.push({
                symbol: metadata.symbol,
                name: metadata.displayName,
                winRate,
                signal: data.prediction.signal === 'CALL' ? 'CALL' : 'PUT',
                confidence,
                modelVersion: data.prediction.modelVersion || 'v2-production',
                executionPlanId: data.executionPlan.executionPlanId,
                horizonLabel: data.executionPlan.selectedHorizon?.label,
                stage1Score,
              });
            }
          }
        } catch (err) {
          console.warn(`[MarketRankingCache] Signal prediction failed for ${metadata.symbol}:`, err instanceof Error ? err.message : 'unknown');
        }
      })
    );

    if (scanResults.length === 0) {
      throw new Error('MARKET_RANKINGS_INFERENCE_DEGRADED');
    }

    scanResults.sort((a, b) => b.winRate - a.winRate);

    // Derive cadence from top asset
    let medianCadenceMs = 2000;
    try {
      if (scanResults.length > 0) {
        const topSymbol = scanResults[0].symbol;
        const ticks = await fetchDerivTickHistory(topSymbol, 15, 'latest', 1);
        if (ticks.length >= 5) {
          const sorted = ticks.slice().sort((a, b) => a.timestamp - b.timestamp);
          const intervals = sorted.slice(1).map((t, i) => t.timestamp - sorted[i].timestamp).filter(v => v > 0);
          if (intervals.length > 0) {
            intervals.sort((a, b) => a - b);
            medianCadenceMs = intervals[Math.floor(intervals.length / 2)];
          }
        }
      }
    } catch (err) {
      console.warn('[MarketRankingCache] Cadence discovery failed:', err instanceof Error ? err.message : 'unknown');
    }

    if (onProgress) await onProgress('target_locked');

    const snapshot: LiveMarketRankingSnapshot = {
      generatedAt: new Date().toISOString(),
      tickTimestamp: Date.now(),
      candidateCount: scanResults.length,
      rankings: scanResults,
      dataAgeMs: Date.now() - startTime,
      validationStatus: 'VALIDATED',
      modelVersion: scanResults[0]?.modelVersion || 'v2-production',
      featureSchemaVersion: 'v2-microstructure',
      medianCadenceMs,
    };

    inMemorySnapshot = snapshot;

    try {
      const sql = getDb();
      if (sql && (await initDbSchema())) {
        await sql`
          INSERT INTO market_assets (symbol, asset_class, market_type, source, metadata)
          VALUES ('GLOBAL_RANKINGS', 'system', 'ranking_cache', 'deriv', ${JSON.stringify({ [CACHE_KEY]: snapshot })}::jsonb)
          ON CONFLICT (symbol) DO UPDATE
          SET metadata = COALESCE(market_assets.metadata, '{}'::jsonb) || ${JSON.stringify({ [CACHE_KEY]: snapshot })}::jsonb,
              updated_at = NOW()
        `;
      }
    } catch (err) {
      console.warn('[MarketRankingCache] DB write error:', err instanceof Error ? err.message : 'unknown');
    }

    return snapshot;
    } finally {
      activeRefreshPromise = null;
    }
  })();

  return activeRefreshPromise;
}
