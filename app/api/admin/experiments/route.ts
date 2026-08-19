import { NextRequest, NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from '@/lib/db';
import { verifySessionToken } from '../auth/route';

export const dynamic = 'force-dynamic';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace('Bearer ', '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

async function ensureExperimentsTable() {
  const dbUrl = getDbConnectionString();
  if (!dbUrl) throw new Error('DATABASE_URL is not configured.');
  await initDbSchema();
  const sql = neon(dbUrl);
  await sql`
    CREATE TABLE IF NOT EXISTS admin_experiments (
      id BIGSERIAL PRIMARY KEY,
      experiment_id VARCHAR(64) UNIQUE NOT NULL,
      experiment_type VARCHAR(32) NOT NULL,
      symbol VARCHAR(64) NOT NULL,
      horizon_seconds INT,
      status VARCHAR(24) NOT NULL DEFAULT 'completed',
      parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_admin_experiments_created_at ON admin_experiments (created_at DESC);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_admin_experiments_type_symbol ON admin_experiments (experiment_type, symbol);`;
  return sql;
}

function makeExperimentId(type: string) {
  const prefix = type === 'backtest' ? 'BT' : type === 'multi-horizon' ? 'MH' : 'PS';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${date}-${suffix}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401 });
  try {
    const sql = await ensureExperimentsTable();
    const rows = await sql`
      SELECT experiment_id, experiment_type, symbol, horizon_seconds, status, parameters, result, created_at
      FROM admin_experiments
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return NextResponse.json({ success: true, experiments: rows, dataSource: 'live-database' });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Failed to load experiments.', experiments: [], dataSource: 'unavailable' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthValid(req)) return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401 });
  try {
    const body = await req.json();
    const experimentType = String(body?.experimentType || '').trim();
    const symbol = String(body?.symbol || '').trim();
    const status = String(body?.status || 'completed').trim();
    if (!['backtest', 'multi-horizon', 'paper-shadow'].includes(experimentType)) {
      return NextResponse.json({ error: 'Unsupported experiment type.' }, { status: 400 });
    }
    if (!symbol) return NextResponse.json({ error: 'Symbol is required.' }, { status: 400 });
    const experimentId = makeExperimentId(experimentType);
    const parameters = body?.parameters && typeof body.parameters === 'object' ? body.parameters : {};
    const result = body?.result && typeof body.result === 'object' ? body.result : {};
    const horizon = Number.isFinite(Number(body?.horizonSeconds)) ? Number(body.horizonSeconds) : null;
    const sql = await ensureExperimentsTable();
    await sql`
      INSERT INTO admin_experiments (experiment_id, experiment_type, symbol, horizon_seconds, status, parameters, result)
      VALUES (${experimentId}, ${experimentType}, ${symbol}, ${horizon}, ${status}, ${JSON.stringify(parameters)}::jsonb, ${JSON.stringify(result)}::jsonb)
    `;
    return NextResponse.json({ success: true, experimentId, dataSource: 'live-database' });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Failed to persist experiment.' }, { status: 500 });
  }
}
