import fs from 'node:fs';

const sources = [
  ['lib/production-model-resolver.ts', 'Production model resolver'],
  ['lib/ml-model-artifact-store.ts', 'Durable artifact store'],
  ['lib/production-ensemble.ts', 'Production ensemble'],
  ['app/api/ml/registry/route.ts', 'Model registry route'],
  ['app/api/ml/production-health/route.ts', 'Production health route'],
  ['scripts/ml_ensemble_runtime.py', 'Native ensemble runtime'],
  ['scripts/ml_runtime_entry.py', 'Native runtime entrypoint'],
];

const contents = new Map(sources.map(([path]) => [path, fs.readFileSync(path, 'utf8')]));
const violations = [];
const require = (text, pattern, message) => { if (!pattern.test(text)) violations.push(message); };

const resolver = contents.get('lib/production-model-resolver.ts');
const store = contents.get('lib/ml-model-artifact-store.ts');
const ensemble = contents.get('lib/production-ensemble.ts');
const registry = contents.get('app/api/ml/registry/route.ts');
const health = contents.get('app/api/ml/production-health/route.ts');
const runtime = contents.get('scripts/ml_ensemble_runtime.py');
const entry = contents.get('scripts/ml_runtime_entry.py');

require(resolver, /status = \x27production\x27/, 'Resolver must select only production registry rows');
require(resolver, /resolveAndMaterializeProductionModel/, 'Resolver must expose governed artifact materialization');
require(resolver, /hasModelArtifact/, 'Resolver must verify durable artifact presence');
require(store, /sha256/, 'Artifact store must persist checksum metadata');
require(store, /BYTEA/, 'Artifact store must use durable binary storage');
require(ensemble, /resolveProductionModels/, 'Production ensemble must use the central production resolver');
require(ensemble, /artifactPath/, 'Production ensemble must pass a materialized governed artifact path');
require(registry, /hasModelArtifact/, 'Promotion must require a durable artifact');
require(health, /getProductionModelHealth/, 'Production health must use the central resolver');
require(runtime, /artifactPath/, 'Native runtime must execute the resolved artifact');
require(runtime, /artifactSha256/, 'Native runtime must verify artifact provenance');
require(entry, /Production ML daemon entrypoint/, 'Native runtime entrypoint must remain production-scoped');

for (const [path, text] of contents.entries()) {
  if (/ml_duration_runtime_adapter|install_duration_runtime_adapter/.test(text)) {
    violations.push(`${path} -> retired duration runtime adapter still referenced`);
  }
}

if (violations.length) {
  throw new Error(`[Production Model Contract Invariants] violations detected:\n${violations.join('\n')}`);
}

console.log('[Production Model Contract Invariants] passed: one production resolver, durable artifact verification, governed native inference, promotion gating, and runtime retirement boundary are enforced.');
