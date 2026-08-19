import { NextRequest, NextResponse } from 'next/server';
import {
  buildUnifiedMultiHorizonDataset,
  listUnifiedMultiHorizonDatasets,
} from '@/lib/ml-unified-horizon-dataset-builder';
import { DEFAULT_UNIFIED_HORIZONS } from '@/lib/ml-unified-horizon-contract';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol') || undefined;
    const datasets = await listUnifiedMultiHorizonDatasets(symbol);
    return NextResponse.json({ success: true, datasets, defaultHorizons: DEFAULT_UNIFIED_HORIZONS });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to list unified multi-horizon datasets.' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol = String(body.symbol || '').trim().toUpperCase();
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'Symbol is required.' }, { status: 400 });
    }

    const horizons = Array.isArray(body.horizons) && body.horizons.length > 0 ? body.horizons : undefined;
    const name = body.name ? String(body.name).trim() : undefined;
    const maxSamples = body.maxSamples ? Number(body.maxSamples) : undefined;

    const result = await buildUnifiedMultiHorizonDataset({
      symbol,
      name,
      horizons,
      maxSamples,
    });

    return NextResponse.json({ success: true, dataset: result });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to build unified multi-horizon dataset.' },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const datasetId = String(body.datasetId || '').trim();
    const datasetIds = Array.isArray(body.datasetIds) ? body.datasetIds.map(String) : [];

    const { deleteUnifiedMultiHorizonDataset } = await import('@/lib/ml-unified-horizon-dataset-builder');

    if (datasetId) {
      await deleteUnifiedMultiHorizonDataset(datasetId);
      return NextResponse.json({ success: true, deletedCount: 1 });
    }

    if (datasetIds.length > 0) {
      let count = 0;
      for (const id of datasetIds) {
        if (id) {
          await deleteUnifiedMultiHorizonDataset(id);
          count++;
        }
      }
      return NextResponse.json({ success: true, deletedCount: count });
    }

    return NextResponse.json({ success: false, error: 'datasetId or datasetIds required' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to delete unified multi-horizon dataset.' },
      { status: 500 },
    );
  }
}
