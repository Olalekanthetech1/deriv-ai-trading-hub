import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const migrationFile = path.join(root, 'scripts/migrate-legacy-model-registry-v2.mjs');
const packageFile = path.join(root, 'package.json');

if (!fs.existsSync(migrationFile)) throw new Error('[Legacy Model Registry Migration] migration runner is missing.');
if (!fs.existsSync(packageFile)) throw new Error('[Legacy Model Registry Migration] package.json is missing.');

const migration = fs.readFileSync(migrationFile, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
const violations = [];

if (!migration.includes("const LEGACY_TABLE = 'ml_model_registry';")) violations.push('legacy source table is not explicit');
if (!migration.includes("const TARGET_TABLE = 'ml_model_registry_v2';")) violations.push('new target table is not explicit');
if (!migration.includes("const EXECUTE = process.argv.includes('--execute');")) violations.push('migration is not dry-run by default');
if (!migration.includes('Migration blocked:')) violations.push('migration does not block incomplete mappings');
if (!migration.includes('BEGIN') || !migration.includes('COMMIT') || !migration.includes('ROLLBACK')) violations.push('migration is not transactional');
if (!migration.includes('legacyRegistryRow')) violations.push('legacy source lineage is not retained in migrated metadata');
if (!migration.includes('migrate-legacy-registry')) violations.push('migration does not emit an audit event');
if (!migration.includes('ALTER TABLE public.${LEGACY_TABLE} RENAME TO')) violations.push('legacy table archival path is missing');
if (!migration.includes('ON CONFLICT (model_id) DO NOTHING')) violations.push('migration is not idempotent for existing model IDs');
if (pkg.scripts?.['db:migrate-legacy-model-registry'] !== 'node scripts/migrate-legacy-model-registry-v2.mjs') violations.push('package migration command is missing or points to another runner');

if (violations.length) {
  throw new Error(`[Legacy Model Registry Migration Invariants] violations detected:\n${violations.join('\n')}`);
}

console.log('[Legacy Model Registry Migration Invariants] passed: dry-run default, explicit new target, transactional migration, lineage preservation, audit, idempotent insert and controlled archival are present.');
