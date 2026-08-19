import { neon } from '@neondatabase/serverless';

type ObservabilitySeverity = 'debug' | 'info' | 'warn' | 'error' | 'critical';
type ObservabilityCategory = 'application' | 'trading' | 'ml' | 'api' | 'system' | 'security' | 'error';

function getSql() {
  const url = process.env.DATABASE_URL?.trim();
  return url ? neon(url) : null;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/(secret|token|password|authorization|cookie|credential|api[_-]?key|private[_-]?key)/i.test(key)) {
        result[key] = '[redacted]';
      } else {
        result[key] = sanitizeValue(item, depth + 1);
      }
    }
    return result;
  }
  if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}…[truncated]`;
  return value;
}

export async function ensureObservabilitySchema(): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS admin_observability_events (
        id BIGSERIAL PRIMARY KEY,
        category VARCHAR(30) NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'info',
        service VARCHAR(80),
        event_type VARCHAR(120) NOT NULL,
        message TEXT NOT NULL,
        request_id VARCHAR(120),
        correlation_id VARCHAR(120),
        symbol VARCHAR(80),
        model_id VARCHAR(120),
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_admin_obs_created_at ON admin_observability_events (created_at DESC);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_admin_obs_category ON admin_observability_events (category, created_at DESC);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_admin_obs_severity ON admin_observability_events (severity, created_at DESC);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_admin_obs_correlation ON admin_observability_events (correlation_id) WHERE correlation_id IS NOT NULL;`;

    await sql`
      CREATE TABLE IF NOT EXISTS admin_incidents (
        id BIGSERIAL PRIMARY KEY,
        fingerprint VARCHAR(128) NOT NULL UNIQUE,
        severity VARCHAR(20) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'open',
        title VARCHAR(240) NOT NULL,
        message TEXT NOT NULL,
        service VARCHAR(80),
        symbol VARCHAR(80),
        model_id VARCHAR(120),
        source_event_id BIGINT,
        metadata JSONB,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        acknowledged_at TIMESTAMPTZ,
        investigating_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_admin_incidents_status ON admin_incidents (status, severity, last_seen_at DESC);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_admin_incidents_service ON admin_incidents (service, last_seen_at DESC);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_admin_incidents_last_seen ON admin_incidents (last_seen_at DESC);`;
    return true;
  } catch (error) {
    console.error('[Observability schema error]:', error);
    return false;
  }
}

export async function recordObservabilityEvent(input: {
  category: ObservabilityCategory;
  severity?: ObservabilitySeverity;
  service?: string;
  eventType: string;
  message: string;
  requestId?: string;
  correlationId?: string;
  symbol?: string;
  modelId?: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  try {
    if (!(await ensureObservabilitySchema())) return false;
    await sql`
      INSERT INTO admin_observability_events
        (category, severity, service, event_type, message, request_id, correlation_id, symbol, model_id, metadata)
      VALUES
        (${input.category}, ${input.severity ?? 'info'}, ${input.service ?? null}, ${input.eventType},
         ${input.message.slice(0, 8000)}, ${input.requestId ?? null}, ${input.correlationId ?? null},
         ${input.symbol ?? null}, ${input.modelId ?? null}, ${JSON.stringify(sanitizeValue(input.metadata ?? {}))}::jsonb)
    `;
    return true;
  } catch (error) {
    console.error('[Observability write error]:', error);
    return false;
  }
}
