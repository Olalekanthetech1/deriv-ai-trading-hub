import { NextResponse } from 'next/server';
import { mlRuntimeClient } from '@/lib/ml-runtime-client';

export async function GET() {
  try {
    if (!mlRuntimeClient.isAvailable()) {
      return NextResponse.json({
        success: false,
        dataSource: 'native-runtime-unavailable',
        totalFeatures: 0,
        features: [],
        hyperparameters: null,
        error: 'Native ML runtime is unavailable; feature importance is not fabricated from static weights.',
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }

    return NextResponse.json({
      success: false,
      dataSource: 'native-runtime-no-feature-importance-contract',
      totalFeatures: 0,
      features: [],
      hyperparameters: null,
      error: 'The native runtime does not currently expose persisted model feature importance. No synthetic feature weights are returned.',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json({
      success: false,
      dataSource: 'unavailable',
      totalFeatures: 0,
      features: [],
      hyperparameters: null,
      error: err?.message || 'Feature importance is unavailable.',
    }, { status: 503 });
  }
}
