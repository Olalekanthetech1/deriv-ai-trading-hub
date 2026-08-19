import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getLiveRiseFallSymbols, type RiseFallSymbolMetadata } from '@/lib/rise-fall-symbols';

export type { RiseFallSymbolMetadata as ActiveSymbolItem };

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const forceRefresh = searchParams.get('refresh') === 'true' || searchParams.get('force') === 'true';

    const symbols = await getLiveRiseFallSymbols(forceRefresh);

    return NextResponse.json(
      {
        success: true,
        dataSource: 'deriv-live-rise-fall',
        tradeType: 'rise_fall',
        symbolCount: symbols.length,
        availableCount: symbols.filter((symbol) => symbol.isAvailable).length,
        openCount: symbols.filter((symbol) => symbol.isOpen).length,
        symbols,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: any) {
    logger.error(`Error in /api/symbols: ${err?.message || err}`);
    return NextResponse.json(
      {
        success: false,
        dataSource: 'deriv-unavailable',
        tradeType: 'rise_fall',
        symbols: [],
        error: err?.message || 'Unable to load live Deriv symbols supporting Rise/Fall.',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
