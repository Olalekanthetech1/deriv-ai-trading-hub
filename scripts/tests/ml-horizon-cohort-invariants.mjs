import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const schema = read('lib/ml-horizon-cohort-schema.ts');
const store = read('lib/ml-horizon-cohort-store.ts');
const contract = read('lib/ml-horizon-contract.ts');

const required = [
  ['cohort schema table', 'CREATE TABLE IF NOT EXISTS ml_horizon_cohorts'],
  ['cohort dataset lineage table', 'CREATE TABLE IF NOT EXISTS ml_horizon_cohort_datasets'],
  ['dataset foreign-key protection', 'REFERENCES training_datasets(id) ON DELETE RESTRICT'],
  ['cohort contract validation', 'buildMlHorizonCohort(input.assetSymbol, horizons)'],
  ['completed dataset requirement', "row.status !== 'completed'"],
  ['leakage gate', 'row.leakage_check_passed !== true'],
  ['effective horizon lineage', 'effective_horizon_ticks'],
  ['transactional persistence', 'sql.transaction((tx) =>'],
  ['duplicate horizon protection', 'Duplicate horizon in cohort'],
];

for (const [name, token] of required) {
  const source = [schema, store, contract].join('\n');
  if (!source.includes(token)) throw new Error(`Missing ML horizon cohort invariant: ${name}`);
}

console.log('ML horizon cohort invariants passed.');
