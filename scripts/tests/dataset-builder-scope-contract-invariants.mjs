import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const route = read('app/api/admin/dataset-batches/route.ts');
const singleAssetRoute = read('app/api/admin/datasets/route.ts');
const store = read('lib/auto-dataset-job-store.ts');
const atomic = read('lib/auto-dataset-job-store-atomic.ts');
const builder = read('lib/training-dataset-builder-duration-v2.ts');
const worker = read('scripts/dataset-build-worker.ts');
const packageJson = read('package.json');
const render = read('render.yaml');

const assertions = [
  [route.includes("createAutoDatasetJobAtomic"), 'batch route must use the atomic AUTO job scope writer'],
  [!route.includes('requestedRangeId('), 'batch route must not generate synthetic requested range IDs'],
  [route.includes('rangeId: matches[0]?.id ?? null'), 'unmatched discovery must persist a nullable real range reference'],
  [route.includes("status: message.startsWith('AUTO_DATASET_SCOPE_CONFLICT:') ? 'conflict' : 'failed'"), 'scope conflicts must be surfaced distinctly from infrastructure failures'],
  [route.includes('status: hasConflict ? 409 : 422'), 'all-conflict submissions must return an explicit conflict status'],
  [singleAssetRoute.includes('createAutoDatasetJobAtomic'), 'single-asset AUTO route must use the same atomic scope writer'],
  [!singleAssetRoute.includes('createAutoDatasetJob('), 'single-asset AUTO route must not call the legacy non-atomic writer'],
  [atomic.includes('WITH inserted_job AS'), 'AUTO parent/job-item persistence must be one SQL statement'],
  [atomic.includes('ON CONFLICT DO NOTHING'), 'concurrent AUTO reservations must be deterministic'],
  [atomic.includes('CROSS JOIN UNNEST('), 'all selected horizons must be persisted in the same atomic scope write'],
  [!atomic.includes("SET status = 'failed'"), 'atomic scope writer must not silently supersede an active scope'],
  [store.includes('duration_range_id VARCHAR(160)'), 'job-item range reference must remain represented at the persistence boundary'],
  [store.includes("status = 'running' AND claimed_at < NOW()"), 'dataset item claims must support stale-worker recovery'],
  [builder.includes('durationToSeconds'), 'dataset construction must derive target horizon from duration value/unit'],
  [builder.includes('durationUnit === \'t\' ? anchorIndex + durationValue :'), 'tick/time target construction must remain duration-scope driven'],
  [worker.includes('claimNextAutoDatasetJobItem(jobId, staleAfterMinutes)'), 'a dedicated worker must claim durable pending/stale dataset items'],
  [worker.includes('SET claimed_at = NOW()'), 'long-running dataset builds must heartbeat their item lease'],
  [worker.includes('getDbOrThrow'), 'dataset worker must use the shared database boundary'],
  [packageJson.includes('"dataset:worker": "tsx scripts/dataset-build-worker.ts"'), 'dataset worker must have a production package entry point'],
  [render.includes('name: deriv-ai-dataset-worker'), 'Render must provision a dedicated dataset worker'],
  [render.includes('dockerCommand: npm run dataset:worker'), 'Render dataset worker must execute the durable dataset queue worker'],
];

const failures = assertions.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) {
  console.error('Dataset builder scope contract invariant failures:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Dataset builder scope contract invariants passed (${assertions.length} checks).`);
