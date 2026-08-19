import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getDb, initDbSchema } from '@/lib/db';
import { ensureExecutionPlanTelemetrySchema, normalizeExecutionPlanId } from '@/lib/execution-plan-telemetry';

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    const { 
      symbol, 
      contract_type, 
      stake, 
      payout, 
      buy_price, 
      sell_price, 
      status, 
      prediction_confidence, 
      strategy,
      model_id,
      prediction_event_id,
      target_horizon,
      executed_duration,
      proposal_latency_ms,
      calibrated_win_prob,
      model_keys,
      dataset_scope_version,
      execution_plan_id,
    } = data;

    const isDbConnected = await initDbSchema();
    const sql = getDb();

    if (!sql || !isDbConnected) {
      return NextResponse.json({ success: false, error: 'Database not configured or connected' }, { status: 503 });
    }

    const executionPlanSchemaReady = await ensureExecutionPlanTelemetrySchema();
    if (!executionPlanSchemaReady) {
      return NextResponse.json({ success: false, error: 'Trade telemetry schema is not ready' }, { status: 503 });
    }

    const normalizedExecutionPlanId = normalizeExecutionPlanId(execution_plan_id);
    if (execution_plan_id != null && String(execution_plan_id).trim() && !normalizedExecutionPlanId) {
      return NextResponse.json({ success: false, error: 'Invalid execution plan identifier' }, { status: 400 });
    }

    const tradeId = randomUUID();
    const normalizedStatus = String(status || 'EXECUTED').toUpperCase();
    const isSettled = ['WON', 'LOST', 'WIN', 'LOSS', 'SETTLED'].includes(normalizedStatus);
    const numericStake = Number(stake);
    const safeStake = Number.isFinite(numericStake) && numericStake > 0 ? numericStake : 10;
    const numericPayout = payout !== undefined && payout !== null ? Number(payout) : null;
    const numericBuy = buy_price !== undefined && buy_price !== null ? Number(buy_price) : null;
    const numericSell = sell_price !== undefined && sell_price !== null ? Number(sell_price) : null;
    const safeSymbol = String(symbol || 'UNKNOWN').trim();
    const safeContract = String(contract_type || 'CALL').trim().toUpperCase();

    let validatedModelId: string | null = null;
    let unverifiedSignalId: string | null = null;
    if (model_id && typeof model_id === 'string' && model_id.trim()) {
      const candidateId = model_id.trim();
      const existing = await sql`
        SELECT model_id FROM ml_model_registry_v2 WHERE model_id = ${candidateId} LIMIT 1
      `;
      if (existing.length > 0) {
        validatedModelId = candidateId;
      } else {
        unverifiedSignalId = candidateId;
      }
    }

    const safeTargetHorizon = target_horizon ? String(target_horizon).trim() : null;
    const safeExecutedDuration = executed_duration ? String(executed_duration).trim() : null;
    const safeLatencyMs = proposal_latency_ms != null && Number.isFinite(Number(proposal_latency_ms)) ? Math.max(0, Math.round(Number(proposal_latency_ms))) : null;
    const safeCalibratedWinProb = calibrated_win_prob != null && Number.isFinite(Number(calibrated_win_prob)) ? Number(calibrated_win_prob) : null;

    await sql`
      INSERT INTO execution_trades (
        id, asset_symbol, contract_type, stake, payout, buy_price, sell_price, status,
        model_id, prediction_event_id, execution_plan_id, executed_at, settled_at, metadata
      ) VALUES (
        ${tradeId}::uuid,
        ${safeSymbol}::varchar,
        ${safeContract}::varchar,
        ${safeStake}::numeric,
        ${numericPayout}::numeric,
        ${numericBuy}::numeric,
        ${numericSell}::numeric,
        ${normalizedStatus}::varchar,
        ${validatedModelId}::varchar,
        ${prediction_event_id ? Number(prediction_event_id) : null}::bigint,
        ${normalizedExecutionPlanId}::uuid,
        NOW(),
        ${isSettled ? sql`NOW()` : null},
        ${JSON.stringify({
          prediction_confidence: prediction_confidence != null ? Number(prediction_confidence) : null,
          strategy: strategy || 'Manual / Client Execution',
          signalId: unverifiedSignalId,
          target_horizon: safeTargetHorizon,
          executed_duration: safeExecutedDuration,
          horizon_match: safeTargetHorizon && safeExecutedDuration ? safeTargetHorizon === safeExecutedDuration : true,
          proposal_latency_ms: safeLatencyMs,
          calibrated_win_prob: safeCalibratedWinProb,
          model_keys: Array.isArray(model_keys) ? model_keys : [],
          dataset_scope_version: dataset_scope_version || null,
          execution_plan_id: normalizedExecutionPlanId,
          loggedAt: new Date().toISOString(),
        })}::jsonb
      )
    `;

    return NextResponse.json({ success: true, tradeId, executionPlanId: normalizedExecutionPlanId });
  } catch (err: any) {
    console.error('Error logging trade:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

