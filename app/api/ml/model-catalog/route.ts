import { NextRequest, NextResponse } from 'next/server';
import { getExperimentalModelDefinitions, getMlModelDefinitions, getProductionCandidateDefinitions } from '@/lib/ml-model-registry';
import { verifySessionToken } from '../../admin/auth/route';

function isAdmin(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401 });

  const all = getMlModelDefinitions();
  return NextResponse.json({
    success: true,
    productionCandidates: getProductionCandidateDefinitions(),
    experimental: getExperimentalModelDefinitions(),
    modelCount: all.length,
    runtimes: [
      { key: 'native-daemon', name: 'Native ML daemon', status: 'active', purpose: 'server-side training and inference' },
      { key: 'tensorflowjs-edge', name: 'TensorFlow.js Edge', status: 'planned', purpose: 'optional browser/edge inference runtime' },
    ],
  }, { headers: { 'Cache-Control': 'no-store' } });
}