import { getDb } from '@/lib/db';

export type RetireModelResult = {
  modelId: string;
  symbol: string;
  horizonTicks: number;
  previousStatus: string;
  status: 'retired';
  retiredAt: string;
};

/**
 * Retire an existing production model without deleting registry lineage.
 *
 * Retirement is intentionally limited to production records. Candidate/staging
 * cleanup remains owned by the candidate cleanup workflow.
 */
export async function retireProductionModel(modelId: string, actor = 'admin') : Promise<RetireModelResult> {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) throw new Error('MODEL_ID_REQUIRED');

  const sql = getDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');

  const rows = await sql`
    SELECT model_id, asset_symbol, horizon_ticks, status
    FROM ml_model_registry_v2
    WHERE model_id = ${normalizedModelId}
    LIMIT 1
  `;
  const model = rows[0] as any;
  if (!model) throw new Error('MODEL_NOT_FOUND');

  const currentStatus = String(model.status || '').toLowerCase();
  if (currentStatus !== 'production') {
    throw new Error(`MODEL_NOT_PRODUCTION:${currentStatus || 'unknown'}`);
  }

  const retiredAt = new Date().toISOString();
  const updated = await sql`
    UPDATE ml_model_registry_v2
    SET status = 'retired', updated_at = ${retiredAt}
    WHERE model_id = ${normalizedModelId}
      AND status = 'production'
    RETURNING model_id, asset_symbol, horizon_ticks, status, updated_at
  `;

  if (!updated.length) throw new Error('MODEL_RETIREMENT_CONFLICT');

  await sql`
    INSERT INTO ops_audit_events (
      category, severity, actor, action, resource_type, resource_id, metadata
    ) VALUES (
      'ml', 'info', ${actor}, 'retire_production_model', 'ml_model_registry_v2', ${normalizedModelId},
      ${JSON.stringify({
        previousStatus: 'production',
        nextStatus: 'retired',
        assetSymbol: String(model.asset_symbol),
        horizonTicks: Number(model.horizon_ticks),
        reason: 'controlled-production-retirement',
      })}::jsonb
    )
  `;

  return {
    modelId: String(updated[0].model_id),
    symbol: String(updated[0].asset_symbol),
    horizonTicks: Number(updated[0].horizon_ticks),
    previousStatus: 'production',
    status: 'retired',
    retiredAt: new Date(updated[0].updated_at || retiredAt).toISOString(),
  };
}
