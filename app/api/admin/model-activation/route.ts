import { NextRequest, NextResponse } from 'next/server';
import { getRegisteredModels, promoteModelInRegistry, initDbSchema, getDb } from '@/lib/db';
import { verifySessionToken } from '../../admin/auth/route';
import { hasModelArtifact } from '@/lib/ml-model-artifact-store';
import { getLiveRiseFallSymbols, type RiseFallSymbolMetadata } from '@/lib/rise-fall-symbols';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });
  }

  try {
    const dbReady = await initDbSchema();
    if (!dbReady) {
      return NextResponse.json({ success: false, error: 'Database unavailable' }, { status: 503 });
    }

    const sql = getDb();
    const [allModels, liveSymbols, artifactRows] = await Promise.all([
      getRegisteredModels().then((res) => res || []),
      getLiveRiseFallSymbols().catch(() => [] as RiseFallSymbolMetadata[]),
      sql
        ? sql`SELECT DISTINCT model_id FROM ml_model_artifacts WHERE artifact_status IN ('active', 'superseded')`.catch(() => [])
        : Promise.resolve([]),
    ]);

    const artifactModelIds = new Set(
      Array.isArray(artifactRows) ? artifactRows.map((r: any) => String(r.model_id)) : []
    );
    
    // Group models by symbol
    const activeProduction = allModels.filter((m: any) => String(m.status).toLowerCase() === 'production');
    const retired = allModels.filter((m: any) => ['retired', 'archived'].includes(String(m.status).toLowerCase()));
    const candidates = allModels.filter((m: any) => {
      const statusStr = String(m.status || '').toLowerCase();
      return statusStr !== 'production' && !['retired', 'archived'].includes(statusStr);
    });

    // Collect all unique symbols between live dynamic symbols and any symbols in the registry
    const symbolMap = new Map<string, { symbol: string; displayName: string; market: string; submarket: string }>();

    for (const sym of liveSymbols) {
      symbolMap.set(sym.symbol, {
        symbol: sym.symbol,
        displayName: sym.displayName,
        market: sym.market,
        submarket: sym.submarket,
      });
    }

    for (const model of allModels) {
      if (model.asset_symbol && !symbolMap.has(model.asset_symbol)) {
        symbolMap.set(model.asset_symbol, {
          symbol: model.asset_symbol,
          displayName: model.asset_symbol,
          market: 'synthetic_index',
          submarket: 'random_index',
        });
      }
    }

    // Map each known rise-fall asset
    const fleetStatus = Array.from(symbolMap.values()).map((asset) => {
      const prodModels = activeProduction.filter((m: any) => m.asset_symbol === asset.symbol);
      const candModels = candidates.filter((m: any) => m.asset_symbol === asset.symbol);

      return {
        symbol: asset.symbol,
        displayName: asset.displayName,
        market: asset.market,
        submarket: asset.submarket,
        hasProductionModel: prodModels.length > 0,
        productionCount: prodModels.length,
        candidateCount: candModels.length,
        activeModels: prodModels.map((m: any) => ({
          modelId: m.model_id,
          modelFamily: m.model_family,
          version: m.version,
          horizonTicks: m.horizon_ticks,
          accuracy: (m.metrics as any)?.accuracy ?? null,
          f1: (m.metrics as any)?.f1 ?? null,
          updatedAt: m.updated_at,
        })),
      };
    });

    return NextResponse.json({
      success: true,
      fleetStatus,
      candidates: candidates.map((m: any) => ({
        modelId: m.model_id,
        modelFamily: m.model_family,
        symbol: m.asset_symbol,
        horizonTicks: m.horizon_ticks,
        format: m.format,
        status: m.status,
        metrics: m.metrics,
        accuracy: (m.metrics as any)?.accuracy ?? null,
        f1: (m.metrics as any)?.f1 ?? null,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        hasArtifact: artifactModelIds.has(m.model_id),
      })),
      productionModels: activeProduction.map((m: any) => ({
        modelId: m.model_id,
        modelFamily: m.model_family,
        symbol: m.asset_symbol,
        horizonTicks: m.horizon_ticks,
        accuracy: (m.metrics as any)?.accuracy ?? null,
        f1: (m.metrics as any)?.f1 ?? null,
        updatedAt: m.updated_at,
      })),
      counts: {
        totalModels: allModels.length,
        production: activeProduction.length,
        candidates: candidates.length,
        retired: retired.length,
        assetsCovered: fleetStatus.filter(f => f.hasProductionModel).length,
        totalAssets: fleetStatus.length,
      }
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || 'Failed to fetch activation catalog' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });
  }

  try {
    const dbReady = await initDbSchema();
    if (!dbReady) {
      return NextResponse.json({ success: false, error: 'Database unavailable' }, { status: 503 });
    }

    const body = await req.json().catch(() => ({}));
    const { modelId, symbol, horizonTicks, force } = body;

    if (!modelId || !symbol) {
      return NextResponse.json({ success: false, error: 'modelId and symbol are required.' }, { status: 400 });
    }

    const sql = getDb();
    if (!sql) {
      return NextResponse.json({ success: false, error: 'Database client unavailable.' }, { status: 503 });
    }

    // Verify model exists
    const rows = await sql`
      SELECT model_id, asset_symbol, horizon_ticks, model_family, metrics, status
      FROM ml_model_registry_v2
      WHERE model_id = ${modelId}
      LIMIT 1
    `;

    const model = rows[0] as any;
    if (!model) {
      return NextResponse.json({ success: false, error: `Model ${modelId} is not found in the registry.` }, { status: 404 });
    }

    const resolvedHorizon = Number(horizonTicks ?? model.horizon_ticks ?? 5);

    // Verify artifact is intact
    const artifactExists = await hasModelArtifact(modelId);
    if (!artifactExists) {
      return NextResponse.json({ 
        success: false, 
        error: `Cannot activate model ${modelId}: Native model artifact file is missing from storage.` 
      }, { status: 422 });
    }

    // Direct promote to production
    const success = await promoteModelInRegistry(modelId, symbol, resolvedHorizon);
    if (!success) {
      return NextResponse.json({ success: false, error: 'Database update failed during model activation.' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: `Model ${modelId} successfully activated as Live Production Champion for ${symbol} @ ${resolvedHorizon}t.`,
      modelId,
      symbol,
      horizonTicks: resolvedHorizon,
      activatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || 'Activation failed' }, { status: 500 });
  }
}
