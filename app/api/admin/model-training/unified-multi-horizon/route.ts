import { NextRequest, NextResponse } from 'next/server';
import {
  trainUnifiedMultiHorizonModel,
  listUnifiedTrainingRuns,
} from '@/lib/ml-unified-horizon-orchestrator';
import { promoteSuiteInRegistry } from '@/lib/ml-suite-promoter';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol') || undefined;
    const runs = await listUnifiedTrainingRuns(symbol);
    return NextResponse.json({ success: true, runs });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to list unified multi-horizon training runs.' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const datasetId = String(body.datasetId || '').trim();
    if (!datasetId) {
      return NextResponse.json({ success: false, error: 'datasetId is required.' }, { status: 400 });
    }

    const requestedType = String(body.modelType || 'xgboost').toLowerCase();
    const isFullFleet = requestedType === 'suite' || requestedType === 'fleet' || Boolean(body.trainFullSuite) || (Array.isArray(body.modelTypes) && body.modelTypes.length > 1);
    const targetModelTypes: Array<'xgboost' | 'lightgbm' | 'catboost'> = isFullFleet
      ? ['xgboost', 'lightgbm', 'catboost']
      : [requestedType as any];

    const hyperparameters = body.hyperparameters || undefined;
    const autoPromoteSuite = Boolean(body.autoPromoteSuite);

    const results: any[] = [];
    let totalPromotedCount = 0;

    for (const mType of targetModelTypes) {
      const result = await trainUnifiedMultiHorizonModel({
        datasetId,
        modelType: mType,
        hyperparameters: hyperparameters?.[mType] || hyperparameters,
      });

      results.push(result);

      if (autoPromoteSuite && result?.modelId) {
        try {
          const promoteRes = await promoteSuiteInRegistry({ trainingRunId: result.modelId });
          if (promoteRes?.success) {
            totalPromotedCount += promoteRes.promotedCount || 0;
          }
        } catch (e) {
          console.error(`[AutoPromoteSuite Error for ${mType}]:`, e);
        }
      }
    }

    const primaryResult = results[0];
    return NextResponse.json({
      success: true,
      result: primaryResult,
      results,
      isFullFleet,
      fleetCount: results.length,
      autoPromotedCount: totalPromotedCount,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Unified multi-horizon training failed.' },
      { status: 500 },
    );
  }
}
