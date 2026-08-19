import { NextRequest, NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { verifySessionToken } from '../../auth/route';
import { getDbConnectionString, initDbSchema } from '@/lib/db';
import { ensureTrainingDurationSchema } from '@/lib/training-duration-schema';
import { cancelAutoDatasetItemsForDataset } from '@/lib/auto-dataset-job-store';
import type { DerivDurationUnit } from '@/lib/deriv-duration-registry';

function isAuthenticated(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

function noStore() {
  return { 'Cache-Control': 'no-store, max-age=0' };
}

function validId(value: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(value);
}

function validDurationUnit(value: unknown): value is DerivDurationUnit {
  return value === 't' || value === 's' || value === 'm' || value === 'h' || value === 'd';
}

export async function POST(req: NextRequest) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const datasetIdsRaw = body?.datasetIds;
    if (!Array.isArray(datasetIdsRaw) || datasetIdsRaw.length === 0) {
      return NextResponse.json({ success: false, error: 'A non-empty array of datasetIds is required.' }, { status: 400, headers: noStore() });
    }

    const validIds = Array.from(new Set(datasetIdsRaw.filter((id): id is string => typeof id === 'string' && validId(id))));
    if (!validIds.length) {
      return NextResponse.json({ success: false, error: 'No valid UUID dataset IDs provided.' }, { status: 400, headers: noStore() });
    }

    const url = getDbConnectionString();
    if (!url || !(await initDbSchema())) {
      return NextResponse.json({ success: false, error: 'DATABASE_UNAVAILABLE' }, { status: 503, headers: noStore() });
    }

    const sql = neon(url);
    await ensureTrainingDurationSchema(sql);

    // 1. Fetch matching datasets
    const datasets = await sql`
      SELECT id, name, asset_symbol, duration_value, duration_unit, status
      FROM training_datasets
      WHERE id = ANY(${validIds}::uuid[])
    `;

    if (!datasets.length) {
      return NextResponse.json({ success: false, error: 'NO_DATASETS_FOUND', message: 'None of the requested datasets were found.' }, { status: 404, headers: noStore() });
    }

    // 2. Query dependencies for all requested datasets
    const [runningRuns, historicalRuns, registeredModels] = await Promise.all([
      sql`
        SELECT dataset_id, COUNT(*)::int AS count 
        FROM ml_training_runs 
        WHERE dataset_id = ANY(${validIds}) AND status = 'running'
        GROUP BY dataset_id
      `,
      sql`
        SELECT dataset_id, COUNT(*)::int AS count 
        FROM ml_training_runs 
        WHERE dataset_id = ANY(${validIds})
        GROUP BY dataset_id
      `,
      sql`
        SELECT dataset_id, COUNT(*)::int AS count 
        FROM ml_model_registry_v2 
        WHERE dataset_id = ANY(${validIds})
        GROUP BY dataset_id
      `,
    ]);

    const runningMap = new Map<string, number>(runningRuns.map((r: any) => [String(r.dataset_id), Number(r.count)]));
    const historicalMap = new Map<string, number>(historicalRuns.map((r: any) => [String(r.dataset_id), Number(r.count)]));
    const modelMap = new Map<string, number>(registeredModels.map((r: any) => [String(r.dataset_id), Number(r.count)]));

    const deletableIds: string[] = [];
    const blockedDatasets: Array<{ id: string; name: string; reason: string; runningCount: number; runCount: number; modelCount: number }> = [];

    for (const ds of datasets as any[]) {
      const id = String(ds.id);
      const runningCount = runningMap.get(id) || 0;
      const runCount = historicalMap.get(id) || 0;
      const modelCount = modelMap.get(id) || 0;

      if (runningCount > 0) {
        blockedDatasets.push({
          id,
          name: ds.name,
          reason: 'Training run actively in progress',
          runningCount,
          runCount,
          modelCount,
        });
      } else if (runCount > 0 || modelCount > 0) {
        blockedDatasets.push({
          id,
          name: ds.name,
          reason: 'Dataset has persisted training runs or registered ML model lineage',
          runningCount,
          runCount,
          modelCount,
        });
      } else {
        deletableIds.push(id);
      }
    }

    let deletedCount = 0;
    let totalCancelledAutoItems = 0;

    if (deletableIds.length > 0) {
      // Cancel auto-items for deletable datasets to prevent resurrection
      const deletableDatasets = datasets.filter((ds: any) => deletableIds.includes(String(ds.id)));
      for (const ds of deletableDatasets as any[]) {
        const durationValue = Number(ds.duration_value);
        const durationUnit = String(ds.duration_unit ?? '');
        if (Number.isSafeInteger(durationValue) && durationValue > 0 && validDurationUnit(durationUnit)) {
          const cancelled = await cancelAutoDatasetItemsForDataset(String(ds.asset_symbol), durationValue, durationUnit);
          totalCancelledAutoItems += cancelled;
        }
      }

      const deletedRows = await sql`
        DELETE FROM training_datasets
        WHERE id = ANY(${deletableIds}::uuid[])
        RETURNING id
      `;
      deletedCount = deletedRows.length;
    }

    return NextResponse.json({
      success: true,
      requestedCount: validIds.length,
      deletedCount,
      blockedCount: blockedDatasets.length,
      blockedDatasets,
      cancelledAutoItems: totalCancelledAutoItems,
      message: deletedCount > 0 
        ? `Successfully deleted ${deletedCount} dataset${deletedCount > 1 ? 's' : ''}.${blockedDatasets.length > 0 ? ` ${blockedDatasets.length} dataset${blockedDatasets.length > 1 ? 's were' : ' was'} protected due to training lineage.` : ''}`
        : `No datasets were deleted. All ${blockedDatasets.length} dataset(s) are protected by training lineage.`,
    }, { headers: noStore() });
  } catch (error) {
    console.error('[Admin dataset batch-delete] failed:', error);
    return NextResponse.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unable to perform batch dataset deletion.' 
    }, { status: 500, headers: noStore() });
  }
}
