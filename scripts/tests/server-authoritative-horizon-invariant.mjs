import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Server-authoritative horizon invariant failed: ${message}`);
  }
}

const durationUtils = read('lib/duration-utils.ts');
const realtimeSignals = read('hooks/use-realtime-signals.ts');
const tradeControls = read('components/trade-controls.tsx');
const proModeControls = read('components/custom/pro-mode-controls.tsx');
const aiTraderControls = read('components/custom/ai-trader-controls.tsx');

const forbiddenClientOptimizers = [
  'resolveOptimalHorizon',
  'calculateDynamicOptimalDuration',
  'generateClientDecisionSnapshot',
  'CLIENT-MICRO-',
  'Dynamic client-side optimization',
  'Client-side initialization',
];

for (const token of forbiddenClientOptimizers) {
  assert(!durationUtils.includes(token), `duration-utils.ts contains removed client optimizer token: ${token}`);
  assert(!realtimeSignals.includes(token), `use-realtime-signals.ts contains removed client optimizer token: ${token}`);
}

assert(
  /const decisionSnapshot = serverDecisionSnapshot;/.test(realtimeSignals),
  'realtime signals must expose the server decision snapshot directly'
);
assert(
  /decisionSnapshot\?\.decision\?\.horizon/.test(tradeControls),
  'TradeControls must project the displayed Auto horizon from the server decision snapshot'
);
assert(
  /executionPlan\.selectedHorizon/.test(proModeControls),
  'Pro AI execution must use the server execution plan horizon'
);
assert(
  /\/api\/signals\/predict/.test(aiTraderControls) && /executionPlan\.selectedHorizon/.test(aiTraderControls),
  'Dedicated AI Trader must obtain and execute the server-selected horizon'
);

console.log('Server-authoritative horizon invariant: PASS');
