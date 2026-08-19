import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const guardFile = path.resolve(process.argv[1] || '');
const bannedPaths = [
  'lib/xgboost-engine.ts',
  'lib/xgboost-daemon.ts',
  'lib/onnx-engine.ts',
  'lib/lightgbm-engine.ts',
  'lib/catboost-engine.ts',
  'lib/tcn-engine.ts',
  'lib/lstm-engine.ts',
  'lib/transformer-engine.ts',
  'lib/hmm-engine.ts',
  'lib/isolation-forest-engine.ts',
  'lib/multi-model-evaluator.ts',
  'lib/probability-calibration-engine.ts',
  'scripts/xgboost_engine.py',
  'scripts/ml_runtime_v5.py',
];

for (const relativePath of bannedPaths) {
  if (fs.existsSync(path.join(root, relativePath))) {
    throw new Error(`[ML Architecture] Retired legacy module still exists: ${relativePath}`);
  }
}

const sourceRoots = ['app', 'components', 'lib', 'scripts'];
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.py']);
const bannedTokens = [
  './xgboost-engine', './xgboost-daemon', './onnx-engine', './lightgbm-engine', './catboost-engine', './tcn-engine',
  './lstm-engine', './transformer-engine', './hmm-engine', './isolation-forest-engine',
  'ml_runtime_v5', 'xgboost_engine.py', 'multi-model-evaluator', 'probability-calibration-engine',
];

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (extensions.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

const violations = [];
for (const relativeRoot of sourceRoots) {
  for (const file of walk(path.join(root, relativeRoot))) {
    if (path.resolve(file) === guardFile) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const token of bannedTokens) {
      if (content.includes(token)) violations.push(`${path.relative(root, file)} -> ${token}`);
    }
  }
}

const nativeRuntime = fs.readFileSync(path.join(root, 'scripts/ml_native_runtime.py'), 'utf8');
if (/\ndef\s+features\s*\(/.test(nativeRuntime) || /\ndef\s+(std|mom|vel|persist|reversal)\s*\(/.test(nativeRuntime)) {
  violations.push('scripts/ml_native_runtime.py -> duplicate feature-engineering implementation');
}

if (violations.length) {
  throw new Error(`[ML Architecture] Legacy boundary violations detected:\n${violations.join('\n')}`);
}

console.log('[ML Architecture] Legacy runtime guard passed. Native Python runtime + canonical Node feature pipeline are the only active ML implementation boundary.');
