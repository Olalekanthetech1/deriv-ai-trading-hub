import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`Telegram invariant failed: ${message}`);
};

const webhook = read('app/api/telegram/webhook/route.ts');
const adminWebhook = read('app/api/admin/telegram-webhook/route.ts');
const pairing = read('app/api/telegram/pair/route.ts');
const db = read('lib/telegram-db.ts');
const controller = read('lib/telegram-trade-controller.ts');
const security = read('lib/telegram-security.ts');
const env = read('.env.example');

assert(webhook.includes("requireTelegramWebhookSecret(req)"), 'webhook secret verification is required');
assert(webhook.includes('claimTelegramUpdate(sql, updateId)'), 'webhook update idempotency is required');
assert(webhook.includes("cb.id"), 'callback id must be forwarded as trade idempotency key');

assert(adminWebhook.includes('requireTelegramAdminSecret(req)'), 'admin webhook endpoint must require admin authorization');
assert(adminWebhook.includes('secret_token: webhookSecret'), 'Telegram webhook secret must be registered with Telegram');
assert(!adminWebhook.includes('telegram_response: data'), 'raw Telegram admin response must not be exposed');

assert(pairing.includes('new DerivAuthenticatedClient(token)'), 'pairing must validate the Deriv token');
assert(pairing.includes('client.getAccountsList()'), 'pairing must verify the requested account against Deriv');
assert(pairing.includes('client.connect(accountId)'), 'pairing must verify the authenticated account session');
assert(!pairing.includes('const { account_id, token, account_type, currency, email } = body'), 'client-supplied account metadata must not be trusted wholesale');

assert(db.includes('TELEGRAM_AUTH_SECRET'), 'Telegram encryption must require TELEGRAM_AUTH_SECRET');
assert(!db.includes('telegram-secret-fallback'), 'hardcoded encryption fallback must be removed');
assert(db.includes('telegram_update_events'), 'Telegram update idempotency table must exist');
assert(db.includes('telegram_trade_intents'), 'Telegram trade idempotency table must exist');

assert(controller.includes('/api/signals/predict'), 'Telegram must use the live production prediction API');
assert(controller.includes('isAutoDuration: true'), 'Telegram must request authoritative auto-duration selection');
assert(controller.includes('claimTelegramTradeIntent'), 'trade execution must be idempotent');
assert(controller.includes('updateTelegramTradeIntent'), 'trade intent status must be finalized');
assert(controller.includes('modelVersion'), 'Telegram signal display must derive model metadata from live prediction');
assert(!controller.includes('74.2%'), 'hardcoded 74.2% Telegram signal must be removed');
assert(!controller.includes('69.0%'), 'hardcoded 69.0% Telegram signal must be removed');
assert(!controller.includes('65.5%'), 'hardcoded 65.5% Telegram signal must be removed');
assert(!controller.includes("let balanceStr = '$0.00 USD'"), 'balance failure must not render as zero');
assert(!controller.includes('deriv_user@mail.com'), 'fake email fallback must be removed');
assert(controller.includes('safeSendApi'), 'Telegram API failures must be isolated and retried');

assert(security.includes('timingSafeEqual'), 'Telegram secrets must be compared in constant time');
assert(env.includes('TELEGRAM_WEBHOOK_SECRET='), 'Telegram webhook secret must be documented');
assert(env.includes('TELEGRAM_AUTH_SECRET='), 'Telegram encryption secret must be documented');

console.log('Telegram security invariants: PASS');
