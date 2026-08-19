import { NextRequest, NextResponse } from 'next/server';
import { initDbSchema, getDb } from '@/lib/db';
import { Redis } from '@upstash/redis';
import { logger } from '@/lib/logger';
import { verifySessionToken } from '../auth/route';
import { getLiveRiseFallSymbols } from '@/lib/rise-fall-symbols';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken =
    req.headers.get('x-admin-token') ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

let redisClient: Redis | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    redisClient = Redis.fromEnv();
  } catch {
    logger.warn('Unable to initialize Redis client for admin stats');
  }
}

const CACHE_KEY = 'admin_stats_cache_v4';
const CACHE_TTL_SECONDS = 30;

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401 });
  }

  try {
    if (redisClient) {
      try {
        const cached = await redisClient.get(CACHE_KEY);
        if (cached) return NextResponse.json(cached);
      } catch {
        logger.warn('Redis cache read error in admin/stats');
      }
    }

    const isDbConnected = await initDbSchema();
    const sql = getDb();

    if (!sql || !isDbConnected) {
      return NextResponse.json({
        isDbConnected: false,
        dataSource: 'database-unavailable',
        isSimulated: false,
        realTradesOnly: true,
        summary: {
          totalTrades: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          totalProfit: 0,
          totalTicks: 0,
          totalModels: 0,
          activeModel: 'Unavailable (DB Offline)',
          activeAccuracy: null,
        },
        confidenceBrackets: [],
        strategyBreakdown: [],
        pnlCurve: [],
        recentTrades: [],
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // Use the current Operations Center schema. Do not reference the removed
    // legacy trades/ticks/ml_models tables or their old model_id shape.
    const [tradeRows, totalTradesRes, ticksCountRes, modelCountRes, activeModelRes] = await Promise.all([
      sql`
        SELECT
          et.id,
          et.asset_symbol AS symbol,
          et.contract_type,
          et.stake,
          et.payout,
          et.status,
          pe.confidence AS prediction_confidence,
          COALESCE(pe.metadata->>'strategy', 'Unknown') AS strategy,
          et.executed_at
        FROM execution_trades et
        LEFT JOIN ml_performance_events pe
          ON pe.id = et.prediction_event_id
        ORDER BY et.executed_at DESC
        LIMIT 100
      `,
      sql`SELECT COUNT(*) AS cnt FROM execution_trades`,
      sql`SELECT COUNT(*) AS cnt FROM market_ticks`,
      sql`SELECT COUNT(*) AS cnt FROM ml_model_registry_v2`,
      sql`
        SELECT
          model_id,
          COALESCE(
            NULLIF(metrics->>'accuracy', ''),
            NULLIF(metrics->>'val_accuracy', '')
          ) AS accuracy
        FROM ml_model_registry_v2
        WHERE status = 'production'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    ]);

    const totalTrades = Number.parseInt(String(totalTradesRes[0]?.cnt ?? '0'), 10) || 0;
    const totalTicks = Number.parseInt(String(ticksCountRes[0]?.cnt ?? '0'), 10) || 0;
    const totalModels = Number.parseInt(String(modelCountRes[0]?.cnt ?? '0'), 10) || 0;
    const activeModel = activeModelRes.length > 0
      ? String(activeModelRes[0].model_id)
      : 'Unavailable (No Production Model)';
    const parsedAccuracy = activeModelRes.length > 0 ? Number(activeModelRes[0].accuracy) : NaN;
    const activeAccuracy = Number.isFinite(parsedAccuracy) ? parsedAccuracy : null;

    let wins = 0;
    let losses = 0;
    let pnlDataPoints = 0;
    const bracketsMap: Record<string, { wins: number; losses: number; total: number }> = {};
    let cumPnl = 0;
    const pnlCurve: Array<{ tradeIndex: number; pnl: number }> = [];
    const strategyMap: Record<string, { strategy: string; trades: number; wins: number; losses: number }> = {};

    tradeRows.forEach((t: any, idx: number) => {
      const status = String(t.status || '').toUpperCase();
      const stake = Number(t.stake);
      const payout = Number(t.payout);
      const isWin = status === 'WON' || status === 'WIN';
      const isLoss = status === 'LOST' || status === 'LOSS';
      if (isWin) wins++;
      if (isLoss) losses++;

      const strategy = String(t.strategy || 'Unknown').trim() || 'Unknown';
      strategyMap[strategy] ??= { strategy, trades: 0, wins: 0, losses: 0 };
      strategyMap[strategy].trades++;
      if (isWin) strategyMap[strategy].wins++;
      if (isLoss) strategyMap[strategy].losses++;

      if ((isWin || isLoss) && Number.isFinite(stake) && stake >= 0 && Number.isFinite(payout) && payout >= 0) {
        cumPnl += payout - stake;
        pnlDataPoints++;
      }
      pnlCurve.push({ tradeIndex: tradeRows.length - idx, pnl: Number(cumPnl.toFixed(2)) });

      const confidence = Number(t.prediction_confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return;
      const bracket = confidence >= 90
        ? '90-100%'
        : confidence >= 80
          ? '80-89%'
          : confidence >= 70
            ? '70-79%'
            : null;
      if (!bracket) return;
      bracketsMap[bracket] ??= { wins: 0, losses: 0, total: 0 };
      bracketsMap[bracket].total++;
      if (isWin) bracketsMap[bracket].wins++;
      else if (isLoss) bracketsMap[bracket].losses++;
    });

    const resolvedTrades = wins + losses;
    const winRate = resolvedTrades > 0 ? Number(((wins / resolvedTrades) * 100).toFixed(1)) : 0;
    const confidenceBrackets = Object.entries(bracketsMap).map(([bracket, b]) => ({
      bracket,
      wins: b.wins,
      losses: b.losses,
      total: b.total,
      winRate: b.total > 0 ? Number(((b.wins / b.total) * 100).toFixed(1)) : 0,
    }));
    const strategyBreakdown = Object.values(strategyMap)
      .map((s) => ({
        ...s,
        winRate: s.wins + s.losses > 0
          ? Number(((s.wins / (s.wins + s.losses)) * 100).toFixed(1))
          : 0,
      }))
      .sort((a, b) => b.trades - a.trades);

    const responseData = {
      isDbConnected: true,
      dataSource: 'live-database',
      isSimulated: false,
      realTradesOnly: true,
      generatedAt: new Date().toISOString(),
      summary: {
        totalTrades,
        wins,
        losses,
        winRate,
        totalProfit: Number(cumPnl.toFixed(2)),
        totalTicks,
        totalModels,
        activeModel,
        activeAccuracy,
        metricsQuality: {
          recentTradesSampled: tradeRows.length,
          resolvedTrades,
          pnlTradesWithCompleteAmounts: pnlDataPoints,
        },
      },
      confidenceBrackets,
      strategyBreakdown,
      pnlCurve: pnlCurve.reverse(),
      recentTrades: tradeRows.slice(0, 20),
    };

    if (redisClient) {
      try {
        await redisClient.setex(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(responseData));
      } catch {
        logger.warn('Redis cache write error in admin/stats');
      }
    }
    return NextResponse.json(responseData, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    logger.error(`Error fetching admin stats: ${err?.message || err}`);
    return NextResponse.json(
      { success: false, isSimulated: false, error: 'Unable to load live admin metrics.' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { action } = body;
    if (action === 'flush_cache') {
      if (redisClient) {
        try {
          await redisClient.del(CACHE_KEY);
        } catch {
          logger.warn('Failed to flush admin stats cache');
        }
      }
      return NextResponse.json({ success: true, message: 'Stats cache flushed' });
    }

    if (action === 'sync_ticks') {
      const isDbConnected = await initDbSchema();
      if (!isDbConnected) {
        return NextResponse.json({ success: false, error: 'PostgreSQL Database not connected' }, { status: 400 });
      }

      const activeSymbols = await getLiveRiseFallSymbols();
      const symbolsToSync = activeSymbols
        .filter((item: any) => item?.isOpen && typeof item?.symbol === 'string' && item.symbol.trim())
        .map((item: any) => item.symbol.trim());
      if (!symbolsToSync.length) {
        return NextResponse.json({
          success: false,
          error: 'No open Deriv symbols were returned by the live symbol service.',
        }, { status: 503 });
      }

      const { ensureMinTicks } = await import('@/lib/ticks-helper');
      let syncedTotal = 0;
      for (const sym of symbolsToSync) {
        const ticks = await ensureMinTicks(sym, 1000, true);
        syncedTotal += ticks.length;
      }
      if (redisClient) {
        try {
          await redisClient.del(CACHE_KEY);
        } catch {
          // Cache invalidation failure does not invalidate the successful tick sync.
        }
      }
      return NextResponse.json({
        success: true,
        syncedTotal,
        symbolsCount: symbolsToSync.length,
        dataSource: 'deriv-live-ticks',
        message: `Successfully synchronized ${syncedTotal.toLocaleString()} real Deriv ticks across ${symbolsToSync.length} live assets directly into PostgreSQL.`,
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: any) {
    logger.error(`Admin stats action failed: ${err?.message || err}`);
    return NextResponse.json({ error: 'Admin stats action failed.' }, { status: 500 });
  }
}
