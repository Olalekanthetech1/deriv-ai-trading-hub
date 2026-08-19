import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../auth/route';
import { listCanonicalMlDatasetsWithCompatibility } from '@/lib/ml-dataset-registry';
import type { MlModelFamily } from '@/lib/ml-model-registry';

export const dynamic = 'force-dynamic';

function isAdmin(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(verifySessionToken(cookieToken) || verifySessionToken(headerToken));
}

function noStore() {
  return { 'Cache-Control': 'no-store, max-age=0' };
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  }

  try {
    const symbol = req.nextUrl.searchParams.get('symbol')?.trim().toUpperCase() || undefined;
    const sourceType = req.nextUrl.searchParams.get('sourceType')?.trim();
    const modelFamily = req.nextUrl.searchParams.get('modelFamily')?.trim() as MlModelFamily | undefined;
    const includeIneligible = req.nextUrl.searchParams.get('includeIneligible') === '1' || req.nextUrl.searchParams.get('includeIneligible') === 'true';

    const allDatasets = await listCanonicalMlDatasetsWithCompatibility(symbol);

    const eligible = [];
    const ineligible = [];

    for (const dataset of allDatasets) {
      if (sourceType && dataset.sourceType !== sourceType) continue;

      if (modelFamily && dataset.compatibility) {
        const familyCheck = dataset.compatibility.architectures[modelFamily as keyof typeof dataset.compatibility.architectures];
        if (familyCheck?.compatible) {
          eligible.push(dataset);
        } else {
          ineligible.push({
            ...dataset,
            ineligibilityReason: familyCheck?.reason || `Not compatible with ${modelFamily} architecture.`,
          });
        }
      } else {
        if (dataset.compatibility?.isEligibleForAny !== false) {
          eligible.push(dataset);
        } else {
          ineligible.push({
            ...dataset,
            ineligibilityReason: dataset.compatibility?.rejectionReasons.join('; ') || 'Governance verification failed.',
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      datasets: includeIneligible ? allDatasets : eligible,
      eligible,
      ineligible,
      totalCount: allDatasets.length,
      eligibleCount: eligible.length,
      registryVersion: 'canonical-dataset-registry-v2-compatibility-aware',
      dataSource: 'live-database',
    }, { headers: noStore() });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unable to load the canonical dataset registry.',
    }, { status: 503, headers: noStore() });
  }
}
