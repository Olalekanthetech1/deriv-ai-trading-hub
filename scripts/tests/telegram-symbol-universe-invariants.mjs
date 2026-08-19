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
assert.ok(discovery.includes('allowCachedOnError'), 'Symbol discovery must expose explicit stale-cache policy');
assert.ok(discovery.includes('if (allowCachedOnError && cachedSymbols'), 'Stale cache must be opt-in');
console.log('Telegram symbol-universe invariants: PASSED');
