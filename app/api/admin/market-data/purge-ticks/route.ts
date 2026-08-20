import { NextRequest, NextResponse } from 'next/server';
import { purgeMarketTicksForSymbol } from '@/lib/deriv-historical-ingestion';
import { canonicalizeDerivSymbol, isValidDerivSymbol } from '@/lib/deriv-symbol-utils';
import { verifySessionToken } from '@/app/api/admin/auth/route';

function isAuthorized(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  if (verifySessionToken(cookieToken) === true) return true;

  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (verifySessionToken(headerToken) === true) return true;

  const secret = process.env.ADMIN_SECRET_KEY?.trim();
  if (secret) {
    const rawKey = req.headers.get('x-admin-secret') || req.headers.get('x-admin-key') || headerToken;
    if (rawKey && rawKey === secret) return true;
  }

  return false;
}

function jsonHeaders() {
  return { 'Cache-Control': 'no-store, max-age=0' };
}

function normalizeSymbol(symbol: unknown): string {
  if (typeof symbol !== 'string') return '';
  const trimmed = symbol.trim();
  if (trimmed.toUpperCase() === 'ALL' || trimmed === '*') return 'ALL';
  return canonicalizeDerivSymbol(trimmed);
}

function normalizeSymbols(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(values.map(normalizeSymbol).filter((s) => s.length > 0))];
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Invalid or missing admin credentials.' },
      { status: 401, headers: jsonHeaders() }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const rawSymbol = body?.symbol;
    const rawSymbols = body?.symbols;
    const confirm = body?.confirm !== false; // Default true if explicitly invoked
    const reason = typeof body?.reason === 'string' && body.reason.trim().length > 0 ? body.reason.trim() : 'admin_purge_button';

    const symbols = normalizeSymbols(rawSymbols || rawSymbol);
    if (!symbols.length) {
      return NextResponse.json(
        { success: false, error: 'Asset symbol is required to purge stored ticks (e.g. 1HZ100V or ALL).' },
        { status: 400, headers: jsonHeaders() }
      );
    }

    if (!confirm) {
      return NextResponse.json(
        { success: false, error: 'Confirmation is required for tick deletion.' },
        { status: 400, headers: jsonHeaders() }
      );
    }

    const results: Array<{
      symbol: string;
      deletedTicks: number;
      deletedCheckpoints: number;
      deletedRuns: number;
    }> = [];

    for (const sym of symbols) {
      const res = await purgeMarketTicksForSymbol(sym, { actor: 'admin', reason });
      results.push(res);
    }

    const totalTicks = results.reduce((sum, r) => sum + r.deletedTicks, 0);
    const totalCheckpoints = results.reduce((sum, r) => sum + r.deletedCheckpoints, 0);
    const single = results.length === 1 ? results[0] : null;

    return NextResponse.json(
      {
        success: true,
        message: single
          ? `Successfully purged ${single.deletedTicks.toLocaleString()} tick record${single.deletedTicks === 1 ? '' : 's'} and reset checkpoint for ${single.symbol}.`
          : `Successfully purged ${totalTicks.toLocaleString()} tick record${totalTicks === 1 ? '' : 's'} across ${results.length} asset${results.length === 1 ? '' : 's'}.`,
        symbol: single?.symbol ?? (symbols.includes('ALL') ? 'ALL' : symbols.join(',')),
        symbols: results.map((r) => r.symbol),
        deletedTicks: totalTicks,
        deletedCheckpoints: totalCheckpoints,
        results,
        audited: true,
      },
      { headers: jsonHeaders() }
    );
  } catch (error: any) {
    console.error('[admin/market-data/purge-ticks] Purge failed', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to purge stored ticks from database.' },
      { status: 500, headers: jsonHeaders() }
    );
  }
}

export async function DELETE(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Invalid or missing admin credentials.' },
      { status: 401, headers: jsonHeaders() }
    );
  }

  try {
    const url = new URL(req.url);
    const rawSymbol = url.searchParams.get('symbol');
    const rawSymbols = url.searchParams.get('symbols');
    const reason = url.searchParams.get('reason') || 'admin_delete_call';

    const symbols = normalizeSymbols(rawSymbols || rawSymbol);
    if (!symbols.length) {
      return NextResponse.json(
        { success: false, error: 'Asset symbol parameter is required to purge stored ticks (e.g. ?symbol=1HZ100V).' },
        { status: 400, headers: jsonHeaders() }
      );
    }

    const results: Array<{
      symbol: string;
      deletedTicks: number;
      deletedCheckpoints: number;
      deletedRuns: number;
    }> = [];

    for (const sym of symbols) {
      const res = await purgeMarketTicksForSymbol(sym, { actor: 'admin', reason });
      results.push(res);
    }

    const totalTicks = results.reduce((sum, r) => sum + r.deletedTicks, 0);
    const totalCheckpoints = results.reduce((sum, r) => sum + r.deletedCheckpoints, 0);
    const single = results.length === 1 ? results[0] : null;

    return NextResponse.json(
      {
        success: true,
        message: single
          ? `Successfully purged ${single.deletedTicks.toLocaleString()} tick record${single.deletedTicks === 1 ? '' : 's'} and reset checkpoint for ${single.symbol}.`
          : `Successfully purged ${totalTicks.toLocaleString()} tick record${totalTicks === 1 ? '' : 's'} across ${results.length} asset${results.length === 1 ? '' : 's'}.`,
        symbol: single?.symbol ?? (symbols.includes('ALL') ? 'ALL' : symbols.join(',')),
        symbols: results.map((r) => r.symbol),
        deletedTicks: totalTicks,
        deletedCheckpoints: totalCheckpoints,
        results,
        audited: true,
      },
      { headers: jsonHeaders() }
    );
  } catch (error: any) {
    console.error('[admin/market-data/purge-ticks] DELETE failed', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to purge stored ticks from database.' },
      { status: 500, headers: jsonHeaders() }
    );
  }
}
