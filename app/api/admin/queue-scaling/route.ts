import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../auth/route';
import { getQueueWorkerRuntimeConfig, updateQueueWorkerRuntimeConfig } from '@/lib/ops-runtime-config';
import { getWorkerStatus, listTrainingQueueJobs, updateTrainingJobPriority, flushStaleWorkerHeartbeats } from '@/lib/ml-training-queue';

export const dynamic = 'force-dynamic';

function isAdmin(req: NextRequest): boolean {
  const cookie = req.cookies.get('admin_session_token')?.value;
  const header = req.headers.get('x-admin-token');
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(verifySessionToken(cookie) || verifySessionToken(header) || verifySessionToken(bearer));
}

function noStore() {
  return { 'Cache-Control': 'no-store, max-age=0' };
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401, headers: noStore() });
  }

  try {
    const [config, workerStatus, queueJobs] = await Promise.all([
      getQueueWorkerRuntimeConfig(true),
      getWorkerStatus(),
      listTrainingQueueJobs(),
    ]);

    const activeRunningCount = queueJobs.filter((j) => j.status === 'running').length;
    const queuedCount = queueJobs.filter((j) => j.status === 'queued').length;

    return NextResponse.json({
      success: true,
      config,
      stats: {
        workerStatus,
        activeRunningCount,
        queuedCount,
        totalInQueue: queueJobs.length,
      },
      queueJobs: queueJobs.slice(0, 30),
      workers: workerStatus.allWorkers || [],
    }, { headers: noStore() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to fetch queue scaling controls';
    return NextResponse.json({ success: false, error: message }, { status: 500, headers: noStore() });
  }
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401, headers: noStore() });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body;

    if (action === 'flush_stale_workers') {
      const flushedCount = await flushStaleWorkerHeartbeats();
      return NextResponse.json({
        success: true,
        message: `Flushed ${flushedCount} stale worker heartbeat records from PostgreSQL database.`,
        flushedCount,
      }, { headers: noStore() });
    }

    if (action === 'set_priority' || action === 'boost_priority' || action === 'lower_priority') {
      const jobId = String(body.jobId || '').trim();
      if (!jobId) {
        return NextResponse.json({ success: false, error: 'jobId is required.' }, { status: 400, headers: noStore() });
      }

      let newPriority = Number(body.priority);
      if (action === 'boost_priority') {
        newPriority = 1; // Urgent / Top
      } else if (action === 'lower_priority') {
        newPriority = 8; // Low / Background
      }

      if (!Number.isFinite(newPriority) || newPriority < 1 || newPriority > 10) {
        return NextResponse.json({ success: false, error: 'priority must be an integer between 1 (highest) and 10 (lowest).' }, { status: 400, headers: noStore() });
      }

      const updated = await updateTrainingJobPriority(jobId, newPriority);
      if (!updated) {
        return NextResponse.json({ success: false, error: 'Job not found or could not update priority.' }, { status: 404, headers: noStore() });
      }

      return NextResponse.json({
        success: true,
        message: `Priority updated to P${newPriority} for job ${jobId.slice(0, 8)}.`,
        jobId,
        priority: newPriority,
      }, { headers: noStore() });
    }

    const { isPaused, concurrencyLimit, pauseReason } = body;

    const updated = await updateQueueWorkerRuntimeConfig({
      isPaused: typeof isPaused === 'boolean' ? isPaused : undefined,
      concurrencyLimit: concurrencyLimit !== undefined ? Number(concurrencyLimit) : undefined,
      pauseReason: typeof pauseReason === 'string' ? pauseReason : undefined,
      updatedBy: 'admin',
    });

    return NextResponse.json({
      success: true,
      message: updated.isPaused ? 'Queue workers paused successfully.' : 'Queue workers updated and active.',
      config: updated,
    }, { headers: noStore() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update queue worker scaling config';
    return NextResponse.json({ success: false, error: message }, { status: 400, headers: noStore() });
  }
}
