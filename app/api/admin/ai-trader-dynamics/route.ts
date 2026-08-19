import { NextRequest, NextResponse } from 'next/server';
import { getDb, initDbSchema } from '@/lib/db';
import { verifySessionToken } from '../auth/route';

function isAuthValid(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function GET(req: NextRequest) {
  if (!isAuthValid(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized admin access.' }, { status: 401 });
  }

  try {
    const isDbConnected = await initDbSchema();
    const sql = getDb();
    if (!sql || !isDbConnected) {
      return NextResponse.json({ success: false, error: 'Database unavailable' }, { status: 503 });
    }

    // 1. Fetch recent AI trades
    const recentTrades = await sql`
      SELECT 
        id, asset_symbol, contract_type, stake, payout, status, model_id, executed_at, settled_at,
        metadata->>'strategy' as strategy,
        metadata->>'prediction_confidence' as confidence
      FROM execution_trades
      WHERE metadata->>'strategy' LIKE 'Auto%' OR metadata->>'strategy' = 'AI Signal Execution'
      ORDER BY executed_at DESC
      LIMIT 100
    `;

    // 2. Aggregate win/loss stats
    const statsResult = await sql`
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN status IN ('WON', 'WIN') THEN 1 ELSE 0 END) as total_wins,
        SUM(CASE WHEN status IN ('LOST', 'LOSS') THEN 1 ELSE 0 END) as total_losses,
        SUM(CASE WHEN status IN ('WON', 'WIN') THEN payout - stake WHEN status IN ('LOST', 'LOSS') THEN -stake ELSE 0 END) as net_profit
      FROM execution_trades
      WHERE metadata->>'strategy' LIKE 'Auto%' OR metadata->>'strategy' = 'AI Signal Execution'
    `;

    // 3. Current Sequence / Drawdown proxy
    // We can deduce current sequence by looking at the most recent settled trades
    const recentSettled = recentTrades.filter((t: any) => t.status === 'WON' || t.status === 'WIN' || t.status === 'LOST' || t.status === 'LOSS');
    let consecutiveLosses = 0;
    for (const t of recentSettled) {
      if (t.status === 'LOST' || t.status === 'LOSS') consecutiveLosses++;
      else break;
    }

    const currentDrawdown = {
      consecutiveLosses,
      activeSequence: consecutiveLosses > 0 ? `Level ${consecutiveLosses} Recovery` : 'Base Stake',
      status: consecutiveLosses >= 3 ? 'ELEVATED_RISK' : 'NORMAL'
    };

    const stats = statsResult[0] || { total_trades: 0, total_wins: 0, total_losses: 0, net_profit: 0 };

    return NextResponse.json({
      success: true,
      data: {
        recentTrades,
        stats: {
          totalTrades: Number(stats.total_trades || 0),
          wins: Number(stats.total_wins || 0),
          losses: Number(stats.total_losses || 0),
          netProfit: Number(stats.net_profit || 0)
        },
        drawdown: currentDrawdown
      },
      timestamp: new Date().toISOString()
    });

  } catch (err: any) {
    console.error('[Admin AI Trader Dynamics Error]:', err);
    return NextResponse.json({ success: false, error: err?.message || 'Failed to retrieve AI Trader Dynamics' }, { status: 500 });
  }
}
