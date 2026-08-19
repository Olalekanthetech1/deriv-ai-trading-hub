import { Redis } from '@upstash/redis';
import { getDb } from '@/lib/db';
import { mlRuntimeClient } from '@/lib/ml-runtime-client';

let redisClient: Redis | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    redisClient = Redis.fromEnv();
  } catch (err) {}
}

let inMemoryBlocks = 0;

export async function incrementRateLimitBlock() {
  if (redisClient) {
    try {
      await redisClient.incr('rate_limit_blocks');
    } catch {}
  } else {
    inMemoryBlocks++;
  }
}

export async function getRateLimitBlocks() {
  if (redisClient) {
    try {
      const blocks = await redisClient.get('rate_limit_blocks');
      return Number(blocks) || 0;
    } catch {
      return inMemoryBlocks;
    }
  }
  return inMemoryBlocks;
}

export async function checkDbStatus() {
  try {
    const sql = getDb();
    if (!sql) return false;
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function getSystemHealthCheck() {
  const health: any = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      database: 'unknown',
      dbLatencyMs: null,
      pythonRuntime: 'unknown',
      runtimeLatencyMs: null,
    },
    env: {
      databaseUrlSet: !!process.env.DATABASE_URL,
      derivAppIdSet: !!process.env.NEXT_PUBLIC_DERIV_APP_ID,
    }
  };

  try {
    const db = getDb();
    if (db) {
      const dbQueryStart = Date.now();
      await db`SELECT 1`;
      health.services.dbLatencyMs = Date.now() - dbQueryStart;
      health.services.database = 'connected';
    } else {
      health.services.database = 'disconnected';
      health.status = 'degraded';
    }
  } catch (err) {
    health.services.database = 'error';
    health.status = 'degraded';
  }

  try {
    const runtimeStart = Date.now();
    const pingRes = await mlRuntimeClient.sendCommand('ping');
    health.services.runtimeLatencyMs = Date.now() - runtimeStart;
    if (pingRes && pingRes.success) {
      health.services.pythonRuntime = 'connected';
    } else {
      health.services.pythonRuntime = 'error';
      health.status = 'degraded';
    }
  } catch (err) {
    health.services.pythonRuntime = 'error';
    health.status = 'degraded';
  }

  return health;
}
