import { NextRequest, NextResponse } from 'next/server';
import { getDb, initDbSchema } from '@/lib/db';
import { verifySessionToken } from '../auth/route';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken =
    req.headers.get('x-admin-token') ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');

  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({
      success: false,
      error: 'Unauthorized admin access.',
    }, { status: 401 });
  }

  try {
    const isDbConnected = await initDbSchema();
    const sql = getDb();

    if (!sql || !isDbConnected) {
      return NextResponse.json({
        success: false,
        dataSource: 'database-unavailable',
        isSimulated: false,
        error: 'Database is unavailable. No synthetic admin records are returned.',
      }, { status: 503 });
    }

    const [registry, backtests, audits, trades] = await Promise.all([
      sql`SELECT * FROM ml_model_registry_v2 ORDER BY updated_at DESC LIMIT 50`,
      sql`SELECT * FROM ml_backtest_runs ORDER BY created_at DESC LIMIT 50`,
      sql`SELECT * FROM ops_audit_events ORDER BY created_at DESC LIMIT 50`,
      sql`SELECT * FROM execution_trades ORDER BY executed_at DESC LIMIT 50`,
    ]);

    return NextResponse.json({
      success: true,
      dataSource: 'live-database',
      isSimulated: false,
      generatedAt: new Date().toISOString(),
      registry,
      backtests,
      audits,
      trades,
    });
  } catch (err) {
    // Do not expose raw database/driver errors to the browser.
    console.error('Admin DB tables query failed:', err);
    return NextResponse.json({
      success: false,
      dataSource: 'database-error',
      isSimulated: false,
      error: 'Unable to load live database records.',
    }, { status: 500 });
  }
}
