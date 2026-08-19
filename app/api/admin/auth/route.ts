import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { recordObservabilityEvent } from '@/lib/observability';

interface FailedAttempt {
  count: number;
  firstAttemptAt: number;
  lockoutUntil?: number;
}

const failedAttemptsMap = new Map<string, FailedAttempt>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function cleanupAttempts() {
  const now = Date.now();
  for (const [ip, attempt] of failedAttemptsMap.entries()) {
    if (attempt.lockoutUntil && attempt.lockoutUntil < now) {
      failedAttemptsMap.delete(ip);
    } else if (now - attempt.firstAttemptAt > LOCKOUT_MS) {
      failedAttemptsMap.delete(ip);
    }
  }
}

function getConfiguredSecret(): string | null {
  const secret = process.env.ADMIN_SECRET_KEY?.trim();
  return secret ? secret : null;
}

function generateSessionToken(timestamp: number, secret: string): string {
  const hash = crypto.createHmac('sha256', secret).update(`admin_session_${timestamp}`).digest('hex');
  return `${timestamp}.${hash}`;
}

function getRequestId(req: NextRequest): string {
  return req.headers.get('x-request-id')?.trim() || crypto.randomUUID();
}

function noStoreHeaders() {
  return { 'Cache-Control': 'no-store, max-age=0' };
}

export function verifySessionToken(token: string | undefined | null): boolean {
  const secret = getConfiguredSecret();
  if (!secret || !token) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const timestamp = Number(parts[0]);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return false;

  const now = Date.now();
  if (timestamp > now || now - timestamp > SESSION_TTL_MS) return false;

  const expectedToken = generateSessionToken(timestamp, secret);
  const provided = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(provided, expected);
}

function getRequestIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
}

function isRequestAuthenticated(req: NextRequest): boolean {
  const cookie = req.cookies.get('admin_session_token')?.value;
  const header = req.headers.get('x-admin-token');
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookie) || verifySessionToken(header) || verifySessionToken(bearer);
}

export async function GET(req: NextRequest) {
  const isAuthenticated = isRequestAuthenticated(req);

  return NextResponse.json(
    {
      isAuthenticated,
      ...(isAuthenticated ? { configured: Boolean(getConfiguredSecret()) } : {}),
    },
    { headers: noStoreHeaders() },
  );
}

export async function POST(req: NextRequest) {
  cleanupAttempts();

  const configuredSecret = getConfiguredSecret();
  const requestId = getRequestId(req);
  if (!configuredSecret) {
    void recordObservabilityEvent({
      category: 'security', severity: 'error', service: 'admin-auth', eventType: 'auth_not_configured',
      message: 'Admin authentication configuration is missing.', requestId,
    });
    return NextResponse.json(
      { success: false, error: 'Admin authentication is not configured. Set ADMIN_SECRET_KEY in the deployment environment.' },
      { status: 503, headers: noStoreHeaders() },
    );
  }

  const ip = getRequestIp(req);
  const now = Date.now();
  const attempt = failedAttemptsMap.get(ip) || { count: 0, firstAttemptAt: now };

  if (attempt.lockoutUntil && attempt.lockoutUntil > now) {
    const remainingSeconds = Math.ceil((attempt.lockoutUntil - now) / 1000);
    void recordObservabilityEvent({
      category: 'security', severity: 'critical', service: 'admin-auth', eventType: 'auth_lockout_attempt',
      message: 'Admin authentication request rejected because the source is temporarily locked out.', requestId,
      metadata: { attempts: attempt.count, lockoutRemainingSeconds: remainingSeconds },
    });
    return NextResponse.json(
      {
        success: false,
        error: `Too many failed attempts. Admin access locked for ${remainingSeconds} seconds.`,
        lockoutRemainingSeconds: remainingSeconds,
      },
      { status: 429, headers: noStoreHeaders() },
    );
  }

  try {
    const body = await req.json();
    const { key } = body;

    if (!key || typeof key !== 'string') {
      void recordObservabilityEvent({
        category: 'security', severity: 'warn', service: 'admin-auth', eventType: 'auth_missing_key',
        message: 'Admin authentication request did not include a valid passkey value.', requestId,
      });
      return NextResponse.json({ success: false, error: 'Admin passkey is required.' }, { status: 400, headers: noStoreHeaders() });
    }

    const provided = Buffer.from(key);
    const expected = Buffer.from(configuredSecret);
    const isMatch = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);

    if (!isMatch) {
      attempt.count += 1;
      if (attempt.count >= MAX_FAILED_ATTEMPTS) {
        attempt.lockoutUntil = now + LOCKOUT_MS;
      }
      failedAttemptsMap.set(ip, attempt);

      void recordObservabilityEvent({
        category: 'security', severity: attempt.count >= MAX_FAILED_ATTEMPTS ? 'critical' : 'warn',
        service: 'admin-auth', eventType: 'auth_failed',
        message: 'Admin authentication failed.', requestId,
        metadata: { attempts: attempt.count, locked: attempt.count >= MAX_FAILED_ATTEMPTS },
      });

      return NextResponse.json(
        {
          success: false,
          error: 'Invalid admin authorization passkey.',
          attemptsRemaining: Math.max(0, MAX_FAILED_ATTEMPTS - attempt.count),
          isLockedOut: attempt.count >= MAX_FAILED_ATTEMPTS,
        },
        { status: 401, headers: noStoreHeaders() },
      );
    }

    failedAttemptsMap.delete(ip);

    const timestamp = Date.now();
    const token = generateSessionToken(timestamp, configuredSecret);
    const response = NextResponse.json(
      {
        success: true,
        message: 'Admin authorization granted successfully.',
        token,
        expiresAt: timestamp + SESSION_TTL_MS,
      },
      { headers: noStoreHeaders() },
    );

    response.cookies.set('admin_session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

    void recordObservabilityEvent({
      category: 'security', severity: 'info', service: 'admin-auth', eventType: 'auth_success',
      message: 'Admin authentication granted successfully.', requestId,
    });

    return response;
  } catch {
    void recordObservabilityEvent({
      category: 'security', severity: 'warn', service: 'admin-auth', eventType: 'auth_malformed_request',
      message: 'Admin authentication request could not be parsed.', requestId,
    });
    return NextResponse.json({ success: false, error: 'Malformed request.' }, { status: 400, headers: noStoreHeaders() });
  }
}

export async function DELETE(req: NextRequest) {
  const requestId = getRequestId(req);
  void recordObservabilityEvent({
    category: 'security', severity: 'info', service: 'admin-auth', eventType: 'auth_logout',
    message: 'Admin session logout requested.', requestId,
  });

  const response = NextResponse.json(
    {
      success: true,
      message: 'Admin logged out successfully.',
    },
    { headers: noStoreHeaders() },
  );

  response.cookies.set('admin_session_token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });

  return response;
}
