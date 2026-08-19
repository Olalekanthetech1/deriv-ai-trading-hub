import os from 'os';
import { getQueueWorkerRuntimeConfig } from './ops-runtime-config';

type DatasetBuildRuntimeConfig = {
  maxAssets: number | null;
  concurrency: number;
  pollIntervalMs: number;
  isPaused?: boolean;
};

function optionalPositiveInteger(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`[Dataset Build Config] ${name} must be a positive safe integer.`);
  return value;
}

function requiredPositiveInteger(name: string, fallback = 2): number {
  const value = optionalPositiveInteger(name);
  if (value === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`[Dataset Build Config] ${name} is required.`);
  }
  return value;
}

export function getDatasetBuildRuntimeConfig(): DatasetBuildRuntimeConfig {
  const configuredMaxAssets = optionalPositiveInteger('DATASET_BUILD_MAX_ASSETS');
  const trainingConcurrency = requiredPositiveInteger('ML_TRAINING_CONCURRENCY', 2);
  const pollIntervalMs = requiredPositiveInteger('DATASET_BUILD_POLL_INTERVAL_MS', 1500);
  const hostParallelism = Math.max(1, os.availableParallelism());
  return {
    maxAssets: configuredMaxAssets,
    concurrency: Math.max(1, Math.min(trainingConcurrency, hostParallelism)),
    pollIntervalMs,
  };
}

export async function getDynamicDatasetBuildRuntimeConfig(): Promise<DatasetBuildRuntimeConfig> {
  const base = getDatasetBuildRuntimeConfig();
  try {
    const dynamicConfig = await getQueueWorkerRuntimeConfig();
    const hostParallelism = Math.max(1, os.availableParallelism());
    return {
      maxAssets: base.maxAssets,
      concurrency: dynamicConfig.isPaused ? 0 : Math.max(1, Math.min(dynamicConfig.concurrencyLimit, hostParallelism)),
      pollIntervalMs: base.pollIntervalMs,
      isPaused: dynamicConfig.isPaused,
    };
  } catch {
    return base;
  }
}

