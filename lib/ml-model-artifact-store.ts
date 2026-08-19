import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDb, initDbSchema } from './db';

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
type ArtifactStatus = 'active' | 'superseded' | 'retired' | 'corrupted';
const ARTIFACT_TYPE = 'native_model';

function safeModelId(value: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9_.:-]+$/.test(normalized)) throw new Error('INVALID_MODEL_ID');
  return normalized;
}

export async function ensureModelArtifactStore(): Promise<void> {
  if (!(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  const sql = getDb();
  if (!sql) throw new Error('DATABASE_UNAVAILABLE');
  await sql`ALTER TABLE ml_model_artifacts ADD COLUMN IF NOT EXISTS artifact_bytes BYTEA`;
  await sql`ALTER TABLE ml_model_artifacts ADD COLUMN IF NOT EXISTS artifact_status TEXT NOT NULL DEFAULT 'active'`;
  await sql`ALTER TABLE ml_model_artifacts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_model_artifacts_model_type ON ml_model_artifacts (model_id, artifact_type)`;
}

export async function getModelArtifactStatus(modelId: string): Promise<ArtifactStatus | null> {
  const safeId = safeModelId(modelId);
  await ensureModelArtifactStore();
  const sql = getDb()!;
  let rows = await sql`SELECT artifact_status FROM ml_model_artifacts WHERE model_id=${safeId}::text AND artifact_type=${ARTIFACT_TYPE}::varchar LIMIT 1`;
  if (!rows.length && safeId.includes('_')) {
    const baseId = safeId.replace(/_[0-9]+(s|sec|t|tick|m|min|h|hr|d)?$/i, '');
    if (baseId && baseId !== safeId) {
      rows = await sql`SELECT artifact_status FROM ml_model_artifacts WHERE model_id=${baseId}::text AND artifact_type=${ARTIFACT_TYPE}::varchar LIMIT 1`;
    }
  }
  return rows.length ? (String(rows[0].artifact_status || 'active') as ArtifactStatus) : null;
}

export async function hasModelArtifact(modelId: string): Promise<boolean> {
  const status = await getModelArtifactStatus(modelId);
  return status === 'active' || status === 'superseded';
}

export async function persistModelArtifact(modelId: string, artifactPath: string): Promise<{ sha256: string; byteSize: number }> {
  const safeId = safeModelId(modelId);
  const bytes = await fs.readFile(artifactPath);
  if (!bytes.length) throw new Error('EMPTY_MODEL_ARTIFACT');
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error(`MODEL_ARTIFACT_TOO_LARGE:${bytes.length}`);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await ensureModelArtifactStore();
  await getDb()!`
    INSERT INTO ml_model_artifacts (model_id, artifact_type, uri, checksum, size_bytes, artifact_bytes, artifact_status, created_at, updated_at)
    VALUES (${safeId}::text, ${ARTIFACT_TYPE}::varchar, ${`db://ml_model_artifacts/${safeId}`}::text, ${sha256}::varchar, ${bytes.length}::bigint, ${bytes}::bytea, 'active'::text, NOW(), NOW())
    ON CONFLICT (model_id, artifact_type) DO UPDATE SET
      uri = EXCLUDED.uri,
      checksum = EXCLUDED.checksum,
      size_bytes = EXCLUDED.size_bytes,
      artifact_bytes = EXCLUDED.artifact_bytes,
      artifact_status = 'active',
      updated_at = NOW()
  `;
  return { sha256, byteSize: bytes.length };
}

export async function setModelArtifactStatus(modelId: string, status: ArtifactStatus): Promise<void> {
  const safeId = safeModelId(modelId);
  await ensureModelArtifactStore();
  const result = await getDb()!`UPDATE ml_model_artifacts SET artifact_status=${status}::text,updated_at=NOW() WHERE model_id=${safeId}::text AND artifact_type=${ARTIFACT_TYPE}::varchar RETURNING model_id`;
  if (!result.length && status !== 'retired') throw new Error('PRODUCTION_MODEL_ARTIFACT_MISSING');
}

const MODEL_CACHE_DIR = path.join(os.tmpdir(), 'uniace_model_cache');

export async function materializeModelArtifact(modelId: string): Promise<{ path: string; sha256: string; byteSize: number }> {
  const safeId = safeModelId(modelId);
  await ensureModelArtifactStore();
  const sql = getDb()!;
  let rows = await sql`SELECT artifact_bytes,checksum,size_bytes,artifact_status FROM ml_model_artifacts WHERE model_id=${safeId}::text AND artifact_type=${ARTIFACT_TYPE}::varchar LIMIT 1`;
  if (!rows.length && safeId.includes('_')) {
    const baseId = safeId.replace(/_[0-9]+(s|sec|t|tick|m|min|h|hr|d)?$/i, '');
    if (baseId && baseId !== safeId) {
      rows = await sql`SELECT artifact_bytes,checksum,size_bytes,artifact_status FROM ml_model_artifacts WHERE model_id=${baseId}::text AND artifact_type=${ARTIFACT_TYPE}::varchar LIMIT 1`;
    }
  }
  const row = rows[0] as { artifact_bytes?: Buffer | Uint8Array; checksum?: string; size_bytes?: number; artifact_status?: string } | undefined;
  if (!row?.artifact_bytes || !['active', 'superseded'].includes(String(row.artifact_status || ''))) throw new Error('PRODUCTION_MODEL_ARTIFACT_MISSING');
  
  const expectedSha = String(row.checksum || '');
  const expectedBytes = Number(row.size_bytes || 0);

  await fs.mkdir(MODEL_CACHE_DIR, { recursive: true });
  const cachedFilePath = path.join(MODEL_CACHE_DIR, `${safeId}_${expectedSha.slice(0, 16)}.pkl`);

  try {
    const stat = await fs.stat(cachedFilePath);
    if (stat.isFile() && stat.size > 0 && (expectedBytes <= 0 || stat.size === expectedBytes)) {
      return { path: cachedFilePath, sha256: expectedSha, byteSize: stat.size };
    }
  } catch {
    // Cache miss, proceed to write
  }

  const bytes = Buffer.from(row.artifact_bytes);
  const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (expectedSha && actualSha !== expectedSha) {
    await setModelArtifactStatus(safeId, 'corrupted').catch(() => undefined);
    throw new Error('PRODUCTION_MODEL_ARTIFACT_CHECKSUM_MISMATCH');
  }

  await fs.writeFile(cachedFilePath, bytes, { mode: 0o600 });
  return { path: cachedFilePath, sha256: actualSha, byteSize: Number(row.size_bytes || bytes.length) };
}

export async function purgeModelArtifact(modelId: string): Promise<void> {
  await setModelArtifactStatus(modelId, 'retired');
}
