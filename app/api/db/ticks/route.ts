import { NextRequest, NextResponse } from 'next/server';
import { initDbSchema, saveTicksBatch, getTicksHistory } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const isDbConnected = await initDbSchema();
    const body = await req.json();
    const { symbol = 'R_100', ticks = [] } = body;

    if (!Array.isArray(ticks) || ticks.length === 0) {
      return NextResponse.json({ success: false, message: 'No ticks provided' }, { status: 400 });
    }

    if (isDbConnected) {
      await saveTicksBatch(symbol, ticks);
    }

    return NextResponse.json({
      success: true,
      symbol,
      recordedCount: ticks.length,
      isDbConnected,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Tick recording failed' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    await initDbSchema();
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol') || 'R_100';
    const limit = parseInt(searchParams.get('limit') || '100', 10);

    const history = await getTicksHistory(symbol, limit);
    return NextResponse.json({
      symbol,
      count: history.length,
      ticks: history,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch ticks' }, { status: 500 });
  }
}
