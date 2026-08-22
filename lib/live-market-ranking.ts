import { getLiveRiseFallSymbols, type RiseFallSymbolMetadata } from './rise-fall-symbols';
import { TELEGRAM_SUPPORTED_HORIZONS } from './duration-utils';
import { getTelegramAssetGovernanceConfig, isSymbolApprovedForTelegram } from './ops-runtime-config';
import { getProductionModelSymbols } from './production-model-resolver';
import { randomUUID } from 'node:crypto';

export interface RankedAssetItem {
  symbol: string;
  name: string;
  winRate: number;
  signal: 'CALL' | 'PUT';
  confidence: number;
  modelVersion: string;
  executionPlanId: string;
  horizonLabel: string;
  predictionTimestamp: number;
}

export interface LiveMarketRankingSnapshot {
  generatedAt: string;
  tickTimestamp: number;
  candidateCount: number;
  rankings: RankedAssetItem[];
  dataAgeMs: number;
  validationStatus: 'VALIDATED' | 'DEGRADED' | 'EXPIRED';
  modelVersion: string;
  featureSchemaVersion?: string;
}

function getInternalBaseUrl(): string {
  const configured = process.env.APP_URL || process.env.RENDER_BACKEND_URL;
  if (configured) return configured.replace(/\/$/, '');
  return `http://127.0.0.1:${process.env.PORT || '3000'}`;
}

function getLiveRankingConcurrency(): number {
  const configured = Number(process.env.LIVE_RANKING_MAX_CONCURRENCY);
  if (Number.isSafeInteger(configured) && configured > 0) return Math.min(8, Math.max(1, configured));
  return 4;
}

async function settleWithConcurrency<T>(
  items: readonly RiseFallSymbolMetadata[],
  worker: (item: RiseFallSymbolMetadata) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(items.length);
  let cursor = 0;
  const concurrency = Math.min(getLiveRankingConcurrency(), items.length);

  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => run()));
  return results;
}

function isValidConfidence(value: unknown): value is number {
  const confidence = Number(value);
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 100;
}

function isValidTimestamp(value: unknown): value is number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0;
}

function isValidPrediction(data: any, expectedSymbol: string): boolean {
  if (data?.success !== true || !data.prediction || !data.executionPlan) return false;
  if (String(data.prediction.symbol || '').toUpperCase() !== expectedSymbol) return false;
  if (data.prediction.signal !== 'CALL' && data.prediction.signal !== 'PUT') return false;
  if (!isValidConfidence(data.prediction.confidence)) return false;
  if (!String(data.prediction.modelVersion || '').trim()) return false;
  if (!String(data.executionPlan.executionPlanId || '').trim()) return false;
  if (data.executionPlan.horizonAligned !== true || data.executionPlan.strategyGateAccepted !== true) return false;
  if (!data.executionPlan.selectedHorizon?.label) return false;
  if (!isValidTimestamp(data.prediction.timestamp)) return false;
  return true;
}

/**
 * Performs a fresh server-side ranking request on every invocation.
 *
 * There is intentionally no in-memory snapshot, database snapshot, stale-result
 * fallback, synthetic score, model-version fallback, or cached ranking state here.
 * Each eligible Deriv instrument is evaluated through the authoritative signal API.
 */
export async function refreshLiveMarketRankings(
  onProgress?: (stage: 'data_stream' | 'ai_analysis' | 'target_locked') => Promise<void> | void,
): Promise<LiveMarketRankingSnapshot> {
  const discovered: RiseFallSymbolMetadata[] = await getLiveRiseFallSymbols(true, false);
  const governanceConfig = await getTelegramAssetGovernanceConfig();
  const productionSymbols = await getProductionModelSymbols();
  const eligible = discovered.filter(
    (item) =>
      item.isAvailable &&
      item.isOpen &&
      item.isRiseFallSupported &&
      isSymbolApprovedForTelegram(item.symbol, item.categoryKeys, governanceConfig) &&
      (productionSymbols.size === 0 || productionSymbols.has(item.symbol.toUpperCase())),
  );

  if (!eligible.length) throw new Error('MARKET_RANKINGS_NO_ELIGIBLE_SYMBOLS');
  if (onProgress) await onProgress('data_stream');
  if (onProgress) await onProgress('ai_analysis');

  const baseUrl = getInternalBaseUrl();
  const settled = await settleWithConcurrency(eligible, async (metadata) => {
    const correlationId = randomUUID();
    const response = await fetch(`${baseUrl}/api/signals/predict`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, max-age=0',
        Pragma: 'no-cache',
        'x-correlation-id': correlationId,
        'x-live-signal-request': 'true',
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

    const data = await response.json().catch(() => null);
    if (!response.ok || !isValidPrediction(data, metadata.symbol)) {
      throw new Error(`LIVE_SIGNAL_UNAVAILABLE:${metadata.symbol}`);
    }

    const confidence = Number(data.prediction.confidence);
    const modelVersion = String(data.prediction.modelVersion).trim();
    const executionPlanId = String(data.executionPlan.executionPlanId).trim();
    const signal = data.prediction.signal as 'CALL' | 'PUT';
    const predictionTimestamp = Number(data.prediction.timestamp);

    return {
      symbol: metadata.symbol,
      name: metadata.displayName,
      // Existing Telegram rendering expects this field. It is the live native
      // model confidence; it is not a historical empirical win-rate statistic.
      winRate: Math.round(confidence),
      signal,
      confidence,
      modelVersion,
      executionPlanId,
      horizonLabel: String(data.executionPlan.selectedHorizon.label),
      predictionTimestamp,
    } satisfies RankedAssetItem;
  });

  const rankings = settled
    .filter((result): result is PromiseFulfilledResult<RankedAssetItem> => result.status === 'fulfilled')
    .map((result) => result.value)
    .sort((a, b) => b.confidence - a.confidence);

  if (!rankings.length) throw new Error('MARKET_RANKINGS_INFERENCE_UNAVAILABLE');
  if (onProgress) await onProgress('target_locked');

  // Report the age of the oldest included live prediction so the freshness
  // indicator cannot overstate freshness when one asset responded later.
  const oldestPredictionTimestamp = Math.min(...rankings.map((item) => item.predictionTimestamp));
  const now = Date.now();
  const generatedAt = new Date(now).toISOString();

  return {
    generatedAt,
    tickTimestamp: oldestPredictionTimestamp,
    candidateCount: rankings.length,
    rankings,
    dataAgeMs: Math.max(0, now - oldestPredictionTimestamp),
    validationStatus: 'VALIDATED',
    modelVersion: rankings[0].modelVersion,
  };
}
