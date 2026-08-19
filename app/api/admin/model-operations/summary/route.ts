import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../../auth/route';
import { getDb, initDbSchema } from '@/lib/db';
import { ensureTrainingDurationSchema } from '@/lib/training-duration-schema';
import { getWorkerStatus } from '@/lib/ml-training-queue';
import { ensureTrainingBatchSchema } from '@/lib/training-batch-schema';

function isAdmin(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

function noStore() {
  return { 'Cache-Control': 'no-store, max-age=0' };
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  }

  try {
    const dbReady = await initDbSchema();
    const sql = getDb();
    if (!dbReady || !sql) {
      return NextResponse.json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        dataSource: 'unavailable',
        observedAt: new Date().toISOString(),
      }, { status: 503, headers: noStore() });
    }

    await ensureTrainingDurationSchema(sql);
    await ensureTrainingBatchSchema(sql);
    const worker = await getWorkerStatus();

    const [queueRows, batchRows, registryRows, runRows] = await Promise.all([
      sql`SELECT status, COUNT(*)::int AS count FROM ml_training_job_queue GROUP BY status`,
      sql`SELECT batch_id,status,total_jobs,completed_jobs,failed_jobs,skipped_jobs,heartbeat_at,started_at,completed_at,error FROM ml_training_batches WHERE status IN ('queued','running','partial') ORDER BY created_at DESC LIMIT 3`,
      sql`SELECT status, COUNT(*)::int AS count FROM ml_model_registry_v2 GROUP BY status`,
      sql`SELECT status, COUNT(*)::int AS count FROM ml_training_runs WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY status`,
    ]);

    const queue = Object.fromEntries((queueRows as Array<{ status: string; count: number }>).map((row) => [String(row.status), Number(row.count)]));
    const registry = Object.fromEntries((registryRows as Array<{ status: string; count: number }>).map((row) => [String(row.status), Number(row.count)]));
    const runs7d = Object.fromEntries((runRows as Array<{ status: string; count: number }>).map((row) => [String(row.status), Number(row.count)]));

    const activeBatches = batchRows.map((row: any) => ({
      batchId: String(row.batch_id),
      status: String(row.status),
      totalJobs: Number(row.total_jobs || 0),
      completedJobs: Number(row.completed_jobs || 0),
      failedJobs: Number(row.failed_jobs || 0),
      skippedJobs: Number(row.skipped_jobs || 0),
      heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null,
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      error: row.error ? String(row.error) : null,
    }));

    const activeQueueJobs = Number(queue.queued || 0) + Number(queue.running || 0);
    const health = worker.status === 'online' && activeQueueJobs >= 0 ? 'healthy' : worker.status === 'stale' ? 'degraded' : 'offline';

    return NextResponse.json({
      success: true,
      dataSource: 'live-database-plus-dedicated-ml-worker',
      observedAt: new Date().toISOString(),
      health,
      worker,
      queue: {
        queued: Number(queue.queued || 0),
        running: Number(queue.running || 0),
        completed: Number(queue.completed || 0),
        failed: Number(queue.failed || 0),
        active: activeQueueJobs,
      },
      activeBatches,
      registry: {
        production: Number(registry.production || 0),
        staging: Number(registry.staging || 0),
        candidate: Number(registry.candidate || 0),
        other: Object.entries(registry).reduce((total, [key, value]) => ['production', 'staging', 'candidate'].includes(key) ? total : total + Number(value || 0), 0),
      },
      trainingRuns7d: runs7d,
    }, { headers: noStore() });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unable to load model operations summary.',
      dataSource: 'live-database-plus-dedicated-ml-worker',
      observedAt: new Date().toISOString(),
    }, { status: 503, headers: noStore() });
  }
}
