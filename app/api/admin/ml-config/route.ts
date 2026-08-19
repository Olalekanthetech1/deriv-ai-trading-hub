import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { verifySessionToken } from '@/app/api/admin/auth/route';
import { recordObservabilityEvent } from '@/lib/observability';
import {
  getMlPipelineConfigRuntime,
  initializeMlPipelineConfig,
  reloadMlPipelineConfig,
  validateMlPipelineConfig,
} from '@/lib/ml-pipeline-config';
import { buildMlRuntimeSchemaContract } from '@/lib/ml-runtime-schema';
import { buildBootstrapMlPipelineConfig } from '@/lib/ml-pipeline-registry';
import { getDurationFeaturePolicyExamples } from '@/lib/ml-duration-feature-policy';
import {
  activateMlPipelineConfigVersion,
  createMlPipelineConfigVersion,
  getMlPipelineConfigVersion,
  listMlPipelineConfigs,
} from '@/lib/ml-pipeline-config-store';
import {
  getMlEnsembleAnalysisRuntimeConfig,
  updateMlEnsembleAnalysisRuntimeConfig,
} from '@/lib/ops-runtime-config';

export const runtime = 'nodejs';

function noStore() { return { 'Cache-Control': 'no-store, max-age=0' }; }
function isAdmin(req: NextRequest): boolean {
  const cookie = req.cookies.get('admin_session_token')?.value;
  const header = req.headers.get('x-admin-token');
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookie) || verifySessionToken(header) || verifySessionToken(bearer);
}
function requestId(req: NextRequest): string { return req.headers.get('x-request-id')?.trim() || crypto.randomUUID(); }

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401, headers: noStore() });
  try {
    const runtimeConfig = await initializeMlPipelineConfig();
    const contract = buildMlRuntimeSchemaContract(runtimeConfig.config);
    const history = await listMlPipelineConfigs(25);
    const ensembleControls = await getMlEnsembleAnalysisRuntimeConfig();
    return NextResponse.json({
      success: true,
      active: { ...runtimeConfig, config: runtimeConfig.config, runtimeSchema: contract },
      ensembleControls,
      durationFeaturePolicy: {
        mode: 'duration-aware-log-scaled',
        baselineTopology: { micro: 5, short: 25, medium: 100, macro: 300 },
        examples: getDurationFeaturePolicyExamples(),
      },
      history,
      canonical: {
        featureCount: contract.featureCount,
        featureOrder: contract.featureOrder,
        featureDefinitions: contract.featureDefinitions,
        featureWindows: contract.featureWindows,
        canonicalFeatureWindowTicks: contract.canonicalFeatureWindowTicks,
        sequenceLength: contract.sequenceLength,
        splitRatios: contract.splitRatios,
        normalizationMethod: contract.normalizationMethod,
        normalizationEpsilon: contract.normalizationEpsilon,
        schemaFingerprint: contract.schemaFingerprint,
        featureSchemaVersion: contract.featureSchemaVersion,
      },
    }, { headers: noStore() });
  } catch (error) {
    console.error('[Admin ML Config GET]', error);
    return NextResponse.json({ success: false, error: 'Unable to load ML pipeline configuration.' }, { status: 500, headers: noStore() });
  }
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401, headers: noStore() });
  const id = requestId(req);
  try {
    const body = await req.json();
    const action = typeof body?.action === 'string' ? body.action.trim() : '';

    if (action === 'update_ensemble_controls') {
      const updated = await updateMlEnsembleAnalysisRuntimeConfig({
        enableRegimeModel: typeof body.enableRegimeModel === 'boolean' ? body.enableRegimeModel : undefined,
        enableAnomalyModel: typeof body.enableAnomalyModel === 'boolean' ? body.enableAnomalyModel : undefined,
        enableDeepSequentialModels: typeof body.enableDeepSequentialModels === 'boolean' ? body.enableDeepSequentialModels : undefined,
        fallbackBehavior: body.fallbackBehavior === 'strict_require' ? 'strict_require' : 'graceful_degrade',
        updatedBy: 'admin',
      });
      void recordObservabilityEvent({
        category: 'ml',
        severity: 'info',
        service: 'ml-config',
        eventType: 'ensemble_controls_updated',
        message: `Ensemble analysis controls updated. Regime Model: ${updated.enableRegimeModel ? 'ACTIVE' : 'DEACTIVATED'}, Anomaly Model: ${updated.enableAnomalyModel ? 'ACTIVE' : 'DEACTIVATED'}.`,
        requestId: id,
        metadata: { ...updated },
      });
      return NextResponse.json({ success: true, ensembleControls: updated }, { headers: noStore() });
    }

    if (action === 'generate') {
      const current = getMlPipelineConfigRuntime().config;
      const source = buildBootstrapMlPipelineConfig();
      const input = body?.config && typeof body.config === 'object' ? body.config : {};
      const merged = { ...source, ...current, ...input, featureWindows: source.featureWindows, canonicalFeatureWindowTicks: source.canonicalFeatureWindowTicks, featureOrder: source.featureOrder, splitRatios: { ...current.splitRatios, ...(input.splitRatios && typeof input.splitRatios === 'object' ? input.splitRatios : {}) } };
      const validated = validateMlPipelineConfig(merged);
      const contract = buildMlRuntimeSchemaContract(validated);
      const created = await createMlPipelineConfigVersion(validated, contract.featureSchemaVersion, 'admin');
      if (!created) return NextResponse.json({ success: false, error: 'Configuration generation failed.' }, { status: 500, headers: noStore() });
      void recordObservabilityEvent({ category: 'ml', severity: 'info', service: 'ml-config', eventType: 'config_generated', message: 'A new ML pipeline configuration version was generated from the canonical runtime schema contract.', requestId: id, metadata: { version: created.version, configHash: created.configHash, featureSchemaVersion: contract.featureSchemaVersion, schemaFingerprint: contract.schemaFingerprint } });
      return NextResponse.json({ success: true, generated: { ...created, runtimeSchema: contract } }, { headers: noStore() });
    }
    if (action === 'activate') {
      const versionId = typeof body?.id === 'string' ? body.id.trim() : '';
      if (!versionId) return NextResponse.json({ success: false, error: 'Configuration version id is required.' }, { status: 400, headers: noStore() });
      const existing = await getMlPipelineConfigVersion(versionId);
      if (!existing) return NextResponse.json({ success: false, error: 'Configuration version was not found.' }, { status: 404, headers: noStore() });
      const validated = validateMlPipelineConfig(existing.config);
      const contract = buildMlRuntimeSchemaContract(validated);
      if (existing.featureSchemaVersion !== contract.featureSchemaVersion) return NextResponse.json({ success: false, error: 'Configuration version has a stale feature schema fingerprint. Generate a new configuration version before activation.', expectedFeatureSchemaVersion: contract.featureSchemaVersion, storedFeatureSchemaVersion: existing.featureSchemaVersion, schemaFingerprint: contract.schemaFingerprint }, { status: 409, headers: noStore() });
      const activated = await activateMlPipelineConfigVersion(versionId);
      if (!activated) return NextResponse.json({ success: false, error: 'Configuration activation failed.' }, { status: 500, headers: noStore() });
      await reloadMlPipelineConfig();
      void recordObservabilityEvent({ category: 'ml', severity: 'info', service: 'ml-config', eventType: 'config_activated', message: 'An ML pipeline configuration version was activated after runtime schema validation.', requestId: id, metadata: { version: activated.version, configHash: activated.configHash, featureSchemaVersion: contract.featureSchemaVersion, schemaFingerprint: contract.schemaFingerprint } });
      return NextResponse.json({ success: true, activated: { ...activated, config: validated, runtimeSchema: contract } }, { headers: noStore() });
    }
    return NextResponse.json({ success: false, error: 'Unsupported configuration action.' }, { status: 400, headers: noStore() });
  } catch (error) {
    console.error('[Admin ML Config POST]', error);
    const message = error instanceof Error ? error.message : 'ML pipeline configuration request failed.';
    return NextResponse.json({ success: false, error: message }, { status: 400, headers: noStore() });
  }
}
