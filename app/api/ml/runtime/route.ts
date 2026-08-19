import { NextRequest, NextResponse } from 'next/server';
import { mlRuntimeClient } from '@/lib/ml-runtime-client';
import { materializeModelArtifact } from '@/lib/ml-model-artifact-store';

const ALLOWED_ACTIONS = new Set([
  'predict',
  'predict_ensemble',
  'train',
  'train_partitioned',
  'train_horizon_cohort',
  'train_unified_multi_horizon',
  'list_models',
  'ping',
  'backtest',
]);

export async function POST(req: NextRequest) {
  try {
    const adminSecret = process.env.ADMIN_SECRET_KEY?.trim();
    if (adminSecret) {
      const headerSecret = req.headers.get('x-admin-secret')?.trim() || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
      if (!headerSecret || headerSecret !== adminSecret) {
        return NextResponse.json({ success: false, error: 'UNAUTHORIZED_ML_RUNTIME_ACCESS' }, { status: 401 });
      }
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'INVALID_REQUEST_BODY' }, { status: 400 });
    }

    const { action, payload } = body;
    if (!action || typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
      return NextResponse.json({ success: false, error: `UNSUPPORTED_ACTION: ${action}` }, { status: 400 });
    }

    const effectivePayload = payload && typeof payload === 'object' ? { ...payload } : {};

    // When running predict_ensemble remotely on the Python server, ensure all production model artifacts are materialized locally on this server's filesystem
    if (action === 'predict_ensemble' && effectivePayload.productionModels && typeof effectivePayload.productionModels === 'object') {
      const updatedModels: Record<string, any> = {};
      for (const [key, model] of Object.entries(effectivePayload.productionModels as Record<string, any>)) {
        if (model && typeof model === 'object') {
          const modelCopy = { ...model };
          if (modelCopy.modelId) {
            try {
              const materialized = await materializeModelArtifact(String(modelCopy.modelId));
              modelCopy.artifactPath = materialized.path;
              modelCopy.artifactSha256 = materialized.sha256;
              modelCopy.artifactByteSize = materialized.byteSize;
            } catch (matErr: any) {
              console.warn(`[ML Runtime Bridge] Artifact materialize notice for ${modelCopy.modelId}:`, matErr?.message);
            }
          }
          updatedModels[key] = modelCopy;
        }
      }
      effectivePayload.productionModels = updatedModels;
    }

    const result = await mlRuntimeClient.sendCommandDirectLocal(action as any, effectivePayload);
    return NextResponse.json(result, { status: result?.success ? 200 : 500 });
  } catch (error: any) {
    console.error('[ML Runtime Bridge Error]:', error);
    return NextResponse.json({ success: false, error: error?.message || 'ML_RUNTIME_BRIDGE_FAILURE' }, { status: 500 });
  }
}
