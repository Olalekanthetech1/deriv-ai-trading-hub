import { NextRequest, NextResponse } from 'next/server';
import { initDbSchema, getDb } from '@/lib/db';
import { redisClient } from '@/lib/rate-limiter';
import { verifySessionToken } from '../auth/route';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401 });
  }

  try {
    const isDbConnected = await initDbSchema();
    const sql = getDb();

    let systemLogs: any[] = [];
    if (redisClient) {
      try {
        const rawLogs = await redisClient.lrange('recent_system_logs', 0, 49);
        systemLogs = rawLogs.flatMap((entry: string) => {
          try { return [JSON.parse(entry)]; } catch { return []; }
        });
      } catch {
        systemLogs = [];
      }
    }

    if (!sql || !isDbConnected) {
      return NextResponse.json({
        isDbConnected: false,
        systemLogs,
        logs: [],
        models: [],
        dataSource: 'live-only',
      });
    }

    const [logs, models] = await Promise.all([
      sql`
        SELECT id, symbol, samples_count, train_accuracy, val_accuracy, log_message, created_at
        FROM ml_training_logs
        ORDER BY created_at DESC
        LIMIT 100
      `,
      sql`
        SELECT id, model_name, version, symbol, asset_class, accuracy, feature_count, hyperparameters, trained_at
        FROM ml_models
        ORDER BY trained_at DESC
        LIMIT 50
      `,
    ]);

    return NextResponse.json({
      isDbConnected: true,
      systemLogs,
      logs,
      models,
      dataSource: 'live-database',
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Logs fetch failed' }, { status: 500 });
  }
}
