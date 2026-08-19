import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkRateLimit, type RateLimitType } from '@/lib/rate-limiter';

const TELEMETRY_ROUTES = [
  '/api/health',
  '/api/ml/status',
  '/api/admin/health',
  '/api/admin/latency-ping',
];

function isTelemetryRoute(pathname: string, method: string) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return TELEMETRY_ROUTES.includes(pathname) || pathname.startsWith('/api/admin/observability');
}

export async function proxy(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? 'unknown';

  if (request.nextUrl.pathname.startsWith('/api/')) {
    const pathname = request.nextUrl.pathname;
    const isAdminRoute = pathname.startsWith('/api/admin/');
    const isAuthRoute = pathname === '/api/admin/auth';
    const isMlRoute = pathname.startsWith('/api/ml/');
    const isWsRoute = pathname.startsWith('/api/db/ticks');
    const isTelemetry = isTelemetryRoute(pathname, request.method);

    let routeType: RateLimitType = 'api';
    if (isTelemetry) routeType = 'telemetry';
    else if (isAuthRoute) routeType = 'auth';
    else if (isMlRoute) routeType = 'ml';
    else if (isWsRoute) routeType = 'ws';

    // Keep authentication traffic isolated from normal admin/API throughput.
    const keyPrefix = isAdminRoute ? 'admin_' : '';
    const { success, limit, remaining, reset } = await checkRateLimit(
      `${keyPrefix}${ip}_${routeType}`,
      routeType,
    );

    if (!success) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please try again in a few seconds.' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': limit.toString(),
            'X-RateLimit-Remaining': remaining.toString(),
            'X-RateLimit-Reset': reset.toString(),
            'Cache-Control': 'no-store',
          },
        },
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
