import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/app/api/admin/auth/route';
import { ensureObservabilitySchema } from '@/lib/observability';
import { neon } from '@neondatabase/serverless';

type EventRow = {
  id: string | number;
  category: string;
  severity: string;
  service: string | null;
  eventType: string;
  message: string;
  requestId: string | null;
  correlationId: string | null;
  symbol: string | null;
  modelId: string | null;
  createdAt: string;
  source: string;
  metadata?: unknown;
};

function isAuthorized(req: NextRequest) {
  const cookie = req.cookies.get('admin_session_token')?.value;
  const header = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookie) || verifySessionToken(header);
}

function matchesFilters(row: EventRow, filters: { category: string; severity: string; service: string; symbol: string; model: string; q: string; since: number }) {
  const created = new Date(row.createdAt).getTime();
  if (filters.category !== 'all' && row.category !== filters.category) return false;
  if (filters.severity !== 'all' && row.severity !== filters.severity) return false;
  if (filters.service !== 'all' && (row.service ?? '').toLowerCase() !== filters.service.toLowerCase()) return false;
  if (filters.symbol && !(row.symbol ?? '').toLowerCase().includes(filters.symbol.toLowerCase())) return false;
  if (filters.model && !(row.modelId ?? '').toLowerCase().includes(filters.model.toLowerCase())) return false;
  if (filters.q) {
    const haystack = [row.eventType, row.message, row.service, row.symbol, row.modelId, row.requestId, row.correlationId].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(filters.q.toLowerCase())) return false;
  }
  return created >= filters.since;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const range = url.searchParams.get('range') ?? '24h';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 10), 300);
  const category = url.searchParams.get('category') ?? 'all';
  const severity = url.searchParams.get('severity') ?? 'all';
  const service = url.searchParams.get('service') ?? 'all';
  const symbol = url.searchParams.get('symbol') ?? '';
  const model = url.searchParams.get('model') ?? '';
  const q = url.searchParams.get('q') ?? '';
  const rangeMs = range === '7d' ? 7 * 86400000 : range === '30d' ? 30 * 86400000 : 86400000;
  const since = Date.now() - rangeMs;

  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) {
    return NextResponse.json({
      ok: true,
      available: false,
      events: [],
      coverage: { persistedEvents: 'UNAVAILABLE', tradingLogs: 'UNAVAILABLE', mlLogs: 'UNAVAILABLE', modelRegistry: 'UNAVAILABLE', applicationApi: 'UNAVAILABLE' },
      summary: { total: 0, errors: 0, warnings: 0, critical: 0 },
    });
  }

  const sql = neon(dbUrl);
  const filters = { category, severity, service, symbol, model, q, since };
  const events: EventRow[] = [];
  let persistedEventReadSucceeded = false;
  let mlLogReadSucceeded = false;
  let tradingLogReadSucceeded = false;
  let modelRegistryReadSucceeded = false;

  try {
    if (await ensureObservabilitySchema()) {
      const rows = await sql`
        SELECT id, category, severity, service, event_type, message, request_id, correlation_id,
               symbol, model_id, metadata, created_at
        FROM admin_observability_events
        WHERE created_at >= ${new Date(since).toISOString()}
        ORDER BY created_at DESC
        LIMIT 300
      `;
      persistedEventReadSucceeded = true;
      for (const row of rows as any[]) {
        events.push({
          id: row.id,
          category: row.category,
          severity: row.severity,
          service: row.service,
          eventType: row.event_type,
          message: row.message,
          requestId: row.request_id,
          correlationId: row.correlation_id,
          symbol: row.symbol,
          modelId: row.model_id,
          metadata: row.metadata,
          createdAt: new Date(row.created_at).toISOString(),
          source: 'observability_events',
        });
      }
    }
  } catch (error) {
    console.error('[Observability read events error]:', error);
  }

  try {
    const rows = await sql`
      SELECT id, symbol, samples_count, train_accuracy, val_accuracy, log_message, created_at
      FROM ml_training_logs
      WHERE created_at >= ${new Date(since).toISOString()}
      ORDER BY created_at DESC LIMIT 150
    `;
    mlLogReadSucceeded = rows.length > 0;
    for (const row of rows as any[]) {
      events.push({
        id: `ml-${row.id}`,
        category: 'ml',
        severity: Number(row.val_accuracy) > 0 ? 'info' : 'warn',
        service: 'ml-training',
        eventType: 'training_log',
        message: row.log_message || `Training run recorded for ${row.symbol}`,
        requestId: null,
        correlationId: null,
        symbol: row.symbol,
        modelId: null,
        createdAt: new Date(row.created_at).toISOString(),
        source: 'ml_training_logs',
        metadata: { samples: row.samples_count, trainAccuracy: row.train_accuracy, validationAccuracy: row.val_accuracy },
      });
    }
  } catch (error) {
    console.warn('[Observability ml logs unavailable]:', error);
  }

  try {
    const rows = await sql`
      SELECT id, asset_symbol, contract_type, status, model_id, metadata, executed_at
      FROM execution_trades
      WHERE executed_at >= ${new Date(since).toISOString()}
      ORDER BY executed_at DESC LIMIT 150
    `;
    tradingLogReadSucceeded = rows.length > 0;
    for (const row of rows as any[]) {
      const status = String(row.status ?? '').toLowerCase();
      const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      const strategy = meta.strategy || 'strategy not recorded';
      const confidence = meta.prediction_confidence ?? null;
      events.push({
        id: `trade-${row.id}`,
        category: 'trading',
        severity: ['error', 'failed', 'rejected'].includes(status) ? 'error' : 'info',
        service: 'trading',
        eventType: 'execution',
        message: `Trade ${status || 'recorded'} · ${row.contract_type || 'contract'} · ${strategy}`,
        requestId: null,
        correlationId: null,
        symbol: row.asset_symbol,
        modelId: row.model_id || null,
        createdAt: new Date(row.executed_at).toISOString(),
        source: 'execution_trades',
        metadata: { status: row.status, confidence },
      });
    }
  } catch (error) {
    console.warn('[Observability trading logs unavailable]:', error);
  }

  try {
    const rows = await sql`
      SELECT id, model_id, model_family, version, asset_symbol, status, metrics, updated_at
      FROM ml_model_registry_v2
      WHERE updated_at >= ${new Date(since).toISOString()}
      ORDER BY updated_at DESC LIMIT 150
    `;
    modelRegistryReadSucceeded = rows.length > 0;
    for (const row of rows as any[]) {
      const metrics = row.metrics && typeof row.metrics === 'object' ? row.metrics : {};
      const accuracy = metrics.accuracy ?? metrics.overallAccuracy ?? null;
      events.push({
        id: `model-${row.id}`,
        category: 'ml',
        severity: ['failed', 'error'].includes(String(row.status).toLowerCase()) ? 'error' : 'info',
        service: 'model-registry',
        eventType: 'model_registry_change',
        message: `${row.model_family || row.model_id} ${row.version || ''} · status ${row.status}`,
        requestId: null,
        correlationId: null,
        symbol: row.asset_symbol,
        modelId: row.model_id,
        createdAt: new Date(row.updated_at).toISOString(),
        source: 'ml_model_registry_v2',
        metadata: { accuracy, version: row.version, status: row.status },
      });
    }
  } catch (error) {
    console.warn('[Observability model registry unavailable]:', error);
  }

  const applicationApiEvents = events.filter((event) => event.source === 'observability_events' && (event.category === 'application' || event.category === 'api'));
  const coverage = {
    persistedEvents: persistedEventReadSucceeded ? 'AVAILABLE' : 'UNAVAILABLE',
    tradingLogs: tradingLogReadSucceeded ? 'AVAILABLE' : 'UNAVAILABLE',
    mlLogs: mlLogReadSucceeded ? 'AVAILABLE' : 'UNAVAILABLE',
    modelRegistry: modelRegistryReadSucceeded ? 'AVAILABLE' : 'UNAVAILABLE',
    applicationApi: applicationApiEvents.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE',
  } as const;

  const filtered = events
    .filter(event => matchesFilters(event, filters))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);

  const summary = {
    total: filtered.length,
    errors: filtered.filter(e => e.severity === 'error').length,
    warnings: filtered.filter(e => e.severity === 'warn').length,
    critical: filtered.filter(e => e.severity === 'critical').length,
  };

  return NextResponse.json({
    ok: true,
    available: true,
    generatedAt: new Date().toISOString(),
    range,
    events: filtered,
    coverage,
    summary,
    note: 'Only persisted or explicitly instrumented telemetry is displayed. Missing telemetry is reported as unavailable rather than fabricated.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
