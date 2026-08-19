import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';
import type { FeaturePipelineConfig } from './ml-pipeline-config';

export type StoredMlPipelineConfig = {
  id: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  config: FeaturePipelineConfig;
  configHash: string;
  featureSchemaVersion: string;
  createdBy: string | null;
  createdAt: string;
  activatedAt: string | null;
};

function getSql() {
  const url = process.env.DATABASE_URL?.trim();
  return url ? neon(url) : null;
}

export function hashMlPipelineConfig(config: FeaturePipelineConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

export async function ensureMlPipelineConfigStore(): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS ml_pipeline_config_versions (
        id UUID PRIMARY KEY,
        version BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
        status VARCHAR(16) NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
        config JSONB NOT NULL,
        config_hash VARCHAR(64) NOT NULL UNIQUE,
        feature_schema_version VARCHAR(128) NOT NULL,
        created_by VARCHAR(160),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        activated_at TIMESTAMPTZ
      )
    `;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_pipeline_config_active
      ON ml_pipeline_config_versions ((status))
      WHERE status = 'active'
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_ml_pipeline_config_versions_created
      ON ml_pipeline_config_versions (created_at DESC)
    `;
    return true;
  } catch (error) {
    console.error('[ML Config Store] schema initialization failed:', error);
    return false;
  }
}

function rowToStored(row: any): StoredMlPipelineConfig {
  return {
    id: String(row.id),
    version: Number(row.version),
    status: row.status,
    config: row.config as FeaturePipelineConfig,
    configHash: String(row.config_hash),
    featureSchemaVersion: String(row.feature_schema_version),
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: new Date(row.created_at).toISOString(),
    activatedAt: row.activated_at == null ? null : new Date(row.activated_at).toISOString(),
  };
}

export async function getActiveMlPipelineConfig(): Promise<StoredMlPipelineConfig | null> {
  const sql = getSql();
  if (!sql || !(await ensureMlPipelineConfigStore())) return null;
  try {
    const rows = await sql`
      SELECT id, version, status, config, config_hash, feature_schema_version, created_by, created_at, activated_at
      FROM ml_pipeline_config_versions
      WHERE status = 'active'
      ORDER BY version DESC
      LIMIT 1
    `;
    return rows[0] ? rowToStored(rows[0]) : null;
  } catch (error) {
    console.error('[ML Config Store] active config read failed:', error);
    return null;
  }
}

export async function listMlPipelineConfigs(limit = 20): Promise<StoredMlPipelineConfig[]> {
  const sql = getSql();
  if (!sql || !(await ensureMlPipelineConfigStore())) return [];
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  try {
    const rows = await sql`
      SELECT id, version, status, config, config_hash, feature_schema_version, created_by, created_at, activated_at
      FROM ml_pipeline_config_versions
      ORDER BY version DESC
      LIMIT ${safeLimit}
    `;
    return rows.map(rowToStored);
  } catch (error) {
    console.error('[ML Config Store] config history read failed:', error);
    return [];
  }
}

export async function createMlPipelineConfigVersion(
  config: FeaturePipelineConfig,
  featureSchemaVersion: string,
  createdBy: string,
): Promise<StoredMlPipelineConfig | null> {
  const sql = getSql();
  if (!sql || !(await ensureMlPipelineConfigStore())) return null;

  const id = crypto.randomUUID();
  const hash = hashMlPipelineConfig(config);
  try {
    const rows = await sql`
      INSERT INTO ml_pipeline_config_versions
        (id, status, config, config_hash, feature_schema_version, created_by)
      VALUES
        (${id}, 'draft', ${JSON.stringify(config)}::jsonb, ${hash}, ${featureSchemaVersion}, ${createdBy})
      RETURNING id, version, status, config, config_hash, feature_schema_version, created_by, created_at, activated_at
    `;
    return rows[0] ? rowToStored(rows[0]) : null;
  } catch (error: any) {
    if (String(error?.code) === '23505') {
      const existing = await sql`
        SELECT id, version, status, config, config_hash, feature_schema_version, created_by, created_at, activated_at
        FROM ml_pipeline_config_versions
        WHERE config_hash = ${hash}
        LIMIT 1
      `;
      return existing[0] ? rowToStored(existing[0]) : null;
    }
    console.error('[ML Config Store] config creation failed:', error);
    return null;
  }
}

