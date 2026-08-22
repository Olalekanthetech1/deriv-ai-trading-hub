import fs from 'node:fs';
import assert from 'node:assert/strict';

const controller = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');
const discovery = fs.readFileSync('lib/rise-fall-symbols.ts', 'utf8');

assert.equal(controller.includes('VALID_SYMBOLS'), false, 'Telegram must not define a static VALID_SYMBOLS set');
assert.equal(controller.includes("['R_100', 'R_75', 'R_50', 'R_25', 'R_10']"), false, 'Telegram must not embed the legacy five-symbol universe');
assert.equal(controller.includes('const SYMBOL_NAMES:'), false, 'Telegram display names must come from authoritative discovery metadata');
assert.ok(controller.includes('getLiveRiseFallSymbols'), 'Telegram must consume the authoritative symbol discovery layer');
assert.ok(controller.includes('getAuthoritativeTelegramSymbols'), 'Telegram must resolve its market universe centrally');
assert.ok(controller.includes('getLiveRiseFallSymbols(true, false)'), 'Telegram discovery must force a fresh, non-fallback market lookup');
assert.ok(discovery.includes('Dynamically discover active Deriv instruments on every invocation.'), 'Symbol discovery must explicitly be live per invocation');
assert.equal(discovery.includes('cachedSymbols'), false, 'Symbol discovery must not retain cached symbol state');
assert.equal(discovery.includes('cacheExpiresAt'), false, 'Symbol discovery must not retain a cache expiry');
assert.equal(discovery.includes('inFlightDiscovery'), false, 'Symbol discovery must not reuse an in-flight result as a cache/coalesced result');
assert.equal(discovery.includes('allowCachedOnError'), false, 'Symbol discovery must not expose a stale-cache fallback policy');
console.log('Telegram symbol-universe invariants: PASSED');
