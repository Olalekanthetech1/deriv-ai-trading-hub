import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Process-local limiter used for high-frequency telemetry and as a fail-safe fallback
// when the distributed limiter is unavailable. This is intentionally bounded and expiring.
const memoryStore = new Map<string, { count: number; resetAt: number }>();
const MAX_MEMORY_KEYS = 10_000;
const DISTRIBUTED_RETRY_COOLDOWN_MS = 30_000;
let distributedRetryAt = 0;
export let inMemoryBlocks = 0;

function pruneMemoryStore(now: number) {
  if (memoryStore.size < MAX_MEMORY_KEYS) return;

  for (const [key, record] of memoryStore) {
    if (record.resetAt < now) memoryStore.delete(key);
    if (memoryStore.size < MAX_MEMORY_KEYS * 0.8) break;
  }
}

function getInMemoryRateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const record = memoryStore.get(key);

  if (!record || record.resetAt <= now) {
    pruneMemoryStore(now);
    memoryStore.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, limit, remaining: Math.max(0, limit - 1), reset: now + windowMs };
  }

  if (record.count >= limit) {
    inMemoryBlocks++;
    return { success: false, limit, remaining: 0, reset: record.resetAt };
  }

  record.count += 1;
  return { success: true, limit, remaining: Math.max(0, limit - record.count), reset: record.resetAt };
}

export let redisClient: Redis | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    redisClient = Redis.fromEnv();
  } catch (err) {
    console.warn('Failed to initialize Upstash Redis, falling back to in-memory.', err);
  }
}

// Do not perform another Redis request when Redis is already the failing dependency.
// Persistent block metrics can be recorded asynchronously by a dedicated observability path.
export async function incrementRedisBlock() {
  inMemoryBlocks++;
}

const mlRatelimit = redisClient
  ? new Ratelimit({
      redis: redisClient,
      limiter: Ratelimit.slidingWindow(300, '1 m'),
      ephemeralCache: new Map(),
    })
  : null;

const apiRatelimit = redisClient
  ? new Ratelimit({
      redis: redisClient,
      limiter: Ratelimit.slidingWindow(600, '1 m'),
      ephemeralCache: new Map(),
    })
  : null;

const authRatelimit = redisClient
  ? new Ratelimit({
      redis: redisClient,
      limiter: Ratelimit.slidingWindow(10, '1 m'),
      ephemeralCache: new Map(),
    })
  : null;

const wsRatelimit = redisClient
  ? new Ratelimit({
      redis: redisClient,
      limiter: Ratelimit.slidingWindow(3000, '1 m'),
      ephemeralCache: new Map(),
    })
  : null;

const limits = {
  ml: 300,
  api: 600,
  auth: 10,
  ws: 3000,
  telemetry: 120,
} as const;

export type RateLimitType = keyof typeof limits;

function getMemoryLimit(key: string, type: RateLimitType) {
  return getInMemoryRateLimit(key, limits[type], 60_000);
}

export async function checkRateLimit(key: string, type: RateLimitType = 'api') {
  // Telemetry/status polling is intentionally local. It can be called every few seconds and
  // must not consume the Upstash request budget needed by security-sensitive traffic.
  if (type === 'telemetry') {
    return getMemoryLimit(key, type);
  }

  const limiter = type === 'ml'
    ? mlRatelimit
    : type === 'auth'
      ? authRatelimit
      : type === 'ws'
        ? wsRatelimit
        : apiRatelimit;

  if (!limiter) return getMemoryLimit(key, type);

  const now = Date.now();
  if (now < distributedRetryAt) {
    return getMemoryLimit(key, type);
  }

  try {
    return await limiter.limit(key);
  } catch (error) {
    // Upstash quota/network failures must never turn the API gateway into a 500 generator.
    // Temporarily stop probing Redis so a quota incident does not create a second request storm.
    distributedRetryAt = now + DISTRIBUTED_RETRY_COOLDOWN_MS;
    console.warn('Distributed rate limiter unavailable; using local fallback for 30s.', error);
    return getMemoryLimit(key, type);
  }
}
