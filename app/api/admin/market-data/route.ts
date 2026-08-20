import { NextRequest, NextResponse } from 'next/server';
import {
  clearHistoricalIngestionRuns,
  getHistoricalIngestionCheckpoint,
  ingestDerivHistoricalTicks,
  listHistoricalIngestionRuns,
} from '@/lib/deriv-historical-ingestion';
import { ingestDerivHistoricalBackfill, ingestDerivHistoricalBatch } from '@/lib/historical-backfill-controller';
import { getMarketDataRuntimeConfig } from '@/lib/market-data-runtime-config';
import { canonicalizeDerivSymbol, isValidDerivSymbol } from '@/lib/deriv-symbol-utils';
import { verifySessionToken } from '../auth/route';

function isAuthenticated(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

function jsonHeaders() {
  return { 'Cache-Control': 'no-store, max-age=0' };
}

function normalizeSymbols(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(values.filter((item): item is string => typeof item === 'string').map((item) => canonicalizeDerivSymbol(item)).filter((item) => isValidDerivSymbol(item)))];
}

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: jsonHeaders() });
  }

  try {
    const config = getMarketDataRuntimeConfig();
    const url = new URL(req.url);
    const requestedSymbols = normalizeSymbols(url.searchParams.get('symbols') || url.searchParams.get('symbol') || '');
    const checkpointSymbols = requestedSymbols.length ? requestedSymbols : [];
    const [recentRuns, checkpoints] = await Promise.all([
      listHistoricalIngestionRuns(requestedSymbols.length > 0 ? 50 : 10),
      Promise.all(checkpointSymbols.map((symbol) => getHistoricalIngestionCheckpoint(symbol))),
    ]);

    return NextResponse.json({ success: true, dataSource: 'live-database', runtime: config, recentRuns, checkpoint: checkpoints.length === 1 ? checkpoints[0] : null, checkpoints, realDataOnly: true, syntheticDataDisabled: true }, { headers: jsonHeaders() });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Unable to load ingestion runtime configuration.' }, { status: 500, headers: jsonHeaders() });
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: jsonHeaders() });
  }

  try {
    const config = getMarketDataRuntimeConfig();
    const body = await req.json().catch(() => ({}));
    const symbols = normalizeSymbols(body?.symbols ?? body?.symbol);
    const count = Number(body?.count ?? 5000);
    const freshIngest = Boolean(body?.freshIngest ?? body?.fresh ?? (body?.mode === 'fresh'));
    const resumeFromCheckpoint = freshIngest ? false : Boolean(body?.resumeFromCheckpoint);

    if (!symbols.length) return NextResponse.json({ success: false, error: 'Select at least one valid Deriv asset.' }, { status: 400, headers: jsonHeaders() });
    if (config.maxAssets !== null && symbols.length > config.maxAssets) return NextResponse.json({ success: false, error: `A maximum of ${config.maxAssets} assets can be ingested in one batch.` }, { status: 422, headers: jsonHeaders() });
    if (!Number.isFinite(count) || count < 50 || count > 50000) return NextResponse.json({ success: false, error: 'Count must be between 50 and 50000.' }, { status: 400, headers: jsonHeaders() });

    if (symbols.length > 1) {
      const result = await ingestDerivHistoricalBatch({ symbols, targetCount: count, resumeFromCheckpoint, freshIngest, concurrency: config.concurrency });
      return NextResponse.json({ ...result, runtime: config, realDataOnly: true, syntheticDataDisabled: true }, { status: result.failedAssets === symbols.length ? 500 : 200, headers: jsonHeaders() });
    }

    const symbol = symbols[0];
    if (freshIngest) {
      const result = await ingestDerivHistoricalTicks({ symbol, count, resumeFromCheckpoint: false, freshIngest: true });
      const { success: _ignoredSuccess, ...ingestionResult } = result as typeof result & { success?: unknown };
      return NextResponse.json({ success: true, ...ingestionResult, runtime: config, freshIngest: true, realDataOnly: true, syntheticDataDisabled: true }, { headers: jsonHeaders() });
    }

    if (resumeFromCheckpoint) {
      const result = await ingestDerivHistoricalBackfill({ symbol, targetCount: count, freshIngest: false });
      return NextResponse.json({ success: true, ...result, runtime: config, realDataOnly: true, syntheticDataDisabled: true }, { headers: jsonHeaders() });
    }

    const checkpoint = await getHistoricalIngestionCheckpoint(symbol);
    const endEpoch = checkpoint?.lastTickEpoch ? Math.max(1, Math.floor(checkpoint.lastTickEpoch) - 1) : undefined;
    const result = await ingestDerivHistoricalTicks({ symbol, count, resumeFromCheckpoint: false, endEpoch });
    const { success: _ignoredSuccess, ...ingestionResult } = result as typeof result & { success?: unknown };
    return NextResponse.json({ success: true, ...ingestionResult, runtime: config, checkpointUsed: checkpoint, realDataOnly: true, syntheticDataDisabled: true }, { headers: jsonHeaders() });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Historical ingestion failed.', realDataOnly: true }, { status: 500, headers: jsonHeaders() });
  }
}

export async function DELETE(req: NextRequest) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401, headers: jsonHeaders() });
  }

  try {
    const url = new URL(req.url);
    const filterParam = url.searchParams.get('filter') || 'all';
    const runIdParam = url.searchParams.get('runId');

    let filter: 'all' | 'failed' | string[] = 'all';
    if (runIdParam) {
      filter = [runIdParam];
    } else if (filterParam === 'failed') {
      filter = 'failed';
    } else {
      filter = 'all';
    }

    const result = await clearHistoricalIngestionRuns(filter);
    return NextResponse.json({
      success: true,
      message: `Successfully cleared ${result.deletedCount} ingestion run record${result.deletedCount === 1 ? '' : 's'}.`,
      deletedCount: result.deletedCount,
    }, { headers: jsonHeaders() });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Failed to clear ingestion runs.' }, { status: 500, headers: jsonHeaders() });
  }
}
