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

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  }

  const { id } = await context.params;
  if (!validId(id)) {
    return NextResponse.json({ success: false, error: 'A valid dataset ID is required.' }, { status: 400, headers: noStore() });
  }

  const url = getDbConnectionString();
  if (!url || !(await initDbSchema())) {
    return NextResponse.json({ success: false, error: 'DATABASE_UNAVAILABLE' }, { status: 503, headers: noStore() });
  }

  const sql = neon(url);
  await ensureTrainingDurationSchema(sql);

  try {
    const datasets = await sql`
      SELECT id, name, asset_symbol, duration_value, duration_unit, status
      FROM training_datasets
      WHERE id = ${id}::uuid
      LIMIT 1
    `;

    const dataset = datasets[0] as any;
    if (!dataset) {
      return NextResponse.json({ success: false, error: 'TRAINING_DATASET_NOT_FOUND' }, { status: 404, headers: noStore() });
    }

    const [runningRuns, historicalRuns, registeredModels] = await Promise.all([
      sql`SELECT COUNT(*)::int AS count FROM ml_training_runs WHERE dataset_id = ${id} AND status = 'running'`,
      sql`SELECT COUNT(*)::int AS count FROM ml_training_runs WHERE dataset_id = ${id}`,
      sql`SELECT COUNT(*)::int AS count FROM ml_model_registry_v2 WHERE dataset_id = ${id}`,
    ]);

    const runningCount = Number((runningRuns[0] as any)?.count ?? 0);
    const runCount = Number((historicalRuns[0] as any)?.count ?? 0);
    const modelCount = Number((registeredModels[0] as any)?.count ?? 0);

    if (runningCount > 0) {
      return NextResponse.json({
        success: false,
        error: 'DATASET_TRAINING_IN_PROGRESS',
        message: 'This dataset cannot be deleted while a training run is active.',
        dependencies: { runningTrainingRuns: runningCount, trainingRuns: runCount, registeredModels: modelCount },
      }, { status: 409, headers: noStore() });
    }

    if (runCount > 0 || modelCount > 0) {
      return NextResponse.json({
        success: false,
        error: 'DATASET_HAS_DEPENDENCIES',
        message: 'This dataset is part of training/model lineage and cannot be hard-deleted. Preserve the audit trail and use an archive lifecycle when supported.',
        dependencies: { runningTrainingRuns: runningCount, trainingRuns: runCount, registeredModels: modelCount },
      }, { status: 409, headers: noStore() });
    }

    // AUTO builds are durable and can continue after the UI request that started them.
    // Cancel the matching pending/running item before deletion so it cannot recreate
    // the dataset after this DELETE succeeds. The worker also checks cancellation
    // after a build completes to close the in-flight race window.
    const durationValue = Number(dataset.duration_value);
    const durationUnit = String(dataset.duration_unit ?? '');
    let cancelledAutoItems = 0;
    if (Number.isSafeInteger(durationValue) && durationValue > 0 && validDurationUnit(durationUnit)) {
      cancelledAutoItems = await cancelAutoDatasetItemsForDataset(String(dataset.asset_symbol), durationValue, durationUnit);
    }

    const deleted = await sql`
      DELETE FROM training_datasets
      WHERE id = ${id}::uuid
      RETURNING id, name, asset_symbol, duration_value, duration_unit, status
    `;

    if (!deleted.length) {
      return NextResponse.json({ success: false, error: 'TRAINING_DATASET_NOT_FOUND' }, { status: 404, headers: noStore() });
    }

    return NextResponse.json({
      success: true,
      deletedDataset: deleted[0],
      cancelledAutoItems,
      message: 'Training dataset deleted. Persisted dataset samples were removed by the dataset foreign-key cascade, and matching AUTO build work was cancelled to prevent resurrection.',
    }, { headers: noStore() });
  } catch (error) {
    console.error('[Admin dataset delete] failed:', error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unable to delete training dataset.' }, { status: 500, headers: noStore() });
  }
}
