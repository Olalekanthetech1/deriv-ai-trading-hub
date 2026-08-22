import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const ranking = read('lib/live-market-ranking.ts');
const compatibility = read('lib/market-ranking-cache.ts');
const symbols = read('lib/rise-fall-symbols.ts');
const ticks = read('lib/ticks-helper.ts');
const predictionRoute = read('app/api/signals/predict/route.ts');

const forbidden = [
  'inMemorySnapshot',
  'activeRefreshPromise',
  'CACHE_KEY',
  'MAX_ALLOWED_DATA_AGE_MS',
  'cachedSymbols',
  'cacheExpiresAt',
  'inFlightDiscovery',
  'inFlightTickHistory',
  "FROM market_assets",
  "INSERT INTO market_assets",
  'v2-production',
  'v2-microstructure',
  'stage1Score',
  'medianCadenceMs',
  'confidence) || 50',
  'confidence || 50',
];

for (const token of forbidden) {
  if (ranking.includes(token) || symbols.includes(token) || ticks.includes(token)) {
    throw new Error(`Live signal cache invariant failed: forbidden token found: ${token}`);
  }
}

if (!ranking.includes("fetch(`${baseUrl}/api/signals/predict`")) {
  throw new Error('Live signal cache invariant failed: ranking does not query the authoritative signal API.');
}
if (!ranking.includes("cache: 'no-store'")) {
  throw new Error('Live signal cache invariant failed: signal requests are not explicitly no-store.');
}
if (!ranking.includes("'x-live-signal-request': 'true'")) {
  throw new Error('Live signal cache invariant failed: direct live-request marker is missing.');
}
if (!ranking.includes('predictionTimestamp')) {
  throw new Error('Live signal cache invariant failed: freshness is not derived from authoritative prediction timestamps.');
}
if (!symbols.includes('Dynamically discover active Deriv instruments on every invocation.')) {
  throw new Error('Live signal cache invariant failed: symbol discovery is not explicitly uncached.');
}
if (!ticks.includes('Always performs a fresh Deriv request.')) {
  throw new Error('Live signal cache invariant failed: tick requests are not explicitly uncached.');
}
if (!predictionRoute.includes("'Cache-Control': 'no-store'")) {
  throw new Error('Live signal cache invariant failed: prediction API is missing no-store response headers.');
}
if (!compatibility.includes("from './live-market-ranking'")) {
  throw new Error('Live signal cache invariant failed: legacy ranking import is not redirected to live implementation.');
}

console.log('Live signal no-cache invariants: PASS');
