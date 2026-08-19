import { neon } from '@neondatabase/serverless';
import { getDbConnectionString } from './db';

/** Idempotent persistence boundary for admin training plans. */
export async function ensureTrainingBatchSchema(sql: any): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS ml_training_batches (
      batch_id UUID PRIMARY KEY,
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      requested_datasets INTEGER NOT NULL DEFAULT 0,
      requested_models INTEGER NOT NULL DEFAULT 0,
      total_jobs INTEGER NOT NULL DEFAULT 0,
      completed_jobs INTEGER NOT NULL DEFAULT 0,
      failed_jobs INTEGER NOT NULL DEFAULT 0,
      skipped_jobs INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      heartbeat_at TIMESTAMPTZ,
      worker_id VARCHAR(128),
      error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS ml_training_batch_items (
      id BIGSERIAL PRIMARY KEY,
      batch_id UUID NOT NULL REFERENCES ml_training_batches(batch_id) ON DELETE CASCADE,
      dataset_id TEXT NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      requested_models JSONB NOT NULL DEFAULT '[]'::jsonb,
      skipped_models JSONB NOT NULL DEFAULT '[]'::jsonb,
      run_id UUID,
      completed_models INTEGER NOT NULL DEFAULT 0,
      failed_models INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      heartbeat_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(batch_id, dataset_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_training_batches_status_created ON ml_training_batches (status, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_training_batches_heartbeat ON ml_training_batches (status, heartbeat_at) WHERE status='running'`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_training_batch_items_batch ON ml_training_batch_items (batch_id, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ml_training_batch_items_status ON ml_training_batch_items (status, heartbeat_at)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ml_training_batches_one_active ON ml_training_batches ((1)) WHERE status IN ('queued','running')`;
}

export async function getTrainingBatchDb() {
  const url = getDbConnectionString();
  if (!url) return null;
  return neon(url);
}
