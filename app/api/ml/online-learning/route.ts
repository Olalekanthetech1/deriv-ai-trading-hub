import { NextRequest, NextResponse } from 'next/server';
import {
  getOnlineLearningState,
  recordModelOutcome,
  resetOnlineLearningStats,
} from '@/lib/ml-online-learning-state';

function isValidAction(value: unknown): value is 'reset' | 'record' {
  return value === 'reset' || value === 'record';
}

export async function GET() {
  try {
    const state = await getOnlineLearningState();
    return NextResponse.json({
      success: true,
      onlineLearning: state,
    });
  } catch (error) {
    console.error('[ML Online Learning GET]', error);
    return NextResponse.json(
      { error: 'Failed to fetch online learning state' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
    }

    const { action, modelKey, wasCorrect } = body as Record<string, unknown>;
    if (!isValidAction(action)) {
      return NextResponse.json({ error: 'Invalid action parameter' }, { status: 400 });
    }

    if (action === 'reset') {
      await resetOnlineLearningStats();
      return NextResponse.json({
        success: true,
        message: 'Online Learning statistics reset to baseline.',
        onlineLearning: await getOnlineLearningState(),
      });
    }

    if (typeof modelKey !== 'string' || !modelKey.trim()) {
      return NextResponse.json({ error: 'modelKey is required' }, { status: 400 });
    }
    if (typeof wasCorrect !== 'boolean') {
      return NextResponse.json({ error: 'wasCorrect must be a boolean' }, { status: 400 });
    }

    const stats = await recordModelOutcome(modelKey, wasCorrect);
    return NextResponse.json({
      success: true,
      message: `Recorded out-of-sample outcome for model ${modelKey}: ${wasCorrect ? 'WIN' : 'LOSS'}`,
      modelKey,
      stats,
      onlineLearning: await getOnlineLearningState(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Action failed';
    if (message === 'Invalid modelKey') {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error('[ML Online Learning POST]', error);
    return NextResponse.json({ error: 'Action failed' }, { status: 500 });
  }
}
