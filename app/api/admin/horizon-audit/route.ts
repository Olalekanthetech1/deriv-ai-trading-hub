import { NextRequest, NextResponse } from 'next/server';
import { initDbSchema, getDb } from '@/lib/db';
import { verifySessionToken } from '@/app/api/admin/auth/route';
import { getAttributionDiagnostics } from '@/lib/horizon-attribution';

export const dynamic = 'force-dynamic';

function isAdmin(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401 });
  }

  const headers = { 'Cache-Control': 'no-store' };

  try {
    const isConnected = await initDbSchema();
    const sql = getDb();

    if (!sql || !isConnected) {
      return NextResponse.json({
        success: false,
        error: 'Database unavailable.',
      }, { status: 503, headers });
    }

    // Fetch recent 100 execution trades
    const tradeRows = await sql`
      SELECT 
        id, asset_symbol, contract_type, stake, payout, buy_price, sell_price, status,
        model_id, executed_at, settled_at, metadata
      FROM execution_trades
      ORDER BY executed_at DESC
      LIMIT 100
    `;

    const recentExecutions = tradeRows.map((row) => {
      const meta = typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {};
      const targetHorizon = meta.target_horizon || null;
      const executedDuration = meta.executed_duration || null;
      const horizonMatch = meta.horizon_match !== undefined ? Boolean(meta.horizon_match) : (targetHorizon === executedDuration);
      
      let latencyMs = null;
      if (meta.proposal_latency_ms != null) {
        latencyMs = Number(meta.proposal_latency_ms);
      }
      
      let calibratedWinProb = null;
      if (meta.calibrated_win_prob != null) {
        calibratedWinProb = Number(meta.calibrated_win_prob);
      }

      const statusStr = String(row.status || 'EXECUTED').toUpperCase();

      return {
        id: String(row.id),
        assetSymbol: String(row.asset_symbol || 'UNKNOWN'),
        contractType: String(row.contract_type || 'UNKNOWN'),
        stake: Number(row.stake || 0),
        payout: row.payout ? Number(row.payout) : null,
        status: statusStr,
        executedAt: row.executed_at ? new Date(row.executed_at).toISOString() : null,
        targetHorizon,
        executedDuration,
        horizonMatch,
        proposalLatencyMs: latencyMs,
        calibratedWinProb,
        modelKeys: Array.isArray(meta.model_keys) ? meta.model_keys : [],
        strategy: meta.strategy || null,
      };
    });

    // Group into Cohorts
    const cohorts = ['1t', '5t', '15s', '1m', '2m'];
    const cohortMap: Record<string, { total: number; wins: number; matches: number; totalLatencyMs: number; latencyCount: number }> = {};
    for (const c of cohorts) {
      cohortMap[c] = { total: 0, wins: 0, matches: 0, totalLatencyMs: 0, latencyCount: 0 };
    }

    for (const item of recentExecutions) {
      const cohortKey = item.targetHorizon && cohorts.includes(item.targetHorizon) ? item.targetHorizon : 'unknown';
      if (!cohortMap[cohortKey]) {
        cohortMap[cohortKey] = { total: 0, wins: 0, matches: 0, totalLatencyMs: 0, latencyCount: 0 };
      }
      const entry = cohortMap[cohortKey];
      entry.total += 1;
      if (['WON', 'WIN'].includes(item.status)) entry.wins += 1;
      if (item.horizonMatch) entry.matches += 1;
      if (item.proposalLatencyMs != null) {
        entry.totalLatencyMs += item.proposalLatencyMs;
        entry.latencyCount += 1;
      }
    }

    const cohortStats = Object.entries(cohortMap).map(([cohort, data]) => {
      const winRate = data.total > 0 ? Number(((data.wins / data.total) * 100).toFixed(1)) : 0.0;
      const avgLatencyMs = data.latencyCount > 0 ? Math.round(data.totalLatencyMs / data.latencyCount) : null;
      const matchRate = data.total > 0 ? Number(((data.matches / data.total) * 100).toFixed(1)) : 0.0;
      return {
        cohort,
        totalTrades: data.total,
        wins: data.wins,
        winRate,
        avgLatencyMs,
        matchRate,
      };
    });

    const totalExecutions = recentExecutions.length;
    
    let avgLatency = null;
    let exactMatchRate = null;
    let overallWinRate = null;

    if (totalExecutions > 0) {
      const latencyValues = recentExecutions.map(x => x.proposalLatencyMs).filter((val): val is number => val != null);
      if (latencyValues.length > 0) {
        avgLatency = Math.round(latencyValues.reduce((acc, curr) => acc + curr, 0) / latencyValues.length);
      }
      
      const matchedCount = recentExecutions.filter((x) => x.horizonMatch).length;
      exactMatchRate = Number(((matchedCount / totalExecutions) * 100).toFixed(1));
      
      const winsCount = recentExecutions.filter((x) => ['WON', 'WIN'].includes(x.status)).length;
      overallWinRate = Number(((winsCount / totalExecutions) * 100).toFixed(1));
    }

    const attributionDiagnostics = getAttributionDiagnostics('all');

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      overallTelemetry: {
        totalExecutions,
        avgProposalLatencyMs: avgLatency,
        exactHorizonMatchRate: exactMatchRate,
        overallWinRate,
      },
      cohortStats,
      recentExecutions,
      attributionDiagnostics,
    }, { headers });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate horizon audit.',
    }, { status: 500, headers });
  }
}
