import { getDb, initDbSchema } from './db';
import { recordObservabilityEvent } from './observability';
import { sendModelDriftAlertEmail } from './alert-email-dispatcher';

export interface CircuitBreakerConfig {
  minSamples: number;
  driftTolerancePct: number; // e.g. 0.15 = 15% drop from validation baseline
  minAccuracyThreshold: number; // e.g. 0.48 = 48% absolute accuracy floor
  autoDemote: boolean;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  minSamples: 15,
  driftTolerancePct: 0.15,
  minAccuracyThreshold: 0.48,
  autoDemote: true,
};

export interface ModelDriftReport {
  modelId: string;
  modelKey: string;
  modelFamily: string;
  symbol: string;
  durationValue: number;
  durationUnit: string;
  status: string;
  validationAccuracy: number | null;
  validationF1: number | null;
  sampleCount: number;
  correctCount: number;
  liveAccuracy: number | null;
  accuracyDrop: number | null;
  isBreached: boolean;
  breachReason: string | null;
  demoted: boolean;
  evaluatedAt: string;
}

export interface CircuitBreakerEvaluationResult {
  evaluatedCount: number;
  breachedCount: number;
  demotedCount: number;
  reports: ModelDriftReport[];
  config: CircuitBreakerConfig;
  evaluatedAt: string;
}

/**
 * Evaluate model drift against persisted validation baselines and trigger
 * automated circuit breaker demotion if live accuracy degrades below tolerance.
 */
