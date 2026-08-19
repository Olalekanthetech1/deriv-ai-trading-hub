import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const EXECUTE = process.argv.includes('--execute');

if (!DATABASE_URL) {
  console.error('[Unified Horizon Backfill] DATABASE_URL is required.');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeUnit(unit) {
  const value = String(unit || '').trim().toLowerCase();
  if (value === 'sec') return 's';
  if (value === 'min') return 'm';
  if (value === 'hr' || value === 'hour') return 'h';
  if (value === 'day') return 'd';
  if (['t', 's', 'm', 'h', 'd'].includes(value)) return value;
  return null;
}

function horizonKey(value, unit) {
  const normalizedUnit = normalizeUnit(unit);
  const number = Number(value);
  if (!normalizedUnit || !Number.isInteger(number) || number <= 0) return null;
  return `${number}${normalizedUnit}`;
}

function hasAuthoritativeMetrics(metrics) {
  const map = metrics?.horizonMetrics;
  return map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length > 0;
}

function metricIsComplete(metric) {
  if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return false;
  const required = ['accuracy', 'f1', 'logLoss', 'winRate', 'auc', 'brierScore', 'samples'];
  return required.every((key) => Number.isFinite(Number(metric[key])) && Number(metric[key]) >= 0);
}

async function tableExists(name) {
  const rows = await sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
    ) AS exists
  `;
  return Boolean(rows[0]?.exists);
}

async function main() {
  if (!(await tableExists('ml_model_registry_v2'))) {
    throw new Error('ml_model_registry_v2 does not exist.');
  }
  if (!(await tableExists('ml_unified_horizon_training_runs'))) {
    throw new Error('ml_unified_horizon_training_runs does not exist.');
  }

  const rows = await sql`
    SELECT
      r.model_id,
      r.asset_symbol,
      r.duration_value,
      r.duration_unit,
      r.status,
      r.strategy_key,
      r.training_run_id,
      r.metrics,
      t.status AS training_status,
      t.horizon_metrics
    FROM ml_model_registry_v2 r
    LEFT JOIN ml_unified_horizon_training_runs t
      ON t.run_id = r.training_run_id
    WHERE r.strategy_key = 'unified_multi_horizon'
       OR (r.metrics->>'trainedOnceForMultiHorizon')::boolean = true
    ORDER BY r.updated_at ASC, r.model_id ASC
  `;

  const plan = [];
  const failures = [];

  for (const row of rows) {
    const currentMetrics = parseObject(row.metrics);
    if (hasAuthoritativeMetrics(currentMetrics)) {
      continue;
    }

    const runMetrics = parseObject(row.horizon_metrics);
    if (!Object.keys(runMetrics).length) {
      failures.push({ modelId: String(row.model_id), code: 'TRAINING_RUN_HORIZON_METRICS_UNAVAILABLE' });
      continue;
    }

    const key = horizonKey(row.duration_value, row.duration_unit);
    if (!key) {
      failures.push({ modelId: String(row.model_id), code: 'MODEL_HORIZON_METADATA_INVALID' });
      continue;
    }

    const authoritativeMetric = runMetrics[key];
    if (!metricIsComplete(authoritativeMetric)) {
      failures.push({ modelId: String(row.model_id), horizonKey: key, code: 'AUTHORITATIVE_HORIZON_METRIC_INCOMPLETE' });
      continue;
    }

    plan.push({
      modelId: String(row.model_id),
      horizonKey: key,
      trainingRunId: row.training_run_id ? String(row.training_run_id) : null,
      status: String(row.status),
      currentMetrics,
      horizonMetrics: runMetrics,
    });
  }

  console.log(JSON.stringify({
    mode: EXECUTE ? 'execute' : 'dry-run',
    inspected: rows.length,
    eligibleForBackfill: plan.length,
    blocked: failures.length,
    failures,
    models: plan.map((item) => ({
      modelId: item.modelId,
      horizonKey: item.horizonKey,
      trainingRunId: item.trainingRunId,
      status: item.status,
    })),
  }, null, 2));

  if (!EXECUTE) return;

  await sql`BEGIN`;
  try {
    let updated = 0;

    for (const item of plan) {
      const nextMetrics = {
        ...item.currentMetrics,
        horizonMetrics: item.horizonMetrics,
        authoritativeMetricsSource: 'ml_unified_horizon_training_runs',
        authoritativeMetricsTrainingRunId: item.trainingRunId,
        authoritativeMetricsBackfilledAt: new Date().toISOString(),
      };

      await sql`
        UPDATE ml_model_registry_v2
        SET metrics = ${JSON.stringify(nextMetrics)}::jsonb,
            updated_at = NOW()
        WHERE model_id = ${item.modelId}
          AND (
            strategy_key = 'unified_multi_horizon'
            OR (metrics->>'trainedOnceForMultiHorizon')::boolean = true
          )
          AND NOT (
            metrics ? 'horizonMetrics'
            AND jsonb_typeof(metrics->'horizonMetrics') = 'object'
            AND jsonb_object_length(metrics->'horizonMetrics') > 0
          )
      `;
      updated += 1;
    }

    const verify = await sql`
      SELECT COUNT(*)::int AS count
      FROM ml_model_registry_v2
      WHERE strategy_key = 'unified_multi_horizon'
        AND metrics ? 'horizonMetrics'
        AND jsonb_typeof(metrics->'horizonMetrics') = 'object'
        AND jsonb_object_length(metrics->'horizonMetrics') > 0
    `;

    const verifiedCount = Number(verify[0]?.count || 0);

    if (await tableExists('ops_audit_events')) {
      await sql`
        INSERT INTO ops_audit_events (
          category, severity, actor, action, resource_type, resource_id, metadata
        ) VALUES (
          'model-registry',
          'info',
          'unified-horizon-backfill',
          'backfill-authoritative-horizon-metrics',
          'ml_model_registry_v2',
          'unified_multi_horizon',
          ${JSON.stringify({ updated, verifiedCount, blocked: failures.length })}::jsonb
        )
      `;
    }

    await sql`COMMIT`;
    console.log(JSON.stringify({ complete: true, updated, verifiedCount, blocked: failures.length }, null, 2));
  } catch (error) {
    await sql`ROLLBACK`;
    throw error;
  }
}

main().catch((error) => {
  console.error('[Unified Horizon Backfill] FAILED:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
