import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const contract = read('lib/ml-horizon-contract.ts');
const featureRegistry = read('lib/ml-feature-registry.ts');
const durationRegistry = read('lib/deriv-duration-registry.ts');
const datasetBuilder = read('lib/training-dataset-builder-duration-v2.ts');

const assertions = [
  [contract.includes('export type MlHorizonDescriptor'), 'horizon contract must define a canonical descriptor'],
  [contract.includes("type: 'tick' | 'time'"), 'horizon descriptor must distinguish tick and time horizons'],
  [contract.includes('effectiveHorizonTicks: number | null'), 'horizon lineage must carry the resolved effective tick horizon'],
  [contract.includes('key: string'), 'horizon descriptor must have a canonical stable key'],
  [contract.includes('validateHorizonCohort'), 'shared-horizon artifacts must validate a complete cohort contract'],
  [contract.includes('featureSchemaVersion'), 'cohort validation must bind the feature schema'],
  [contract.includes('featureOrder'), 'cohort validation must bind canonical feature ordering'],
  [contract.includes('featureWindowTicks'), 'cohort validation must bind observation-window topology'],
  [contract.includes('pipelineVersion'), 'cohort validation must bind pipeline version'],
  [contract.includes('Duplicate horizon in cohort'), 'duplicate horizons must be rejected'],
  [contract.includes('missing resolved effectiveHorizonTicks'), 'unresolved horizon lineage must be rejected before shared-artifact training'],
  [contract.includes('canonical tick-property feature contract'), 'horizon contract must preserve the existing feature architecture'],
  [featureRegistry.includes('FEATURE_DEFINITIONS'), 'canonical feature registry must remain the feature source of truth'],
  [durationRegistry.includes("export type DerivDurationUnit = 't' | 's' | 'm' | 'h' | 'd'"), 'horizon contract must use the existing Deriv duration-unit contract'],
  [datasetBuilder.includes('durationToSeconds'), 'dataset builder must continue resolving broker duration semantics centrally'],
  [datasetBuilder.includes("durationUnit === 't' ? anchorIndex + durationValue :"), 'existing tick/time target semantics must remain intact during migration'],
];

const failures = assertions.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) {
  console.error('ML horizon contract invariant failures:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`ML horizon contract invariants passed (${assertions.length} checks).`);
