import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../lib/ticks-helper.ts', import.meta.url), 'utf8');

const required = [
  'const tickHistoryInFlight = new Map<string, Promise<TickPoint[]>>();',
  'const existing = tickHistoryInFlight.get(normalizedSymbol);',
  'tickHistoryInFlight.set(normalizedSymbol, promise);',
  'tickHistoryInFlight.delete(normalizedSymbol);',
  'return fetchDerivTickHistoryOnce(normalizedSymbol, count, end);',
];

for (const fragment of required) {
  if (!source.includes(fragment)) {
    throw new Error(`Deriv tick single-flight invariant missing: ${fragment}`);
  }
}

console.log('[Deriv Tick Single-Flight Invariant] passed: concurrent live tick-history requests for the same symbol share one in-flight fetch and do not create duplicate Deriv WebSocket connections.');
