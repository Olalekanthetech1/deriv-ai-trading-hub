import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const route = fs.readFileSync(path.join(root, 'app/api/ml/registry/route.ts'), 'utf8');
const retirement = fs.readFileSync(path.join(root, 'lib/ml-model-retirement.ts'), 'utf8');
const page = fs.readFileSync(path.join(root, 'app/admin/models/retire/page.tsx'), 'utf8');

const violations = [];

if (!route.includes("action === 'retire'")) violations.push('registry API does not expose controlled retirement');
if (!route.includes('retireProductionModel')) violations.push('registry API does not delegate retirement to the lifecycle boundary');
if (!route.includes('Direct registry deletion is disabled')) violations.push('destructive registry deletion remains exposed');
if (!retirement.includes("status = 'production'")) violations.push('retirement does not require an active production record');
if (!retirement.includes("SET status = 'retired'")) violations.push('retirement does not persist the retired lifecycle state');
if (!retirement.includes('ops_audit_events')) violations.push('retirement is missing an audit event');
if (!retirement.includes('retire_production_model')) violations.push('retirement audit action is missing');
if (!page.includes("/api/ml/registry?status=production")) violations.push('retirement console is not sourced from the live production registry');
if (!page.includes("action: 'retire'")) violations.push('retirement console does not call the controlled retire action');
if (!page.includes('does not delete')) violations.push('retirement UI does not explicitly distinguish retirement from deletion');

if (violations.length) throw new Error(`[Production Model Retirement Invariants] violations detected:\n${violations.join('\n')}`);

console.log('[Production Model Retirement Invariants] passed: production-only retirement, destructive deletion guard, auditability, and live-registry UI are present.');
