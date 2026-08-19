import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { verifySessionToken } from '../auth/route';

function authorized(req: NextRequest) {
  const cookie = req.cookies.get('admin_session_token')?.value;
  const header = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookie) || verifySessionToken(header);
}

function configured(name: string) {
  return Boolean(process.env[name]?.trim());
}

function validUrl(name: string, protocols?: string[]) {
  const value = process.env[name]?.trim();
  if (!value) return false;

  try {
    const url = new URL(value);
    return protocols ? protocols.includes(url.protocol) : Boolean(url.protocol && url.hostname);
  } catch {
    return false;
  }
}

function secretRisk(name: string) {
  return /SECRET|TOKEN|PASSWORD|PRIVATE|DATABASE_URL|API_KEY/i.test(name);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });

  const envKeys = Object.keys(process.env).filter((key) => key && !key.startsWith('npm_') && !key.startsWith('NODE_'));
  const sensitiveKeys = envKeys.filter((key) => secretRisk(key) && !key.startsWith('NEXT_PUBLIC_'));
  const publicKeys = envKeys.filter((key) => key.startsWith('NEXT_PUBLIC_'));
  const exposedSecretNames = publicKeys.filter(secretRisk);

  const adminConfigured = configured('ADMIN_SECRET_KEY');
  const dbConfigured = configured('DATABASE_URL');
  const dbValid = validUrl('DATABASE_URL', ['postgres:', 'postgresql:']);
  const appConfigured = configured('APP_URL');
  const appValid = validUrl('APP_URL', ['https:']) || (process.env.NODE_ENV !== 'production' && validUrl('APP_URL', ['http:']));
  const derivConfigured = configured('NEXT_PUBLIC_DERIV_APP_ID');
  const derivRedirectConfigured = configured('NEXT_PUBLIC_DERIV_REDIRECT_URI');
  const derivRedirectValid = validUrl('NEXT_PUBLIC_DERIV_REDIRECT_URI', process.env.NODE_ENV === 'production' ? ['https:'] : ['http:', 'https:']);
  const redisConfigured = configured('UPSTASH_REDIS_REST_URL') && configured('UPSTASH_REDIS_REST_TOKEN');
  const redisUrlValid = validUrl('UPSTASH_REDIS_REST_URL', ['https:']);
  const mlConfigured = configured('PYTHON_ML_SERVICE_URL') || configured('PYTHON_BIN');
  const mlUrlValid = configured('PYTHON_ML_SERVICE_URL') ? validUrl('PYTHON_ML_SERVICE_URL', ['http:', 'https:']) : configured('PYTHON_BIN');

  const checks = [
    { id: 'admin-secret', label: 'Admin authentication secret', configured: adminConfigured, severity: 'critical' },
    { id: 'app-url', label: 'Application URL', configured: appConfigured && appValid, severity: 'high' },
    { id: 'database', label: 'Database credential', configured: dbConfigured && dbValid, severity: 'critical' },
    { id: 'deriv-app', label: 'Deriv application identity', configured: derivConfigured, severity: 'high' },
    { id: 'deriv-redirect', label: 'Deriv OAuth redirect URI', configured: derivRedirectConfigured && derivRedirectValid, severity: 'high' },
    { id: 'redis', label: 'Redis cache credentials', configured: redisConfigured && redisUrlValid, severity: 'medium' },
    { id: 'ml-runtime', label: 'ML runtime configuration', configured: mlConfigured && mlUrlValid, severity: 'high' },
  ];

  const secureCookiePolicy = process.env.NODE_ENV === 'production';
  const score = checks.filter((check) => check.configured).length / checks.length * 100;

  return NextResponse.json({
    success: true,
    dataSource: 'runtime-environment',
    generatedAt: new Date().toISOString(),
    environment: process.env.NODE_ENV || null,
    checks,
    posture: {
      configurationCoveragePercent: Math.round(score),
      secureCookiePolicy,
      secretVariablesDiscovered: sensitiveKeys.length,
      publicVariablesDiscovered: publicKeys.length,
      publicSecretRiskCount: exposedSecretNames.length,
      requestIdSupport: true,
      constantTimeAdminComparison: true,
      sessionTokenAlgorithm: 'HMAC-SHA256',
    },
    integrity: {
      valuesAreNotReturned: true,
      configuredDoesNotMeanHealthy: true,
      source: 'process.env',
      fingerprint: crypto.createHash('sha256').update(envKeys.sort().join('\n')).digest('hex').slice(0, 16),
    },
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
