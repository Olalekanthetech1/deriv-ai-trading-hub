import { neon } from '@neondatabase/serverless';
import { getDbConnectionString } from '@/lib/db';

let initialized = false;

/**
 * Ensures the execution-trade lineage column exists without altering or
 * rewriting existing trade records. The project uses idempotent runtime
 * schema initialization, so this migration follows the same safe pattern.
 */
export async function ensureExecutionPlanTelemetrySchema(): Promise<boolean> {
  if (initialized) return true;

  const dbUrl = getDbConnectionString();
  if (!dbUrl) return false;

  try {
    const sql = neon(dbUrl);

    await sql`
      ALTER TABLE execution_trades
      ADD COLUMN IF NOT EXISTS execution_plan_id UUID
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_execution_trades_execution_plan_id
      ON execution_trades (execution_plan_id)
    `;

    initialized = true;
    return true;
  } catch (error) {
    console.error('[Execution Plan Telemetry Schema Error]:', error);
    return false;
  }
}

export function normalizeExecutionPlanId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidPattern.test(normalized) ? normalized : null;
}
