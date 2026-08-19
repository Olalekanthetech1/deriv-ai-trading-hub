import { neon } from '@neondatabase/serverless';
import { NextRequest, NextResponse } from 'next/server';
import { getSystemHealthCheck } from '@/lib/health';

export const dynamic = 'force-dynamic';

function pick(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) if (key in record) return record[key];
  return undefined;
}

function statusFrom(value: unknown): 'healthy' | 'degraded' | 'unavailable' {
  if (value === true) return 'healthy';
  if (value === false || value === null) return 'unavailable';
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (['ok', 'healthy', 'connected', 'ready', 'operational', 'up'].includes(normalized)) return 'healthy';
    if (['degraded', 'warning', 'partial'].includes(normalized)) return 'degraded';
    if (['down', 'offline', 'unavailable', 'error', 'failed'].includes(normalized)) return 'unavailable';
  }
  return 'unavailable';
}

async function probeDatabase() {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
  if (!databaseUrl) {
    return {
      status: 'unavailable' as const,
      configured: false,
      source: 'environment-missing',
      latencyMs: null as number | null,
      error: 'No PostgreSQL connection URL is configured.',
    };
  }

  const startedAt = performance.now();
  try {
    const sql = neon(databaseUrl);
    await sql`SELECT 1 AS ok`;
    return {
      status: 'healthy' as const,
      configured: true,
      source: 'live-postgresql-probe',
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: null as string | null,
    };
  } catch (error) {
    return {
      status: 'unavailable' as const,
      configured: true,
      source: 'live-postgresql-probe',
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: error instanceof Error ? error.message : 'Database connection probe failed.',
    };
  }
}

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  const cookie = request.headers.get('cookie') || '';

  let health: Record<string, unknown> = {};
  let healthHttpStatus = 0;
  let healthError: string | null = null;

  try {
    health = await getSystemHealthCheck();
    healthHttpStatus = health?.status === 'healthy' ? 200 : 503;
  } catch (error) {
    healthError = error instanceof Error ? error.message : 'Health check failed.';
  }

  const healthPayload = pick(health, ['health', 'data', 'status']) as Record<string, unknown> | undefined;
  const source = healthPayload && typeof healthPayload === 'object' ? { ...health, ...healthPayload } : health;

  const databaseValue = pick(source, ['database', 'db', 'databaseStatus', 'dbStatus', 'isDbConnected']);
  const mlValue = pick(source, ['ml', 'mlRuntime', 'mlService', 'pythonMl', 'pythonMLService']);
  const websocketValue = pick(source, ['websocket', 'webSocket', 'derivWebSocket', 'derivConnection']);

  const databaseProbe = await probeDatabase();
  const databaseHealthStatus = statusFrom(typeof databaseValue === 'object' ? pick(databaseValue, ['status', 'connected', 'healthy']) : databaseValue);
  const databaseStatus = databaseProbe.configured ? databaseProbe.status : databaseHealthStatus;

  const apiStatus = healthError ? 'unavailable' : healthHttpStatus >= 500 ? 'unavailable' : healthHttpStatus >= 400 ? 'degraded' : 'healthy';
  const mlStatus = statusFrom(typeof mlValue === 'object' ? pick(mlValue, ['status', 'available', 'healthy', 'ready']) : mlValue);
  const websocketStatus = statusFrom(typeof websocketValue === 'object' ? pick(websocketValue, ['status', 'connected', 'healthy', 'ready']) : websocketValue);

  const hasMlServiceUrl = Boolean(process.env.PYTHON_ML_SERVICE_URL);
  const hasCronSecret = Boolean(process.env.CRON_SECRET);

  return NextResponse.json({
    success: true,
    generatedAt: new Date().toISOString(),
    source: 'live-runtime',
    api: {
      status: apiStatus,
      httpStatus: healthHttpStatus || null,
      healthRttMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: healthError,
    },
    database: {
      status: databaseStatus,
      configured: databaseProbe.configured,
      source: databaseProbe.source,
      latencyMs: databaseProbe.latencyMs,
      error: databaseProbe.error,
      healthEndpointStatus: databaseHealthStatus,
    },
    mlRuntime: {
      status: mlStatus,
      configured: hasMlServiceUrl,
      source: mlValue === undefined ? 'unavailable-from-health' : 'health-endpoint',
    },
    websocket: {
      status: websocketStatus,
      source: websocketValue === undefined ? 'unavailable-from-health' : 'health-endpoint',
    },
    cron: {
      status: hasCronSecret ? 'configured' : 'not-configured',
      scheduleSource: 'environment',
      nextRun: null,
    },
    process: {
      status: 'healthy',
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      memory: process.memoryUsage(),
    },
    health: source,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
