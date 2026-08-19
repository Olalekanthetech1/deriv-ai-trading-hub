import { NextResponse } from 'next/server';
import { initDbSchema, getDb } from '@/lib/db';
import { ensureTrainingDurationSchema } from '@/lib/training-duration-schema';
import { getWorkerStatus } from '@/lib/ml-training-queue';

export async function GET() {
  try {
    const isDbConnected = await initDbSchema();
    const sql = getDb();
    if (!sql || !isDbConnected) {
      return NextResponse.json({
        status: 'degraded',
        isDbConnected: false,
        trainingWorker: { status: 'offline', workerId: null, heartbeatAt: null },
        modelRegistry: { total: 0, production: 0, candidate: 0, validated: 0 },
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }

    await ensureTrainingDurationSchema(sql);

    const [registryRows, runRows, worker] = await Promise.all([
      sql`SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'production')::int AS production,
        COUNT(*) FILTER (WHERE status = 'candidate')::int AS candidate,
        COUNT(*) FILTER (
          WHERE status IN ('candidate','staging','production')
            AND COALESCE((metrics->>'accuracy')::numeric, NULL) IS NOT NULL
            AND COALESCE((metrics->>'logLoss')::numeric, NULL) IS NOT NULL
        )::int AS validated
        FROM ml_model_registry_v2`,
      sql`SELECT status, COUNT(*)::int AS count FROM ml_training_runs GROUP BY status`,
      getWorkerStatus(),
    ]);

    const registry = registryRows[0] || {};
    const trainingRuns = Object.fromEntries((runRows as Array<{ status: string; count: number }>).map((row) => [row.status, Number(row.count)]));

    return NextResponse.json({
      status: worker.status === 'online' ? 'healthy' : 'degraded',
      isDbConnected: true,
      trainingWorker: worker,
      modelRegistry: {
        total: Number(registry.total || 0),
        production: Number(registry.production || 0),
        candidate: Number(registry.candidate || 0),
        validated: Number(registry.validated || 0),
      },
      trainingRuns,
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      status: 'degraded',
      error: error instanceof Error ? error.message : 'Status check failed',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
