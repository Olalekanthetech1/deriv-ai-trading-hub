import { Redis } from '@upstash/redis';

export interface OnlineLearningModelState {
  wins: number;
  losses: number;
  total: number;
  accuracy: number;
}

export interface OnlineLearningState {
  models: Record<string, OnlineLearningModelState>;
  source: 'upstash-redis' | 'process-memory';
}

const REDIS_KEY = 'ml:online-learning:v2';
const MODEL_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

type MemoryState = Record<string, OnlineLearningModelState>;

const globalState = globalThis as typeof globalThis & {
  __mlOnlineLearningState?: MemoryState;
};

globalState.__mlOnlineLearningState ??= {};

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function validateModelKey(modelKey: string): string {
  const normalized = modelKey.trim();
  if (!MODEL_KEY_PATTERN.test(normalized)) {
    throw new Error('Invalid modelKey');
  }
  return normalized;
}

function emptyState(): OnlineLearningModelState {
  return { wins: 0, losses: 0, total: 0, accuracy: 0 };
}

function normalizeStats(wins: number, losses: number): OnlineLearningModelState {
  const safeWins = Number.isFinite(wins) && wins >= 0 ? Math.floor(wins) : 0;
  const safeLosses = Number.isFinite(losses) && losses >= 0 ? Math.floor(losses) : 0;
  const total = safeWins + safeLosses;
  return {
    wins: safeWins,
    losses: safeLosses,
    total,
    accuracy: total > 0 ? Number(((safeWins / total) * 100).toFixed(3)) : 0,
  };
}

function memorySnapshot(): OnlineLearningState {
  const models = Object.fromEntries(
    Object.entries(globalState.__mlOnlineLearningState ?? {}).map(([key, value]) => [
      key,
      normalizeStats(value.wins, value.losses),
    ]),
  );
  return { models, source: 'process-memory' };
}

export async function getOnlineLearningState(): Promise<OnlineLearningState> {
  const redis = getRedis();
  if (!redis) return memorySnapshot();

  try {
    const raw = await redis.hgetall<Record<string, string>>(REDIS_KEY);
    const models: Record<string, OnlineLearningModelState> = {};

    for (const [field, value] of Object.entries(raw ?? {})) {
      const separator = field.lastIndexOf(':');
      if (separator <= 0) continue;
      const modelKey = field.slice(0, separator);
      const metric = field.slice(separator + 1);
      if (!MODEL_KEY_PATTERN.test(modelKey) || (metric !== 'wins' && metric !== 'losses')) continue;

      const current = models[modelKey] ?? emptyState();
      const parsed = Number(value);
      if (metric === 'wins') current.wins = Number.isFinite(parsed) ? parsed : 0;
      else current.losses = Number.isFinite(parsed) ? parsed : 0;
      models[modelKey] = normalizeStats(current.wins, current.losses);
    }

    return { models, source: 'upstash-redis' };
  } catch (error) {
    console.error('[ML Online Learning] Redis read failed; using process memory:', error);
    return memorySnapshot();
  }
}

export async function recordModelOutcome(modelKey: string, wasCorrect: boolean): Promise<OnlineLearningModelState> {
  const key = validateModelKey(modelKey);
  const redis = getRedis();

  if (!redis) {
    const state = globalState.__mlOnlineLearningState!;
    const current = state[key] ?? emptyState();
    if (wasCorrect) current.wins += 1;
    else current.losses += 1;
    current.total = current.wins + current.losses;
    current.accuracy = current.total > 0 ? Number(((current.wins / current.total) * 100).toFixed(3)) : 0;
    state[key] = current;
    return current;
  }

  try {
    const field = `${key}:${wasCorrect ? 'wins' : 'losses'}`;
    await redis.hincrby(REDIS_KEY, field, 1);
    const rawWins = await redis.hget<string>(REDIS_KEY, `${key}:wins`);
    const rawLosses = await redis.hget<string>(REDIS_KEY, `${key}:losses`);
    return normalizeStats(Number(rawWins ?? 0), Number(rawLosses ?? 0));
  } catch (error) {
    console.error('[ML Online Learning] Redis write failed; using process memory:', error);
    return recordModelOutcomeMemory(key, wasCorrect);
  }
}

function recordModelOutcomeMemory(key: string, wasCorrect: boolean): OnlineLearningModelState {
  const state = globalState.__mlOnlineLearningState!;
  const current = state[key] ?? emptyState();
  if (wasCorrect) current.wins += 1;
  else current.losses += 1;
  current.total = current.wins + current.losses;
  current.accuracy = current.total > 0 ? Number(((current.wins / current.total) * 100).toFixed(3)) : 0;
  state[key] = current;
  return current;
}

export async function resetOnlineLearningStats(): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(REDIS_KEY);
    } catch (error) {
      console.error('[ML Online Learning] Redis reset failed; clearing process memory:', error);
    }
  }

  globalState.__mlOnlineLearningState = {};
}
