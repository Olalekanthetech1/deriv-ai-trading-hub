import crypto from 'crypto';
import type { NextRequest } from 'next/server';

function constantTimeEqual(expected: string, presented: string | null): boolean {
  if (!presented) return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const presentedBuffer = Buffer.from(presented, 'utf8');
  if (expectedBuffer.length !== presentedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, presentedBuffer);
}

export function getRequiredSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export function getTelegramWebhookSecret(): string {
  const secret = getRequiredSecret('TELEGRAM_WEBHOOK_SECRET');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be 16-256 characters using letters, numbers, underscores, or hyphens');
  }
  return secret;
}

export function requireTelegramWebhookSecret(req: NextRequest): void {
  const expected = getTelegramWebhookSecret();
  const presented = req.headers.get('x-telegram-bot-api-secret-token');
  if (!constantTimeEqual(expected, presented)) {
    throw new Error('TELEGRAM_WEBHOOK_UNAUTHORIZED');
  }
}

export function requireTelegramAdminSecret(req: NextRequest): void {
  const expected = getRequiredSecret('ADMIN_SECRET_KEY');
  const presented =
    req.headers.get('x-telegram-admin-secret') ||
    req.headers.get('x-admin-token') ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    null;

  if (!constantTimeEqual(expected, presented)) {
    throw new Error('TELEGRAM_ADMIN_UNAUTHORIZED');
  }
}

export function getAuthorizedAlertChatId(): number | null {
  const raw = process.env.ALERT_TELEGRAM_CHAT_ID?.trim();
  if (!raw) return null;
  const num = Number(raw);
  return Number.isSafeInteger(num) ? num : null;
}

export function getAuthorizedAdminUserIds(): Set<number> {
  const raw = process.env.ALERT_TELEGRAM_ADMIN_USER_IDS?.trim() || '';
  const set = new Set<number>();
  if (!raw) return set;

  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (trimmed) {
      const num = Number(trimmed);
      if (Number.isSafeInteger(num) && num > 0) {
        set.add(num);
      }
    }
  }
  return set;
}

export interface TelegramAdminAuthorizationResult {
  authorized: boolean;
  reason?: string;
}

/**
 * Enforces dual-layer authorization for Telegram Operational Control Plane actions:
 * Layer 1: Verify the request originates from the authorized alert chat ID (ALERT_TELEGRAM_CHAT_ID)
 * Layer 2: Verify the caller is an explicitly authorized Telegram admin user (ALERT_TELEGRAM_ADMIN_USER_IDS)
 */
export function verifyTelegramAdminAuthorization(params: {
  chatId: number;
  userId: number;
}): TelegramAdminAuthorizationResult {
  const adminUserIds = getAuthorizedAdminUserIds();
  if (adminUserIds.size === 0) {
    return {
      authorized: false,
      reason: 'ALERT_TELEGRAM_ADMIN_USER_IDS_UNCONFIGURED',
    };
  }

  if (!adminUserIds.has(params.userId)) {
    return {
      authorized: false,
      reason: 'UNAUTHORIZED_TELEGRAM_ADMIN_USER',
    };
  }

  const authorizedChatId = getAuthorizedAlertChatId();
  if (authorizedChatId !== null && params.chatId !== authorizedChatId) {
    return {
      authorized: false,
      reason: 'UNAUTHORIZED_TELEGRAM_ALERT_CHAT',
    };
  }

  return { authorized: true };
}

