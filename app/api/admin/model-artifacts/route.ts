import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../auth/route';
import { enqueueArtifactBackfill, getLatestArtifactMaintenanceJob, inspectArtifactBackfill } from '@/lib/ml-artifact-maintenance';

function isAdmin(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(verifySessionToken(cookieToken) || verifySessionToken(headerToken));
}

function noStore() { return { 'Cache-Control': 'no-store, max-age=0' }; }

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    const [health, job] = await Promise.all([inspectArtifactBackfill(), getLatestArtifactMaintenanceJob()]);
    return NextResponse.json({ success: true, ...health, job }, { headers: noStore() });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unable to inspect model artifact integrity.' }, { status: 503, headers: noStore() });
  }
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action !== 'backfill') return NextResponse.json({ success: false, error: 'Unsupported artifact operation.' }, { status: 400, headers: noStore() });
    const job = await enqueueArtifactBackfill();
    return NextResponse.json({ success: true, queued: true, workerBoundary: 'dedicated-ml-worker', job }, { status: 202, headers: noStore() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to queue artifact backfill.';
    const status = message.startsWith('ARTIFACT_BACKFILL_ALREADY_ACTIVE') ? 409 : /DATABASE/i.test(message) ? 503 : 500;
    return NextResponse.json({ success: false, error: message }, { status, headers: noStore() });
  }
}
