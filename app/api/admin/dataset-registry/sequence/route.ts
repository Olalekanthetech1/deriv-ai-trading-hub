import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../../auth/route';
import { getMlModelDefinitions, type MlModelKey } from '@/lib/ml-model-registry';
import { listCanonicalMlDatasetsWithCompatibility } from '@/lib/ml-dataset-registry';
import { loadUnifiedSequenceDataset } from '@/lib/ml-unified-sequence-adapter';
import { enqueueSequenceTrainingJob, listSequenceTrainingQueueJobs } from '@/lib/ml-sequence-training-queue';
import { parseSequenceTrainingDatasetRef } from '@/lib/ml-sequence-training-contract';
import { trainUnifiedSequenceModels } from '@/lib/ml-unified-sequence-training-orchestrator';

export const dynamic = 'force-dynamic';

function isAdmin(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(verifySessionToken(cookieToken) || verifySessionToken(headerToken));
}

function noStore() {
  return { 'Cache-Control': 'no-store, max-age=0' };
}

const registeredModelKeys = new Set(
  getMlModelDefinitions().map((definition) => definition.key),
);

const sequenceModelKeys = new Set(
  getMlModelDefinitions().filter((definition) => definition.family === 'sequential').map((definition) => definition.key),
);

function normalizeModelTypes(value: unknown): MlModelKey[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is MlModelKey => typeof item === 'string' && registeredModelKeys.has(item as MlModelKey));
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  }

  try {
    const symbol = req.nextUrl.searchParams.get('symbol')?.trim().toUpperCase() || undefined;
    const datasets = await listCanonicalMlDatasetsWithCompatibility(symbol);
    const sequenceCandidates = datasets.filter((dataset) =>
      dataset.sourceType === 'duration' || dataset.sourceType === 'unified_multi_horizon',
    );

    const compatible = [];
    const rejected = [];

    for (const dataset of sequenceCandidates) {
      const seqCompat = dataset.compatibility?.architectures?.sequential;
      if (seqCompat && !seqCompat.compatible) {
        rejected.push({
          ...dataset,
          capability: 'sequence',
          adapterStatus: 'rejected',
          reason: seqCompat.reason || 'Dataset does not meet sequence sliding window requirements.',
          troubleshootingAdvice: 'Generate dataset with more contiguous samples to form sequence windows.',
        });
        continue;
      }

      compatible.push({
        ...dataset,
        capability: 'sequence',
        adapterStatus: dataset.sourceType === 'unified_multi_horizon' ? 'ready' : 'native',
        trainingSource: dataset.sourceType === 'unified_multi_horizon' ? 'unified' : 'duration',
        sequenceLength: seqCompat?.details?.sequenceLength ?? 10,
        trainSamples: seqCompat?.details?.trainSamples ?? dataset.trainCount,
        validationSamples: seqCompat?.details?.validationSamples ?? dataset.validationCount,
        testSamples: seqCompat?.details?.testSamples ?? dataset.testCount,
      });
    }

    const queue = await listSequenceTrainingQueueJobs();
    return NextResponse.json({
      success: true,
      datasets: compatible,
      rejected,
      queue,
      modelFamily: 'sequential',
      modelTypes: Array.from(sequenceModelKeys),
      totalCandidates: sequenceCandidates.length,
      compatibleCount: compatible.length,
      rejectedCount: rejected.length,
      dataSource: 'live-database-canonical-registry',
    }, { headers: noStore() });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unable to resolve sequence-compatible datasets.',
    }, { status: 503, headers: noStore() });
  }
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const datasetId = typeof body?.datasetId === 'string' ? body.datasetId.trim() : '';
    const horizonKey = typeof body?.horizonKey === 'string' ? body.horizonKey.trim().toLowerCase() : '';
    const sourceType = body?.sourceType === 'unified' || body?.sourceType === 'duration' ? body.sourceType : null;
    const requestedModels = normalizeModelTypes(body?.modelTypes);
    const autoPromote = body?.autoPromote !== false;

    if (!datasetId || !horizonKey || !sourceType) {
      return NextResponse.json({ success: false, error: 'datasetId, horizonKey, and sourceType are required.' }, { status: 400, headers: noStore() });
    }
    if (Array.isArray(body?.modelTypes) && requestedModels.length !== body.modelTypes.length) {
      return NextResponse.json({ success: false, error: 'Only registered ML models may be queued through this endpoint.' }, { status: 400, headers: noStore() });
    }

    const datasetRef = parseSequenceTrainingDatasetRef({
      datasetId: sourceType === 'unified' ? `unified:${datasetId}:${horizonKey}` : `duration:${datasetId}`,
      source: sourceType === 'unified'
        ? { sourceType: 'unified', sourceDatasetId: datasetId, horizonKey }
        : { sourceType: 'duration', sourceDatasetId: datasetId, horizonKey },
    });

    if (sourceType === 'unified') {
      await loadUnifiedSequenceDataset({ datasetId, horizonKey });
    }

    const job = await enqueueSequenceTrainingJob({
      datasetRef,
      modelTypes: requestedModels.length ? requestedModels : undefined,
    });

    return NextResponse.json({
      success: true,
      queued: true,
      autoPromote,
      dataSource: sourceType === 'unified' ? 'validated-unified-sequence-adapter' : 'canonical-duration-dataset',
      workerBoundary: 'dedicated-ml-worker',
      ...job,
    }, { status: 202, headers: noStore() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sequence training could not be queued.';
    const status = /ALREADY_QUEUED/i.test(message) ? 409 : /INVALID_|REQUIRES_|NOT_PRESENT|NOT_READY|INSUFFICIENT/i.test(message) ? 400 : /DATABASE/i.test(message) ? 503 : 500;
    return NextResponse.json({ success: false, error: message }, { status, headers: noStore() });
  }
}
