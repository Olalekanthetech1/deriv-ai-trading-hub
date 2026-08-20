import { NextRequest, NextResponse } from 'next/server';
import { getDb, initDbSchema } from '@/lib/db';
import { verifySessionToken } from '../auth/route';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  if (verifySessionToken(cookieToken) === true) return true;

  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(headerToken) === true;
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim())));
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });

  try {
    if (!(await initDbSchema())) return NextResponse.json({ success: false, error: 'Model registry database is unavailable.' }, { status: 503 });
    const sql = getDb();
    if (!sql) return NextResponse.json({ success: false, error: 'Database unavailable.' }, { status: 503 });

    const rows = await sql`
      SELECT model_id, model_family, version, asset_symbol, asset_class, horizon_ticks, status,
             training_run_id, metrics, created_at, updated_at
      FROM ml_model_registry_v2
      WHERE LOWER(status) IN ('candidate', 'staging')
      ORDER BY updated_at DESC
    `;

    return NextResponse.json({ success: true, count: rows.length, models: rows, policy: 'Only candidate/staging models are eligible. Production models are never returned for cleanup.', dataSource: 'live-database' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Failed to load cleanup candidates.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthValid(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });

  try {
    if (!(await initDbSchema())) return NextResponse.json({ success: false, error: 'Model registry database is unavailable.' }, { status: 503 });
    const sql = getDb();
    if (!sql) return NextResponse.json({ success: false, error: 'Database unavailable.' }, { status: 503 });

    const body = await req.json().catch(() => ({}));
    const confirm = body.confirm === true;
    const purgeMissingArtifacts = body.purgeMissingArtifacts === true;
    const force = body.force === true;

    if (!confirm) return NextResponse.json({ success: false, error: 'Explicit confirmation is required for destructive model cleanup.' }, { status: 400 });

    if (purgeMissingArtifacts) {
      // Find candidate models without active binary artifacts
      const candidatesWithoutArtifacts = await sql`
        SELECT m.model_id
        FROM ml_model_registry_v2 m
        WHERE LOWER(m.status) IN ('candidate', 'staging')
          AND NOT EXISTS (
            SELECT 1 FROM ml_model_artifacts a
            WHERE a.model_id = m.model_id
              AND a.artifact_status IN ('active', 'superseded')
          )
      `;

      if (!candidatesWithoutArtifacts.length) {
        return NextResponse.json({ success: true, message: 'No candidate models without artifacts were found. All candidates have valid binary files.', deletedCount: 0 });
      }

      const idsToPurge = candidatesWithoutArtifacts.map((r: any) => String(r.model_id));

      // Clean selection events if force or purge
      await sql`DELETE FROM ops_model_selection_events WHERE selected_model_id = ANY(${idsToPurge})`;

      const deleted = await sql`
        DELETE FROM ml_model_registry_v2
        WHERE model_id = ANY(${idsToPurge})
          AND LOWER(status) IN ('candidate', 'staging')
        RETURNING model_id
      `;

      return NextResponse.json({
        success: true,
        message: `Successfully purged ${deleted.length} candidate models that lacked binary artifacts.`,
        deletedCount: deleted.length,
        deletedModelIds: deleted.map((r: any) => r.model_id),
      });
    }

    const modelIds = normalizeIds(body.modelIds);
    const purgeAllCandidates = body.purgeAllCandidates === true;

    if (purgeAllCandidates) {
      // Find all candidate & staging models
      const eligibleRows = await sql`
        SELECT model_id FROM ml_model_registry_v2
        WHERE LOWER(status) IN ('candidate', 'staging')
      `;

      if (!eligibleRows.length) {
        return NextResponse.json({ success: true, message: 'No candidate or staging models found to clean.', deletedCount: 0 });
      }

      const allCandidateIds = eligibleRows.map((r: any) => String(r.model_id));

      if (force) {
        await sql`DELETE FROM ops_model_selection_events WHERE selected_model_id = ANY(${allCandidateIds})`;
      } else {
        await sql`DELETE FROM ops_model_selection_events WHERE selected_model_id = ANY(${allCandidateIds})`;
      }

      const deleted = await sql`
        DELETE FROM ml_model_registry_v2
        WHERE LOWER(status) IN ('candidate', 'staging')
        RETURNING model_id
      `;

      // Log bulk audit event
      await sql`
        INSERT INTO ops_audit_events (category, severity, actor, action, resource_type, resource_id, metadata)
        VALUES ('model_operations', 'warning', 'admin', 'admin_bulk_candidate_purge', 'ml_model_registry_v2', 'bulk', ${JSON.stringify({ count: deleted.length })})
      `;

      return NextResponse.json({
        success: true,
        message: `Successfully purged all ${deleted.length} candidate/staging models.`,
        deletedCount: deleted.length,
        preservedTrainingHistory: true,
        externalArtifactsDeleted: false
      });
    }

    if (!modelIds.length) return NextResponse.json({ success: false, error: 'At least one modelId is required.' }, { status: 400 });
    if (modelIds.length > 5000) return NextResponse.json({ success: false, error: 'A maximum of 5,000 models may be cleaned in one operation.' }, { status: 400 });

    const rows = await sql`SELECT model_id, status, asset_symbol, horizon_ticks, training_run_id FROM ml_model_registry_v2 WHERE model_id = ANY(${modelIds})`;
    if (rows.length !== modelIds.length) {
      const found = new Set(rows.map((row: any) => String(row.model_id)));
      return NextResponse.json({ success: false, error: 'Cleanup aborted: one or more requested models are not registered.', missingModelIds: modelIds.filter(id => !found.has(id)) }, { status: 409 });
    }

    const protectedRows = rows.filter((row: any) => !['candidate', 'staging'].includes(String(row.status).toLowerCase()));
    if (protectedRows.length) return NextResponse.json({ success: false, error: 'Cleanup aborted: only candidate/staging models may be deleted. Production models are protected.', protectedModels: protectedRows.map((row: any) => ({ modelId: row.model_id, status: row.status })) }, { status: 409 });

    if (force) {
      await sql`DELETE FROM ops_model_selection_events WHERE selected_model_id = ANY(${modelIds})`;
    } else {
      const activeSelections = await sql`SELECT selected_model_id FROM ops_model_selection_events WHERE selected_model_id = ANY(${modelIds}) LIMIT 1`;
      if (activeSelections.length) return NextResponse.json({ success: false, error: 'Cleanup aborted: a selected model has persisted model-selection evidence. Pass force=true to override.', selectedModelId: activeSelections[0].selected_model_id }, { status: 409 });
    }

    const result = await sql`
      WITH requested AS (SELECT UNNEST(${modelIds}::text[]) AS model_id),
      eligible AS (
        SELECT r.model_id FROM requested r JOIN ml_model_registry_v2 m ON m.model_id = r.model_id
        WHERE LOWER(m.status) IN ('candidate', 'staging')
      ),
      deleted AS (
        DELETE FROM ml_model_registry_v2 m
        WHERE m.model_id IN (SELECT model_id FROM eligible)
        RETURNING m.model_id
      ),
      audit AS (
        INSERT INTO ops_audit_events (category, severity, actor, action, resource_type, resource_id, metadata)
        SELECT 'model_operations', 'warning', 'admin', 'admin_model_cleanup', 'ml_model_registry_v2', d.model_id,
               jsonb_build_object('operation', 'admin_model_cleanup', 'modelId', d.model_id)
        FROM deleted d
        RETURNING resource_id
      )
      SELECT (SELECT COUNT(*) FROM deleted)::int AS deleted_count,
             (SELECT COUNT(*) FROM audit)::int AS audited_count
    `;

    const deletedCount = Number(result[0]?.deleted_count ?? 0);
    const auditedCount = Number(result[0]?.audited_count ?? 0);
    if (deletedCount !== modelIds.length || auditedCount !== modelIds.length) return NextResponse.json({ success: false, error: 'Cleanup aborted: the registry changed during deletion; no complete cleanup was committed.' }, { status: 409 });

    return NextResponse.json({ success: true, deletedCount, auditedCount, preservedTrainingHistory: true, externalArtifactsDeleted: false });
  } catch (error: any) {
    console.error('[admin/model-cleanup] cleanup failed', error);
    return NextResponse.json({ success: false, error: 'Model cleanup failed safely. No partial cleanup was committed.' }, { status: 500 });
  }
}
