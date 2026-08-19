import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../../auth/route';
import { getMlModelKeys, type MlModelKey } from '@/lib/ml-model-registry';
import { getTrainingBatch } from '@/lib/ml-training-batch-orchestrator';
import { createTrainingBatchQueued, resumeTrainingBatchQueued } from '@/lib/ml-training-batch-queue';

function isAdmin(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

function noStore() { return { 'Cache-Control': 'no-store, max-age=0' }; }

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  const batchId = req.nextUrl.searchParams.get('batchId')?.trim();
  if (!batchId) return NextResponse.json({ success: false, error: 'batchId is required.' }, { status: 400, headers: noStore() });
  try {
    const batch = await getTrainingBatch(batchId);
    return NextResponse.json({ success: true, batch, modelTypes: getMlModelKeys(), dataSource: 'live-database-plus-dedicated-ml-worker' }, { headers: noStore() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load training batch.';
    return NextResponse.json({ success: false, error: message }, { status: /NOT_FOUND/i.test(message) ? 404 : 503, headers: noStore() });
  }
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action === 'resume') {
      const batchId = typeof body?.batchId === 'string' ? body.batchId.trim() : '';
      if (!batchId) return NextResponse.json({ success: false, error: 'batchId is required for resume.' }, { status: 400, headers: noStore() });
      const batch = await resumeTrainingBatchQueued(batchId);
      return NextResponse.json({ success: true, batch, resumed: true }, { status: 202, headers: noStore() });
    }

    const datasetIds = Array.isArray(body?.datasetIds) ? body.datasetIds : [];
    const modelTypes: MlModelKey[] | undefined = Array.isArray(body?.modelTypes)
      ? body.modelTypes.filter((value: unknown): value is MlModelKey => typeof value === 'string' && getMlModelKeys().includes(value as MlModelKey))
      : undefined;

    if (!datasetIds.length) return NextResponse.json({ success: false, error: 'Select at least one completed dataset.' }, { status: 400, headers: noStore() });
    if (Array.isArray(body?.modelTypes) && modelTypes && modelTypes.length !== body.modelTypes.length) return NextResponse.json({ success: false, error: 'One or more requested model types are not registered.' }, { status: 400, headers: noStore() });

    const result = await createTrainingBatchQueued({
      datasetIds,
      modelTypes,
      skipCompleted: body?.skipCompleted !== false,
      retryFailed: body?.retryFailed === true,
    });

    return NextResponse.json({ success: true, dataSource: 'persisted-real-tick-datasets-plus-dedicated-ml-worker', ...result }, { status: 202, headers: noStore() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create training batch.';
    const match = /^TRAINING_BATCH_ALREADY_RUNNING:([0-9a-f-]+):(queued|running)$/i.exec(message);
    if (match) {
      return NextResponse.json({
        success: false,
        error: 'An existing training batch is still active. Open or resume that batch before starting another plan.',
        code: 'TRAINING_BATCH_ALREADY_RUNNING',
        activeBatchId: match[1],
        activeBatchStatus: match[2].toLowerCase(),
      }, { status: 409, headers: noStore() });
    }
    const status = /ALREADY_RUNNING|BATCH_ALREADY_RUNNING|ALREADY_QUEUED/i.test(message) ? 409 : /DATASET|MODEL|SELECTED|LIMIT/i.test(message) ? 422 : /DATABASE/i.test(message) ? 503 : 500;
    return NextResponse.json({ success: false, error: message, code: 'TRAINING_BATCH_START_FAILED' }, { status, headers: noStore() });
  }
}
