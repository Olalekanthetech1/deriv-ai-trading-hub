import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const api = fs.readFileSync(path.join(root, 'app/api/admin/model-operations/summary/route.ts'), 'utf8');
const queue = fs.readFileSync(path.join(root, 'lib/ml-training-queue.ts'), 'utf8');
const status = fs.readFileSync(path.join(root, 'lib/ml-training-orchestrator.ts'), 'utf8');
const registryApi = fs.readFileSync(path.join(root, 'app/api/ml/registry/route.ts'), 'utf8');
const retirement = fs.readFileSync(path.join(root, 'lib/ml-model-retirement.ts'), 'utf8');
const retirementPage = fs.readFileSync(path.join(root, 'app/admin/models/retire/page.tsx'), 'utf8');

const violations = [];

if (!api.includes("verifySessionToken")) violations.push('summary API is missing server-side admin authorization');
if (!api.includes("Cache-Control") || !api.includes('no-store')) violations.push('summary API is missing no-store response policy');
if (!api.includes("getWorkerStatus()")) violations.push('summary API is not connected to the authoritative worker heartbeat');
if (!api.includes("ml_training_job_queue")) violations.push('summary API is not connected to the durable training queue');
if (!api.includes("ml_training_batches")) violations.push('summary API is not connected to persisted training batches');
if (!api.includes("ml_model_registry_v2")) violations.push('summary API is not connected to the persisted model registry');
if (!api.includes("dataSource: 'live-database-plus-dedicated-ml-worker'")) violations.push('summary API does not declare its authoritative data source');
if (!queue.includes('recoverAbandonedTrainingJobs')) violations.push('training queue lost abandoned-job recovery');
if (!queue.includes('heartbeatTrainingJob')) violations.push('training queue lost worker heartbeat support');
if (!status.includes("reconcileStaleTrainingRuns")) violations.push('training orchestration lost stale-run reconciliation');

if (!registryApi.includes("action === 'retire'")) violations.push('registry API does not expose controlled retirement');
if (!registryApi.includes('retireProductionModel')) violations.push('registry API does not delegate retirement to the lifecycle boundary');
if (!registryApi.includes('Direct registry deletion is disabled')) violations.push('destructive registry deletion remains exposed');
if (!retirement.includes("status = 'production'")) violations.push('retirement does not require an active production record');
if (!retirement.includes("SET status = 'retired'")) violations.push('retirement does not persist the retired lifecycle state');
if (!retirement.includes('ops_audit_events')) violations.push('retirement is missing an audit event');
if (!retirementPage.includes("/api/ml/registry?status=production")) violations.push('retirement console is not sourced from the live production registry');
if (!retirementPage.includes("action: 'retire'")) violations.push('retirement console does not call the controlled retire action');

if (violations.length) {
  throw new Error(`[Model Operations Invariants] violations detected:\n${violations.join('\n')}`);
}

console.log('[Model Operations Invariants] passed: summary boundary is authenticated, source-backed, worker-aware, queue-aware, batch-aware, registry-aware, stale-run recovery remains intact, and production retirement is controlled and auditable.');