export async function evaluateModelDriftAndCircuitBreakers(
  customConfig?: Partial<CircuitBreakerConfig>,
  actor = 'circuit-breaker-engine'
): Promise<CircuitBreakerEvaluationResult> {
  if (!(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  const sql = getDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');

  const config: CircuitBreakerConfig = {
    ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
    ...customConfig,
  };

  // 1. Fetch active production models
  const productionRows = await sql`
    SELECT model_id, model_family, version, asset_symbol, asset_class, horizon_ticks,
           format, metrics, hyperparameters, status, updated_at
    FROM ml_model_registry_v2
    WHERE status = 'production'
    ORDER BY asset_symbol, horizon_ticks ASC
  `;

  const evaluatedAt = new Date().toISOString();
  const reports: ModelDriftReport[] = [];
  let breachedCount = 0;
  let demotedCount = 0;

  for (const row of productionRows as any[]) {
    const modelId = String(row.model_id);
    const symbol = String(row.asset_symbol);
    const horizonTicks = Number(row.horizon_ticks ?? 5);
    const durationValue = Number(row.duration_value ?? horizonTicks);
    const durationUnit = String(row.duration_unit ?? 't');
    const metrics = row.metrics && typeof row.metrics === 'object' ? row.metrics : {};
    const modelKey = String(metrics.modelKey || row.model_family || '').trim().toLowerCase();
    const modelFamily = String(row.model_family || '');

    const validationAccuracy = Number.isFinite(Number(metrics.accuracy)) ? Number(metrics.accuracy) : null;
    const validationF1 = Number.isFinite(Number(metrics.f1 ?? metrics.f1Score)) ? Number(metrics.f1 ?? metrics.f1Score) : null;
    const baselineAccuracy = validationAccuracy ?? 0.60;

    // 2. Fetch live performance events and completed trades for this model
    const [perfEvents, tradeEvents] = await Promise.all([
      sql`
        SELECT predicted_signal, outcome, confidence
        FROM ml_performance_events
        WHERE model_id = ${modelId}
          AND outcome IS NOT NULL
        ORDER BY prediction_time DESC
        LIMIT 100
      `.catch(() => []),
      sql`
        SELECT status
        FROM execution_trades
        WHERE model_id = ${modelId}
          AND status IN ('won', 'lost', 'closed')
        ORDER BY executed_at DESC
        LIMIT 100
      `.catch(() => []),
    ]);

    let correctCount = 0;
    let totalEvaluated = 0;

    for (const pe of perfEvents as any[]) {
      totalEvaluated++;
      const outcome = String(pe.outcome || '').toUpperCase();
      if (outcome === 'WIN' || outcome === 'CORRECT' || outcome === 'PROFIT') {
        correctCount++;
      }
    }

    for (const te of tradeEvents as any[]) {
      totalEvaluated++;
      const st = String(te.status || '').toLowerCase();
      if (st === 'won') {
        correctCount++;
      }
    }

    const liveAccuracy = totalEvaluated > 0 ? Number((correctCount / totalEvaluated).toFixed(4)) : null;
    const accuracyDrop = liveAccuracy !== null ? Number((baselineAccuracy - liveAccuracy).toFixed(4)) : null;

    let isBreached = false;
    let breachReason: string | null = null;

    if (totalEvaluated >= config.minSamples && liveAccuracy !== null) {
      if (liveAccuracy < config.minAccuracyThreshold) {
        isBreached = true;
        breachReason = `Live accuracy (${(liveAccuracy * 100).toFixed(1)}%) dropped below floor threshold (${(config.minAccuracyThreshold * 100).toFixed(1)}%) over ${totalEvaluated} events.`;
      } else if (accuracyDrop !== null && accuracyDrop > config.driftTolerancePct) {
        isBreached = true;
        breachReason = `Drift delta (${(accuracyDrop * 100).toFixed(1)}%) exceeded drift tolerance (${(config.driftTolerancePct * 100).toFixed(1)}%) compared to validation baseline (${(baselineAccuracy * 100).toFixed(1)}%).`;
      }
    }

    let demoted = false;
    if (isBreached) {
      breachedCount++;
      if (config.autoDemote) {
        // Demote model from production to staging with audit trail
        await sql`
          UPDATE ml_model_registry_v2
          SET status = 'staging', updated_at = ${evaluatedAt}
          WHERE model_id = ${modelId}
            AND status = 'production'
        `;

        await sql`
          INSERT INTO ops_audit_events (
            category, severity, actor, action, resource_type, resource_id, metadata
          ) VALUES (
            'ml', 'warning', ${actor}, 'circuit_breaker_drift_demotion', 'ml_model_registry_v2', ${modelId},
            ${JSON.stringify({
              previousStatus: 'production',
              nextStatus: 'staging',
              symbol,
              durationValue,
              durationUnit,
              modelKey,
              validationAccuracy,
              liveAccuracy,
              sampleCount: totalEvaluated,
              accuracyDrop,
              breachReason,
              evaluatedAt,
            })}::jsonb
          )
        `;

        await recordObservabilityEvent({
          category: 'trading',
          severity: 'warn',
          service: 'ml-circuit-breaker',
          eventType: 'circuit_breaker_demoted_model',
          message: `Circuit breaker auto-demoted production model ${modelId} (${symbol} ${durationValue}${durationUnit}) due to drift: ${breachReason}`,
          metadata: {
            modelId,
            symbol,
            durationValue,
            durationUnit,
            liveAccuracy,
            validationAccuracy,
            sampleCount: totalEvaluated,
            breachReason,
          },
        });

        // Dispatch automated email alert
        await sendModelDriftAlertEmail({
          modelId,
          modelKey,
          symbol,
          durationValue,
          durationUnit,
          liveAccuracy,
          validationAccuracy,
          accuracyDrop,
          sampleCount: totalEvaluated,
          breachReason,
          evaluatedAt,
        }).catch((err) => {
          console.warn(`[ML Circuit Breaker] Alert email dispatch failed for ${modelId}:`, err);
        });

        demoted = true;
        demotedCount++;
      }
    }

    reports.push({
      modelId,
      modelKey,
      modelFamily,
      symbol,
      durationValue,
      durationUnit,
      status: demoted ? 'staging' : String(row.status),
      validationAccuracy,
      validationF1,
      sampleCount: totalEvaluated,
      correctCount,
      liveAccuracy,
      accuracyDrop,
      isBreached,
      breachReason,
      demoted,
      evaluatedAt,
    });
  }

  return {
    evaluatedCount: productionRows.length,
    breachedCount,
    demotedCount,
    reports,
    config,
    evaluatedAt,
  };
}

/**
 * Retrieve recent circuit breaker status, recent demotion logs, and drift health overview.
 */
export async function getCircuitBreakerOverview() {
  if (!(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  const sql = getDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');

  const [recentDemotions, totalProductionRows] = await Promise.all([
    sql`
      SELECT id, actor, action, resource_id as model_id, metadata, created_at
      FROM ops_audit_events
      WHERE action = 'circuit_breaker_drift_demotion'
      ORDER BY created_at DESC
      LIMIT 20
    `,
    sql`
      SELECT COUNT(*)::integer as count
      FROM ml_model_registry_v2
      WHERE status = 'production'
    `,
  ]);

  return {
    activeProductionCount: Number(totalProductionRows[0]?.count || 0),
    recentDemotions: (recentDemotions as any[]).map((r) => ({
      id: r.id,
      actor: r.actor,
      modelId: r.model_id,
      metadata: r.metadata,
      createdAt: r.created_at,
    })),
    config: DEFAULT_CIRCUIT_BREAKER_CONFIG,
  };
}
