import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourceRoots = ['app', 'components', 'lib', 'scripts'];
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.py']);

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

const files = sourceRoots.flatMap((relativeRoot) => walk(path.join(root, relativeRoot)));
const violations = [];
const guardFile = 'scripts/tests/gate6-legacy-boundary-guard.mjs';
const dbCompatibilityFile = 'lib/db.ts';

function relativePath(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

function isRouteOrAdmin(relative) {
  return /^app\/(api\/.*|admin\/.*)\.(ts|tsx)$/.test(relative);
}

// The old synchronous model-registration API is not an application boundary.
// The canonical worker/runtime pipeline owns model persistence now.
const legacyRegistrationPatterns = [
  /\bregisterModelInDb\b/,
];

for (const file of files) {
  const relative = relativePath(file);
  if (relative === guardFile || relative === dbCompatibilityFile) continue;

  const content = fs.readFileSync(file, 'utf8');
  for (const pattern of legacyRegistrationPatterns) {
    if (pattern.test(content)) {
      violations.push(`${relative} -> legacy model-registration API (${pattern.source})`);
    }
  }
}

// Training execution must remain behind the canonical ML runtime / dedicated
// worker boundary. Reject both the retired daemon module and its old symbol.
for (const file of files) {
  const relative = relativePath(file);
  const content = fs.readFileSync(file, 'utf8');
  if (!isRouteOrAdmin(relative)) continue;

  if (/from\s+['"][^'"]*(?:xgboost-daemon|ml-training-worker)[^'"]*['"]/.test(content)) {
    violations.push(`${relative} -> direct retired training runtime import in app layer`);
  }
  if (/\bxgboostDaemon\b/.test(content)) {
    violations.push(`${relative} -> retired xgboostDaemon symbol in app layer`);
  }
}

// The queue recovery API has one canonical name. Do not allow compatibility
// aliases to re-enter the production path.
for (const file of files) {
  const relative = relativePath(file);
  if (relative === guardFile) continue;
  const content = fs.readFileSync(file, 'utf8');
  if (/\brecoverStaleTrainingJobs\b/.test(content)) {
    violations.push(`${relative} -> retired training recovery alias`);
  }
}

// Prevent browser/client components from importing known server-only training
// boundaries through aliases or relative paths.
for (const file of files) {
  const relative = relativePath(file);
  const content = fs.readFileSync(file, 'utf8');
  if (!/\.(tsx|jsx)$/.test(relative) || !/^app\//.test(relative)) continue;

  if (/['"]use client['"]/.test(content)) {
    if (/from\s+['"][^'"]*(?:ml-training-worker|xgboost-daemon|ml-runtime-client)[^'"]*['"]/.test(content)) {
      violations.push(`${relative} -> client component imports server-only ML runtime boundary`);
    }
  }
}

if (violations.length) {
  throw new Error(`[Gate 6 Legacy Boundary] violations detected:\n${violations.join('\n')}`);
}

console.log('[Gate 6 Legacy Boundary] passed: no production callers depend on retired ML runtime, synchronous registration, or compatibility recovery aliases.');
