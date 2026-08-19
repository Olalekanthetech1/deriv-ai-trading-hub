import { NextRequest, NextResponse } from 'next/server';
import { getRateLimitBlocks } from '@/lib/health';
import { getDb } from '@/lib/db';
import { mlRuntimeClient } from '@/lib/ml-runtime-client';
import { verifySessionToken } from '../auth/route';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace('Bearer ', '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401 });
  }
  let dbStatus = false;
  let dbLatencyMs: number | null = null;
  try {
    const sql = getDb();
    if (sql) {
      const dbStart = Date.now();
      await sql`SELECT 1`;
      dbLatencyMs = Date.now() - dbStart;
      dbStatus = true;
    }
  } catch (err) {}

  let pythonStatus = false;
  let daemonLatencyMs: number | null = null;
  try {
    const runtimeStart = Date.now();
    const pingRes = await mlRuntimeClient.sendCommand('ping');
    daemonLatencyMs = Date.now() - runtimeStart;
    if (pingRes && pingRes.success) {
      pythonStatus = true;
    }
  } catch (err) {}

  const blocks = await getRateLimitBlocks();

  return NextResponse.json({
    db: dbStatus ? 'online' : 'offline',
    dbLatencyMs,
    pythonDaemon: pythonStatus ? 'online' : 'offline',
    daemonLatencyMs,
    rateLimitBlocks: blocks,
    rateLimiterStatus: 'Active (Sliding Window)',
  });
}
