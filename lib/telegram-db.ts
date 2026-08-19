import { neon } from '@neondatabase/serverless';
import { getDbConnectionString } from './db';
import crypto from 'crypto';

/**
 * Telegram Bot & User Schema Definition
 * Stores encrypted token pairing sessions, Telegram chat bindings, trade intent idempotency,
 * webhook update idempotency, and trading audit records.
 */
export async function ensureTelegramSchema(sqlInstance?: any) {
  const sql = sqlInstance || (getDbConnectionString() ? neon(getDbConnectionString()!) : null);
  if (!sql) return;

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS telegram_pairing_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pairing_code VARCHAR(64) NOT NULL UNIQUE,
        account_id VARCHAR(64) NOT NULL,
        token_encrypted TEXT NOT NULL,
        account_type VARCHAR(16) NOT NULL DEFAULT 'demo',
        currency VARCHAR(16) NOT NULL DEFAULT 'USD',
        user_email VARCHAR(160),
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS telegram_users (
        chat_id BIGINT PRIMARY KEY,
        telegram_username VARCHAR(128),
        first_name VARCHAR(128),
        account_id VARCHAR(64) NOT NULL,
        token_encrypted TEXT NOT NULL,
        account_type VARCHAR(16) NOT NULL DEFAULT 'demo',
        currency VARCHAR(16) NOT NULL DEFAULT 'USD',
        active_symbol VARCHAR(64) NOT NULL DEFAULT 'R_100',
        active_stake NUMERIC(12, 2) NOT NULL DEFAULT 10.00,
        active_duration_unit VARCHAR(8) NOT NULL DEFAULT 't',
        active_duration_value INTEGER NOT NULL DEFAULT 5,
        autotrade_strategy VARCHAR(32) NOT NULL DEFAULT 'balanced',
        scaling_factor NUMERIC(6, 2) NOT NULL DEFAULT 2.00,
        max_steps INTEGER NOT NULL DEFAULT 4,
        max_trades INTEGER NOT NULL DEFAULT 5,
        is_autotrading BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS telegram_trade_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id BIGINT NOT NULL REFERENCES telegram_users(chat_id) ON DELETE CASCADE,
        contract_id BIGINT,
        symbol VARCHAR(64) NOT NULL,
        contract_type VARCHAR(32) NOT NULL,
        stake NUMERIC(12, 2) NOT NULL,
        payout NUMERIC(12, 2),
        profit NUMERIC(12, 2),
        status VARCHAR(32) NOT NULL,
        step INTEGER NOT NULL DEFAULT 1,
        execution_plan_id UUID,
        model_id VARCHAR(160),
        win_probability NUMERIC(6, 4),
        raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS telegram_update_events (
        update_id BIGINT PRIMARY KEY,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS telegram_trade_intents (
        idempotency_key VARCHAR(256) PRIMARY KEY,
        chat_id BIGINT NOT NULL REFERENCES telegram_users(chat_id) ON DELETE CASCADE,
        status VARCHAR(24) NOT NULL,
        contract_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_tg_pairing_expiry
      ON telegram_pairing_tokens (expires_at) WHERE used = FALSE
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_tg_update_events_received
      ON telegram_update_events (received_at)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_tg_trade_intents_chat_created
      ON telegram_trade_intents (chat_id, created_at)
    `;
  } catch (err) {
    console.error('[Telegram Schema Error]:', err);
    throw err;
  }
}

function getEncryptionKey(): Buffer {
  const raw = process.env.TELEGRAM_AUTH_SECRET?.trim();
  if (!raw) {
    throw new Error('TELEGRAM_AUTH_SECRET is not configured');
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

export function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decryptSecret(cipherPayload: string): string | null {
  try {
    const parts = cipherPayload.split(':');
    if (parts.length !== 3) return null;
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[Token Decryption Failure]:', err instanceof Error ? err.message : 'unknown');
    return null;
  }
}

export async function claimTelegramUpdate(sql: any, updateId: number): Promise<boolean> {
  const rows = await sql`
    INSERT INTO telegram_update_events (update_id)
    VALUES (${updateId})
    ON CONFLICT (update_id) DO NOTHING
    RETURNING update_id
  `;
  return rows.length > 0;
}

export async function claimTelegramTradeIntent(
  sql: any,
  idempotencyKey: string,
  chatId: number
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO telegram_trade_intents (idempotency_key, chat_id, status)
    VALUES (${idempotencyKey}, ${chatId}, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key
  `;
  return rows.length > 0;
}

export async function updateTelegramTradeIntent(
  sql: any,
  idempotencyKey: string,
  status: 'completed' | 'failed',
  contractId?: number
): Promise<void> {
  await sql`
    UPDATE telegram_trade_intents
    SET status = ${status},
        contract_id = ${contractId ?? null},
        updated_at = NOW()
    WHERE idempotency_key = ${idempotencyKey}
  `;
}
