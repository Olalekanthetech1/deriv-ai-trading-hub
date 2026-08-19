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
