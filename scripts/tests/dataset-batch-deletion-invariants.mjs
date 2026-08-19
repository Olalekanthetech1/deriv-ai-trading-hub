import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const batchDeleteRoute = read('app/api/admin/datasets/batch-delete/route.ts');
const datasetBuilder = read('components/admin/multi-asset-training-dataset-builder.tsx');

const assertions = [
  [batchDeleteRoute.includes('export async function POST'), 'batch delete route must export a POST handler'],
  [batchDeleteRoute.includes('isAuthenticated('), 'batch delete route must require authenticated admin session'],
  [batchDeleteRoute.includes('cancelAutoDatasetItemsForDataset'), 'batch delete route must cancel matching in-flight AUTO jobs to prevent resurrection'],
  [batchDeleteRoute.includes('ml_training_runs'), 'batch delete route must check ml_training_runs lineage before deleting'],
  [batchDeleteRoute.includes('ml_model_registry_v2'), 'batch delete route must check ml_model_registry_v2 lineage before deleting'],
  [batchDeleteRoute.includes('blockedDatasets'), 'batch delete route must report blocked datasets safely'],
  [datasetBuilder.includes('selectedDatasetIds'), 'dataset builder must track selectedDatasetIds state'],
  [datasetBuilder.includes('/api/admin/datasets/batch-delete'), 'dataset builder must call the batch delete API endpoint'],
  [datasetBuilder.includes('selectAllFilteredDatasets'), 'dataset builder must support select-all for filtered datasets'],
  [datasetBuilder.includes('Delete Selected'), 'dataset builder must render a batch delete action'],
];

const failures = assertions.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) {
  console.error('Dataset batch deletion invariant failures:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Dataset batch deletion invariants passed (${assertions.length} checks).`);
