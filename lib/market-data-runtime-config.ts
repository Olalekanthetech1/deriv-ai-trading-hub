import os from 'os';

type MarketDataRuntimeConfig = {
  maxAssets: number | null;
  concurrency: number;
};

function optionalPositiveInteger(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`[Market Data Config] ${name} must be a positive safe integer.`);
  }
  return value;
}

export function getMarketDataRuntimeConfig(): MarketDataRuntimeConfig {
  const maxAssets = optionalPositiveInteger('MARKET_DATA_INGESTION_MAX_ASSETS');
  const configuredConcurrency = optionalPositiveInteger('MARKET_DATA_INGESTION_CONCURRENCY');
  const hostParallelism = Math.max(1, os.availableParallelism());

  return {
    maxAssets,
    concurrency: Math.max(1, Math.min(configuredConcurrency ?? hostParallelism, hostParallelism)),
  };
}