export async function activateMlPipelineConfigVersion(id: string): Promise<StoredMlPipelineConfig | null> {
  const sql = getSql();
  if (!sql || !(await ensureMlPipelineConfigStore())) return null;
  try {
    const results = await sql.transaction((tx) => [
      tx`SELECT pg_advisory_xact_lock(hashtext('ml_pipeline_config_registry'))`,
      tx`SELECT id FROM ml_pipeline_config_versions WHERE id = ${id} FOR UPDATE`,
      tx`UPDATE ml_pipeline_config_versions SET status = 'archived' WHERE status = 'active'`,
      tx`UPDATE ml_pipeline_config_versions SET status = 'active', activated_at = NOW() WHERE id = ${id}`,
      tx`SELECT id, version, status, config, config_hash, feature_schema_version, created_by, created_at, activated_at
         FROM ml_pipeline_config_versions WHERE id = ${id} LIMIT 1`,
    ]);
    const targetRows = results[1] as any[];
    if (!targetRows[0]) return null;
    const finalRows = results[4] as any[];
    return finalRows[0] ? rowToStored(finalRows[0]) : null;
  } catch (error) {
    console.error('[ML Config Store] config activation failed:', error);
    return null;
  }
}

export async function getMlPipelineConfigVersion(id: string): Promise<StoredMlPipelineConfig | null> {
  const sql = getSql();
  if (!sql || !(await ensureMlPipelineConfigStore())) return null;
  try {
    const rows = await sql`
      SELECT id, version, status, config, config_hash, feature_schema_version, created_by, created_at, activated_at
      FROM ml_pipeline_config_versions
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ? rowToStored(rows[0]) : null;
  } catch (error) {
    console.error('[ML Config Store] config version read failed:', error);
    return null;
  }
}

export async function ensureBootstrapMlPipelineConfig(
  bootstrap: FeaturePipelineConfig,
  featureSchemaVersion: string,
): Promise<StoredMlPipelineConfig | null> {
  const existing = await getActiveMlPipelineConfig();
  if (existing) return existing;

  const sql = getSql();
  if (!sql || !(await ensureMlPipelineConfigStore())) return null;
  const hash = hashMlPipelineConfig(bootstrap);

  try {
    const results = await sql.transaction((tx) => [
      tx`SELECT pg_advisory_xact_lock(hashtext('ml_pipeline_config_registry'))`,
      tx`SELECT id, version, status, config, config_hash, feature_schema_version, created_by, created_at, activated_at
         FROM ml_pipeline_config_versions WHERE status = 'active' ORDER BY version DESC LIMIT 1`,
      tx`INSERT INTO ml_pipeline_config_versions
           (id, status, config, config_hash, feature_schema_version, created_by, activated_at)
         SELECT ${crypto.randomUUID()}, 'active', ${JSON.stringify(bootstrap)}::jsonb, ${hash}, ${featureSchemaVersion}, 'system-bootstrap', NOW()
         WHERE NOT EXISTS (SELECT 1 FROM ml_pipeline_config_versions WHERE status = 'active')
         ON CONFLICT (config_hash) DO NOTHING
         RETURNING id, version, status, config, config_hash, feature_schema_version, created_by, created_at, activated_at`,
    ]);

    const existingRows = results[1] as any[];
    const insertedRows = results[2] as any[];
    const row = existingRows[0] || insertedRows[0];
    return row ? rowToStored(row) : getActiveMlPipelineConfig();
  } catch (error) {
    console.error('[ML Config Store] bootstrap initialization failed:', error);
    return getActiveMlPipelineConfig();
  }
}
