import { NextResponse } from 'next/server';
import { getSystemHealthCheck } from '@/lib/health';

export async function GET() {
  const health = await getSystemHealthCheck();
  return NextResponse.json(health, { status: health.status === 'healthy' ? 200 : 503 });
}
