import fs from 'node:fs';

const routePath = 'app/api/admin/ml-config/route.ts';
const pagePath = 'app/admin/ml-config/page.tsx';
const route = fs.readFileSync(routePath, 'utf8');
const page = fs.readFileSync(pagePath, 'utf8');
const violations = [];
const requireRoute = (pattern, description) => {
  if (!pattern.test(route)) violations.push(`${routePath} -> ${description}`);
};

requireRoute(/function isAdmin\(req: NextRequest\)/, 'admin authentication boundary missing');
requireRoute(/Cache-Control.*no-store/, 'no-store cache policy missing');
requireRoute(/validateMlPipelineConfig\(merged\)/, 'generated configuration is not validated before persistence');
requireRoute(/buildMlRuntimeSchemaContract\(validated\)/, 'runtime schema contract is not rebuilt during generation');
requireRoute(/validateMlPipelineConfig\(existing\.config\)/, 'activation does not revalidate persisted configuration');
requireRoute(/existing\.featureSchemaVersion !== contract\.featureSchemaVersion/, 'activation schema-version compatibility gate missing');
requireRoute(/reloadMlPipelineConfig\(\)/, 'runtime configuration reload after activation missing');
requireRoute(/recordObservabilityEvent\(/, 'configuration lifecycle is not observable');

const requiredPageSignals = [
  ['setSource', 'configuration source is not surfaced'],
  ['setVersion', 'active version is not surfaced'],
  ['setHash', 'configuration fingerprint is not surfaced'],
  ['setSchemaVersion', 'feature schema version is not surfaced'],
  ['durationFeaturePolicy', 'duration-aware feature policy is not surfaced'],
  ['/api/admin/ml-config', 'page is not connected to the canonical admin API'],
];
for (const [needle, description] of requiredPageSignals) {
  if (!page.includes(needle)) violations.push(`${pagePath} -> ${description}`);
}

if (violations.length) {
  throw new Error(`[ML Config Invariants] violations detected:\n${violations.join('\n')}`);
}

console.log('[ML Config Invariants] passed: authenticated, no-store, schema-validated, versioned and observable configuration boundary is intact.');
