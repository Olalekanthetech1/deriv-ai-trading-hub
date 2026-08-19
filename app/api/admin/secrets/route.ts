import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { verifySessionToken } from '../auth/route';
import { neon } from '@neondatabase/serverless';

export interface EnvVarMeta {
  key: string;
  description: string;
  category: 'Database' | 'AI & ML' | 'Trading Platform' | 'Cache' | 'Security & Auth' | 'App Config';
  isSet: boolean;
  valueMasked: string;
  isSecret: boolean;
  isPublic: boolean;
  source: 'process_env' | 'default_template';
  rawLength: number;
}

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

function getCategoryForKey(key: string): EnvVarMeta['category'] {
  const k = key.toUpperCase();
  if (k.includes('DATABASE') || k.includes('POSTGRES') || k.includes('NEON') || k.includes('DB_')) return 'Database';
  if (k.includes('GEMINI') || k.includes('OPENAI') || k.includes('MODEL') || k.includes('AI_')) return 'AI & ML';
  if (k.includes('DERIV') || k.includes('TRADE') || k.includes('MARKET') || k.includes('OAUTH')) return 'Trading Platform';
  if (k.includes('REDIS') || k.includes('UPSTASH') || k.includes('CACHE')) return 'Cache';
  if (k.includes('ADMIN') || k.includes('SECRET') || k.includes('TOKEN') || k.includes('KEY') || k.includes('AUTH') || k.includes('PASSWORD')) return 'Security & Auth';
  return 'App Config';
}

function maskSecretValue(val: string | undefined): string {
  if (!val || val.trim().length === 0) return '';
  if (val.length <= 6) return '••••••';
  if (val.startsWith('postgres://') || val.startsWith('postgresql://')) {
    const parts = val.split('@');
    if (parts.length > 1) return `postgres://••••••••@${parts[1]}`;
  }
  return `${val.substring(0, 3)}••••••••${val.substring(val.length - 4)}`;
}

export function parseEnvExampleFile(): EnvVarMeta[] {
  const envExamplePath = path.join(process.cwd(), '.env.example');
  let content = '';

  try {
    if (fs.existsSync(envExamplePath)) content = fs.readFileSync(envExamplePath, 'utf-8');
  } catch (err) {
    console.error('Error reading .env.example file:', err);
  }

  const lines = content.split('\n');
  const results: EnvVarMeta[] = [];
  let pendingComments: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      pendingComments = [];
      continue;
    }

    if (line.startsWith('#')) {
      const commentText = line.replace(/^#\s*/, '').trim();
      if (commentText) pendingComments.push(commentText);
      continue;
    }

    if (!line.includes('=')) continue;

    const eqIndex = line.indexOf('=');
    const key = line.substring(0, eqIndex).trim();
    if (!key) continue;

    const description = pendingComments.join(' ') || `Environment configuration parameter for ${key}`;
    pendingComments = [];

    const currentValue = process.env[key] || '';
    const isSet = Boolean(currentValue.trim());
    const isPublic = key.startsWith('NEXT_PUBLIC_');

    results.push({
      key,
      description,
      category: getCategoryForKey(key),
      isSet,
      valueMasked: isPublic ? currentValue : maskSecretValue(currentValue),
      isSecret: !isPublic,
      isPublic,
      source: isSet ? 'process_env' : 'default_template',
      rawLength: currentValue.length,
    });
  }

  return results;
}

function isAllowedKey(key: string): boolean {
  return parseEnvExampleFile().some((entry) => entry.key === key);
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized: Admin authentication token required' }, { status: 401 });
  }

  const variables = parseEnvExampleFile();
  return NextResponse.json({
    success: true,
    count: variables.length,
    variables,
    environment: {
      nodeEnv: process.env.NODE_ENV || 'development',
      isCloudRun: Boolean(process.env.K_SERVICE || process.env.APP_URL),
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      secretsAreDeploymentManaged: true,
    },
  });
}

export async function POST(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized: Admin authentication token required' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { action, key } = body;

    if (action !== 'test') {
      return NextResponse.json({
        success: false,
        error: 'Runtime secret mutation is disabled. Configure production secrets through the deployment secret manager (for example Render Environment Variables), then redeploy.',
      }, { status: 410 });
    }

    if (!key || typeof key !== 'string' || !isAllowedKey(key)) {
      return NextResponse.json({ success: false, error: 'Unsupported environment key.' }, { status: 400 });
    }

    const targetValue = process.env[key];
    if (!targetValue?.trim()) {
      return NextResponse.json({ success: false, error: `Secret ${key} is not configured in the deployment environment.` }, { status: 400 });
    }

    if (key === 'DATABASE_URL') {
      try {
        const sql = neon(targetValue);
        const res = await sql`SELECT NOW() as current_time, VERSION() as version`;
        return NextResponse.json({
          success: true,
          message: 'Database connection test succeeded.',
          details: { timestamp: res[0]?.current_time, version: res[0]?.version },
        });
      } catch (dbErr: any) {
        return NextResponse.json({ success: false, error: `Database test failed: ${dbErr.message || dbErr}` }, { status: 400 });
      }
    }

    if (key === 'GEMINI_API_KEY') {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(targetValue)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
        });
        const json = await res.json();
        if (res.ok) {
          return NextResponse.json({ success: true, message: 'Gemini API key test succeeded.', details: { status: 'Verified' } });
        }
        return NextResponse.json({ success: false, error: `Gemini API test returned ${res.status}: ${json.error?.message || 'Invalid key'}` }, { status: 400 });
      } catch (aiErr: any) {
        return NextResponse.json({ success: false, error: `Gemini API key test failed: ${aiErr.message || aiErr}` }, { status: 400 });
      }
    }

    if (key.includes('REDIS') || key.includes('UPSTASH')) {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!url || !token) {
        return NextResponse.json({ success: false, error: 'Both Upstash Redis REST URL and token must be configured for a live test.' }, { status: 400 });
      }

      try {
        const cleanUrl = url.trim().replace(/\/$/, '');
        const pingRes = await fetch(`${cleanUrl}/PING`, { headers: { Authorization: `Bearer ${token.trim()}` } });
        const pingJson = await pingRes.json();
        if (pingRes.ok && pingJson.result === 'PONG') {
          return NextResponse.json({ success: true, message: 'Upstash Redis REST connection succeeded.', details: { status: 'Verified' } });
        }
        return NextResponse.json({ success: false, error: `Upstash Redis test returned status ${pingRes.status}.` }, { status: 400 });
      } catch (redisErr: any) {
        return NextResponse.json({ success: false, error: `Upstash Redis connection failed: ${redisErr.message || redisErr}` }, { status: 400 });
      }
    }

    return NextResponse.json({ success: true, message: `Key ${key} is configured in the deployment environment.` });
  } catch {
    return NextResponse.json({ success: false, error: 'Malformed request.' }, { status: 400 });
  }
}
