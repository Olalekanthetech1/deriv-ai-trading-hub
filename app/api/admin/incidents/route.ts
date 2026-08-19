import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { ensureObservabilitySchema, recordObservabilityEvent } from '@/lib/observability';
import { verifySessionToken } from '@/app/api/admin/auth/route';
import { canTransitionIncident, normalizeIncidentStatus, type IncidentStatus } from '@/lib/incident-lifecycle';

function authorized(req: NextRequest) {
  const cookie = req.cookies.get('admin_session_token')?.value;
  const header = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookie) || verifySessionToken(header);
}

async function syncRecentIncidents(sql: NeonQueryFunction<false, false>) {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const rows = await sql`
    SELECT id, category, severity, service, event_type, message, symbol, model_id, metadata, created_at
    FROM admin_observability_events
    WHERE created_at >= ${since}
      AND severity IN ('critical', 'error', 'warn')
    ORDER BY created_at DESC
    LIMIT 200
  `;

  for (const row of rows as any[]) {
    // Generate deterministic MD5 fingerprint in Node.js to avoid PostgreSQL variable type inference issues
    const parts = [
      row.category || '',
      row.service || '',
      row.event_type || '',
      row.message || '',
      row.symbol || '',
      row.model_id || '',
    ];
    const fingerprint = crypto.createHash('md5').update(parts.join('|')).digest('hex');
    if (!fingerprint) continue;

    const sourceEventId = Number(row.id) || null;
    const metaJson = JSON.stringify(row.metadata ?? {});

    await sql`
      INSERT INTO admin_incidents
        (fingerprint, severity, status, title, message, service, symbol, model_id, source_event_id, metadata, first_seen_at, last_seen_at, updated_at)
      VALUES
        (${fingerprint}, ${row.severity}, 'open', ${row.event_type}, ${row.message}, ${row.service ?? null}, ${row.symbol ?? null}, ${row.model_id ?? null}, ${sourceEventId}, ${metaJson}::jsonb, ${row.created_at}, ${row.created_at}, NOW())
      ON CONFLICT (fingerprint) DO UPDATE SET
        severity = EXCLUDED.severity,
        title = EXCLUDED.title,
        message = EXCLUDED.message,
        service = EXCLUDED.service,
        symbol = EXCLUDED.symbol,
        model_id = EXCLUDED.model_id,
        source_event_id = EXCLUDED.source_event_id,
        metadata = EXCLUDED.metadata,
        last_seen_at = EXCLUDED.last_seen_at,
        updated_at = NOW(),
        status = CASE WHEN admin_incidents.status = 'resolved' THEN 'open' ELSE admin_incidents.status END,
        resolved_at = CASE WHEN admin_incidents.status = 'resolved' THEN NULL ELSE admin_incidents.resolved_at END
    `;
  }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) return NextResponse.json({ ok: true, available: false, incidents: [], summary: { open: 0, acknowledged: 0, investigating: 0, resolved: 0 } });

  try {
    if (!(await ensureObservabilitySchema())) return NextResponse.json({ error: 'Incident storage is unavailable.' }, { status: 503 });
    const sql = neon(dbUrl);
    await syncRecentIncidents(sql);

    const url = new URL(req.url);
    const status = url.searchParams.get('status') ?? 'active';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 10), 200);
    const rows = status === 'active'
      ? await sql`SELECT id, fingerprint, severity, status, title, message, service, symbol, model_id, source_event_id, metadata, first_seen_at, last_seen_at, acknowledged_at, investigating_at, resolved_at, updated_at FROM admin_incidents WHERE status <> 'resolved' ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'error' THEN 2 ELSE 3 END, last_seen_at DESC LIMIT ${limit}`
      : await sql`SELECT id, fingerprint, severity, status, title, message, service, symbol, model_id, source_event_id, metadata, first_seen_at, last_seen_at, acknowledged_at, investigating_at, resolved_at, updated_at FROM admin_incidents WHERE status = ${status} ORDER BY last_seen_at DESC LIMIT ${limit}`;

    const summaryRows = await sql`SELECT status, count(*)::int AS count FROM admin_incidents GROUP BY status`;
    const summary = { open: 0, acknowledged: 0, investigating: 0, resolved: 0 };
    for (const row of summaryRows as any[]) {
      const key = normalizeIncidentStatus(row.status);
      if (key) summary[key] = Number(row.count) || 0;
    }
    return NextResponse.json({ ok: true, available: true, generatedAt: new Date().toISOString(), incidents: rows, summary }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Incident API GET]', error);
    return NextResponse.json({ error: 'Unable to load incident state.' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) return NextResponse.json({ error: 'Incident storage is unavailable.' }, { status: 503 });

  try {
    if (!(await ensureObservabilitySchema())) return NextResponse.json({ error: 'Incident storage is unavailable.' }, { status: 503 });
    const body = await req.json().catch(() => ({}));
    const id = Number(body.id);
    const nextStatus = normalizeIncidentStatus(body.status);
    if (!Number.isSafeInteger(id) || id <= 0 || !nextStatus) return NextResponse.json({ error: 'Valid incident id and status are required.' }, { status: 400 });

    const sql = neon(dbUrl);
    const currentRows = await sql`SELECT id, severity, status, title, service, symbol, model_id FROM admin_incidents WHERE id = ${id} LIMIT 1`;
    if (!currentRows.length) return NextResponse.json({ error: 'Incident not found.' }, { status: 404 });
    const current = currentRows[0] as any;
    const currentStatus = normalizeIncidentStatus(current.status);
    if (!currentStatus || !canTransitionIncident(currentStatus, nextStatus)) return NextResponse.json({ error: `Invalid incident transition: ${current.status} → ${nextStatus}.` }, { status: 409 });

    const acknowledgedAt = nextStatus === 'acknowledged' && currentStatus === 'open' ? new Date().toISOString() : null;
    const investigatingAt = nextStatus === 'investigating' ? new Date().toISOString() : null;
    const resolvedAt = nextStatus === 'resolved' ? new Date().toISOString() : null;

    await sql`
      UPDATE admin_incidents
      SET status = ${nextStatus},
          acknowledged_at = CASE WHEN ${nextStatus} = 'acknowledged' AND acknowledged_at IS NULL THEN ${acknowledgedAt}::timestamptz ELSE acknowledged_at END,
          investigating_at = CASE WHEN ${nextStatus} = 'investigating' AND investigating_at IS NULL THEN ${investigatingAt}::timestamptz ELSE investigating_at END,
          resolved_at = CASE WHEN ${nextStatus} = 'resolved' THEN ${resolvedAt}::timestamptz WHEN ${nextStatus} = 'open' THEN NULL ELSE resolved_at END,
          updated_at = NOW()
      WHERE id = ${id}
    `;

    await recordObservabilityEvent({
      category: 'security',
      severity: 'info',
      service: 'admin-incident-center',
      eventType: 'incident_status_changed',
      message: `Incident ${id} transitioned from ${currentStatus} to ${nextStatus}.`,
      symbol: current.symbol ?? undefined,
      modelId: current.model_id ?? undefined,
      metadata: { incidentId: id, from: currentStatus, to: nextStatus, title: current.title, severity: current.severity },
    });

    return NextResponse.json({ ok: true, id, status: nextStatus });
  } catch (error) {
    console.error('[Incident API PATCH]', error);
    return NextResponse.json({ error: 'Unable to update incident state.' }, { status: 500 });
  }
}
