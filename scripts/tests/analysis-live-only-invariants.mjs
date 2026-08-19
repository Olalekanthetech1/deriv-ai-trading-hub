import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files = [
  'app/api/signals/predict/route.ts',
  'hooks/use-realtime-signals.ts',
  'components/custom/signals-drawer.tsx',
  'components/custom/mode-nav-bar.tsx',
  'lib/ml-feature-registry.ts',
  'lib/production-model-resolver.ts',
  'lib/production-ensemble.ts',
  'lib/horizon-decision-engine.ts',
  'lib/probabilistic-drift-engine.ts',
  'lib/signal-manager.ts',
  'lib/ticks-helper.ts',
  'lib/deriv-public-websocket.ts',
];

const forbidden = [
  { label: 'wait signal state', pattern: /['\"]WAIT['\"]/ },
  { label: 'hold-no-signal action', pattern: /HOLD_NO_SIGNAL/ },
  { label: 'fake R_100 default symbol', pattern: /[:=]\s*['\"]R_100['\"]/ },
  { label: 'hardcoded payout ratio', pattern: /payoutRatio\s*=\s*0\.95/ },
  { label: 'hardcoded liquidity quality', pattern: /liquidityQuality\s*=\s*0\.96/ },
  { label: 'synthetic 0.58 accuracy fallback', pattern: /\?\?\s*0\.58/ },
  { label: 'synthetic 0.16 brier fallback', pattern: /\?\?\s*0\.16/ },
  { label: 'synthetic 50 quality fallback', pattern: /return\s+50\.0/ },
  { label: 'client horizon override', pattern: /horizonConfidenceOverrides/ },
  { label: 'static win statistics default', pattern: /winStats\s*=\s*\{\s*total:\s*0/ },
  { label: 'static asset presentation default', pattern: /underlying_symbol_name\s*\|\|/ },
  { label: 'static horizon presentation duration', pattern: /durationValue\s*\?\?\s*5|durationUnit\s*\?\?\s*['\"]t['\"]/ },
  { label: 'fake proposal latency presentation', pattern: /88ms Avg Proposal Latency/ },
  { label: 'fake execution telemetry presentation', pattern: /100% Target Horizon/ },
];

const failures = [];
for (const relative of files) {
  const absolute = path.join(root, relative);
  const source = fs.readFileSync(absolute, 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) failures.push(`${relative}: ${rule.label}`);
  }
}

const route = fs.readFileSync(path.join(root, 'app/api/signals/predict/route.ts'), 'utf8');
for (const token of ['symbol ?.', 'durationValue ??', 'durationUnit ??', "strength: 'Neutral'", 'stake,\n']) {
  if (route.includes(token)) failures.push(`route contains prohibited fallback/neutral token: ${token}`);
}

const hook = fs.readFileSync(path.join(root, 'hooks/use-realtime-signals.ts'), 'utf8');
if (/prices\.map\(\(price, idx\) => \(\{ price, timestamp: Date\.now\(\)/.test(hook)) failures.push('hook synthesizes tick timestamps');

if (failures.length) {
  console.error('Analysis live-only invariants FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Analysis live-only invariants PASSED');
