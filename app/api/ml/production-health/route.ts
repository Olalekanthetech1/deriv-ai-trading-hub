import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../../admin/auth/route';
import { getProductionModelHealth } from '@/lib/production-model-resolver';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });
  try {
    const symbol = new URL(req.url).searchParams.get('symbol')?.trim() || undefined;
    const models = await getProductionModelHealth(symbol);
    const healthyCount = models.filter((model) => model.healthy).length;
    return NextResponse.json({
      success: true,
      status: models.length > 0 && healthyCount === models.length ? 'HEALTHY' : models.length > 0 ? 'DEGRADED' : 'NO_PRODUCTION_MODELS',
      count: models.length,
      healthyCount,
      models,
      dataSource: 'live-database-and-durable-artifact-store',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Production model health check failed';
    return NextResponse.json({ success: false, error: message }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
