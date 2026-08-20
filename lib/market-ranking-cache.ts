import { getDb, initDbSchema } from './db';
import { getLiveRiseFallSymbols } from './rise-fall-symbols';

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
}

const CACHE_KEY = 'live_market_rankings_v1';
const MAX_ALLOWED_DATA_AGE_MS = 25000; // 25 seconds freshness gate

let inMemorySnapshot: LiveMarketRankingSnapshot | null = null;
let isRefreshing = false;

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

  // 1. Check in-memory snapshot
  if (inMemorySnapshot) {
    const age = now - new Date(inMemorySnapshot.generatedAt).getTime();
    if (
      inMemorySnapshot.validationStatus === 'VALIDATED' &&
      inMemorySnapshot.rankings.length > 0 &&
      age >= 0 &&
      age <= MAX_ALLOWED_DATA_AGE_MS
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
        if (age >= 0 && age <= MAX_ALLOWED_DATA_AGE_MS) {
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
export async function refreshLiveMarketRankings(): Promise<LiveMarketRankingSnapshot> {
  if (isRefreshing && inMemorySnapshot) {
    return inMemorySnapshot;
  }

  isRefreshing = true;
  const startTime = Date.now();

  try {
    // 1. Discover active volatility symbols
    const discovered = await getLiveRiseFallSymbols(true, false);
    const eligible = discovered.filter(
      (item) => item.isAvailable && item.isOpen && item.isRiseFallSupported && item.categoryKeys.includes('volatility')
    );

    if (eligible.length === 0) {
      throw new Error('MARKET_RANKINGS_NO_ELIGIBLE_SYMBOLS');
    }

    // Stage 1: Lightweight Screening (Filtering active assets)
    const stage1Candidates = eligible.map((item) => {
      const volatilityIndexNum = parseInt(item.symbol.replace(/\D/g, ''), 10) || 50;
      return {
        metadata: item,
        stage1Score: volatilityIndexNum,
      };
    });

    const topCandidates = stage1Candidates.slice(0, 5);

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

    const snapshot: LiveMarketRankingSnapshot = {
      generatedAt: new Date().toISOString(),
      tickTimestamp: Date.now(),
      candidateCount: scanResults.length,
      rankings: scanResults,
      dataAgeMs: Date.now() - startTime,
      validationStatus: 'VALIDATED',
      modelVersion: scanResults[0]?.modelVersion || 'v2-production',
      featureSchemaVersion: 'v2-microstructure',
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
    isRefreshing = false;
  }
}
