import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../auth/route';
import { getMlModelKeys, type MlModelKey } from '@/lib/ml-model-registry';
import { listTrainingRuns } from '@/lib/ml-training-orchestrator';
import { clearFailedTrainingRunHistory, clearTerminalTrainingQueueHistory } from '@/lib/ml-training-history';
import { enqueueTrainingJob, listTrainingQueueJobs, recoverAbandonedTrainingJobs } from '@/lib/ml-training-queue';
import { resolveTrainingDedup } from '@/lib/ml-training-dedup';
import { mlRuntimeClient } from '@/lib/ml-runtime-client';
import { formatReadableAsset } from '@/lib/ml-display-formatters';

function isAdmin(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(verifySessionToken(cookieToken) || verifySessionToken(headerToken));
}
function noStore() { return { 'Cache-Control': 'no-store, max-age=0' }; }

function withLiveDiagnostics(runs: any[]) {
  return runs.map((run) => ({
    ...run,
    models: Array.isArray(run?.models) ? run.models.map((model: any) => {
      const live = mlRuntimeClient.getLiveTrainingDiagnostic(String(run.run_id), String(model.model_type));
      if (!live) return model;
      const metrics = model.metrics && typeof model.metrics === 'object' ? model.metrics : {};
      const timings = live.timings && typeof live.timings === 'object' ? live.timings : {};
      return {
        ...model,
        metrics: {
          ...metrics,
          timings: { ...(metrics.timings && typeof metrics.timings === 'object' ? metrics.timings : {}), ...timings },
          liveDiagnostics: {
            phase: live.phase,
            elapsedMs: live.elapsedMs,
            message: live.message,
            updatedAt: live.updatedAt,
            source: 'native-python-runtime-live',
          },
        },
      };
    }) : run?.models,
  }));
}

function withReadableAssets(runs: any[]) {
  return runs.map((run) => ({
    ...run,
    raw_asset_symbol: run.asset_symbol,
    asset_symbol: formatReadableAsset(run.asset_symbol),
    models: Array.isArray(run.models) ? run.models : [],
  }));
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    await recoverAbandonedTrainingJobs();
    const symbol = req.nextUrl.searchParams.get('symbol')?.trim().toUpperCase() || undefined;
    const [runs, queue] = await Promise.all([listTrainingRuns(symbol), listTrainingQueueJobs()]);
    return NextResponse.json({
      success: true,
      // `runs` is the canonical persisted training-run collection only.
      // Queue jobs remain in `queue` and must never be synthesized into run records.
      runs: withReadableAssets(withLiveDiagnostics(runs)),
      queue,
      modelTypes: getMlModelKeys(),
      dataSource: 'live-database-plus-native-runtime-plus-worker-queue',
    }, { headers: noStore() });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unable to load training runs.' }, { status: 503, headers: noStore() });
  }
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    const body = await req.json().catch(() => ({}));
    const datasetId = typeof body?.datasetId === 'string' ? body.datasetId.trim() : '';
    if (!datasetId) return NextResponse.json({ success: false, error: 'datasetId is required. Select a completed leakage-validated dataset.' }, { status: 400, headers: noStore() });
    const requested = Array.isArray(body?.modelTypes) ? body.modelTypes.filter((value: unknown): value is MlModelKey => typeof value === 'string' && getMlModelKeys().includes(value as MlModelKey)) : undefined;
    if (Array.isArray(body?.modelTypes) && body.modelTypes.length > 0 && (!requested || requested.length !== body.modelTypes.length)) return NextResponse.json({ success: false, error: 'One or more requested model types are not registered for production training. Experimental models must be launched explicitly from the Experimental Lab.' }, { status: 400, headers: noStore() });

    const retryFailed = body?.retryFailed === true;
    const requestedModels = requested?.length ? requested : getMlModelKeys();
    const dedup = await resolveTrainingDedup(datasetId, requestedModels, retryFailed);

    if (!dedup.allowedModelTypes.length) {
      if (dedup.skippedCompletedModelTypes.length) throw new Error(`TRAINING_ALREADY_COMPLETED:${dedup.skippedCompletedModelTypes.join(',')}`);
      if (dedup.blockedFailedModelTypes.length) throw new Error(`TRAINING_RETRY_FAILED_EXPLICIT:${dedup.blockedFailedModelTypes.join(',')}`);
      throw new Error('NO_NEW_MODEL_TRAINING_REQUIRED');
    }

    const job = await enqueueTrainingJob({ datasetId, modelTypes: dedup.allowedModelTypes });
    return NextResponse.json({
      success: true,
      queued: true,
      dataSource: 'persisted-real-tick-dataset',
      workerBoundary: 'dedicated-ml-worker',
      skippedCompletedModelTypes: dedup.skippedCompletedModelTypes,
      blockedFailedModelTypes: dedup.blockedFailedModelTypes,
      ...job,
    }, { status: 202, headers: noStore() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Model training could not be queued.';
    const status = /TRAINING_ALREADY_|TRAINING_RETRY_FAILED_EXPLICIT|NO_NEW_MODEL_TRAINING_REQUIRED/i.test(message) ? 409 : /REQUIRED/i.test(message) ? 400 : /DATABASE/i.test(message) ? 503 : 500;
    return NextResponse.json({ success: false, error: message }, { status, headers: noStore() });
  }
}

export async function DELETE(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    const confirmation = req.headers.get('x-confirm-training-history-reset');
    if (confirmation !== 'DELETE_TRAINING_HISTORY') return NextResponse.json({ success: false, error: 'Explicit confirmation is required to clear failed training history.' }, { status: 400, headers: noStore() });

    const deletedQueueJobs = await clearTerminalTrainingQueueHistory();
    const result = await clearFailedTrainingRunHistory();
    return NextResponse.json({
      success: true,
      message: 'Failed training history cleared. Completed and partial runs, datasets, samples, registered models, artifacts, market data and configuration were preserved.',
      deletedQueueJobs,
      ...result,
    }, { headers: noStore() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to clear failed training history.';
    if (message === 'TRAINING_HISTORY_RESET_BLOCKED_BY_RUNNING_JOBS') {
      const runningRuns = (error as Error & { runningRuns?: unknown[]; runningQueueJobs?: unknown[] }).runningRuns || (error as Error & { runningQueueJobs?: unknown[] }).runningQueueJobs || [];
      return NextResponse.json({ success: false, error: 'Failed history cannot be cleared while training work is active. Let the active job finish first.', code: message, runningRuns }, { status: 409, headers: noStore() });
    }
    return NextResponse.json({ success: false, error: message }, { status: 503, headers: noStore() });
  }
}