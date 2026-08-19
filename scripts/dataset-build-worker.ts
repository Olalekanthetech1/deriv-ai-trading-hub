import crypto from 'node:crypto';
import os from 'node:os';
import { getDbOrThrow } from '@/lib/db';
import { getQueueWorkerRuntimeConfig } from '@/lib/ops-runtime-config';
import { recordWorkerHeartbeat, flushStaleWorkerHeartbeats, type WorkerTelemetryMetrics } from '@/lib/ml-training-queue';
import { migrateHistoricalFeasibilityFailures, getAutoDatasetJob, claimNextAutoDatasetJobItem, getAutoDatasetJobItemStatus, completeAutoDatasetJobItem, failAutoDatasetJobItem, skipAutoDatasetJobItem, discardAutoDatasetBuild, refreshAutoDatasetJobStatus } from '@/lib/auto-dataset-job-store';
import { listDurationTrainingDatasets, buildDurationTrainingDataset } from '@/lib/training-dataset-builder-duration-v2';
import { ensureBackgroundJobWakeupTriggers, startBackgroundJobWakeupListener } from '@/lib/background-job-wakeup';

const workerId = `dataset-worker:${process.env.RENDER_INSTANCE_ID?.trim() || 'local'}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const reconciliationMs = Math.max(10000, Math.min(300000, Number(process.env.DATASET_WORKER_RECONCILIATION_INTERVAL_MS || 60000)));
const staleAfterMinutes = Math.max(2, Math.min(30, Number(process.env.DATASET_WORKER_STALE_AFTER_MINUTES || 10)));
const heartbeatMs = Math.max(5000, Math.min(120000, Number(process.env.DATASET_WORKER_HEARTBEAT_MS || 30000)));
let stopping = false;
let activeItem: { jobId: string; itemId: number } | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let wakeupResolver: (() => void) | null = null;
let stopWakeupListener: (() => Promise<void>) | null = null;

function gatherWorkerTelemetry(): WorkerTelemetryMetrics {
  const mem = process.memoryUsage();
  const sysTotal = os.totalmem();
  const sysFree = os.freemem();
  const sysUsed = Math.max(0, sysTotal - sysFree);
  const sysUsagePct = sysTotal > 0 ? Number(((sysUsed / sysTotal) * 100).toFixed(1)) : 0;
  const loadAvg = os.loadavg();

  return {
    heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
    heapTotalMb: Math.round(mem.heapTotal / (1024 * 1024)),
    rssMb: Math.round(mem.rss / (1024 * 1024)),
    externalMb: Math.round(mem.external / (1024 * 1024)),
    systemFreeMemMb: Math.round(sysFree / (1024 * 1024)),
    systemTotalMemMb: Math.round(sysTotal / (1024 * 1024)),
    systemMemoryUsagePct: sysUsagePct,
    loadAverage: [
      Number(loadAvg[0]?.toFixed(2) || 0),
      Number(loadAvg[1]?.toFixed(2) || 0),
      Number(loadAvg[2]?.toFixed(2) || 0),
    ],
    uptimeSecs: Math.round(process.uptime()),
    pid: process.pid,
    nodeVersion: process.version,
    activeJobsCount: activeItem ? 1 : 0,
  };
}

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitForWakeup(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (wakeupResolver === resolveWake) wakeupResolver = null;
      resolve();
    }, timeoutMs);
    const resolveWake = () => {
      clearTimeout(timer);
      if (wakeupResolver === resolveWake) wakeupResolver = null;
      resolve();
    };
    wakeupResolver = resolveWake;
  });
}
function wakeWorker() { wakeupResolver?.(); }
function feasibility(message: string) {
  return /^(No persisted real ticks can satisfy|No non-flat directional samples could be constructed|Temporal split validation failed|Insufficient real Deriv ticks|The duration-aware feature window requires)/i.test(message.trim());
}

async function heartbeat() {
  if (!activeItem) return;
  try {
    const sql = getDbOrThrow();
    await sql`UPDATE ops_ml_dataset_build_job_items SET claimed_at = NOW() WHERE id = ${activeItem.itemId} AND job_id = ${activeItem.jobId} AND status = 'running'`;
    await recordWorkerHeartbeat(workerId, 'online', 'dataset_worker', gatherWorkerTelemetry());
  } catch (error) {
    console.error('[Dataset Worker] heartbeat failed:', error);
  }
}

function startHeartbeat(jobId: string, itemId: number) {
  activeItem = { jobId, itemId };
  void heartbeat();
  heartbeatTimer = setInterval(() => void heartbeat(), heartbeatMs);
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  activeItem = null;
}

async function runningJobIds(): Promise<string[]> {
  const sql = getDbOrThrow();
  const rows = await sql`SELECT id FROM ops_ml_dataset_build_jobs WHERE status = 'running' AND archived_at IS NULL ORDER BY started_at ASC`;
  return rows.map((row: any) => String(row.id));
}

async function processJob(jobId: string): Promise<boolean> {
  const job = await getAutoDatasetJob(jobId);
  if (!job || job.status !== 'running') return false;
  const existingDatasets = await listDurationTrainingDatasets(job.symbol);
  const existingIds = new Set(existingDatasets
    .filter((dataset: any) => dataset?.status === 'completed' && dataset?.leakage_check_passed === true && Number(dataset?.sample_count ?? 0) > 0)
    .map((dataset: any) => `${String(dataset.duration_unit)}:${Number(dataset.duration_value)}`));

  const item = await claimNextAutoDatasetJobItem(jobId, staleAfterMinutes);
  if (!item) {
    await refreshAutoDatasetJobStatus(jobId);
    return false;
  }

  startHeartbeat(jobId, item.id);
  try {
    const identity = `${item.unit}:${item.value}`;
    if (existingIds.has(identity)) {
      await skipAutoDatasetJobItem(jobId, item.id, `ALREADY_EXISTS: a completed leakage-safe dataset already exists for ${job.symbol} at ${item.value}${item.unit}.`);
      return true;
    }

    const result = await buildDurationTrainingDataset({
      symbol: job.symbol,
      durationValue: item.value,
      durationUnit: item.unit,
      durationRangeId: item.rangeId ?? undefined,
    });
    const status = await getAutoDatasetJobItemStatus(jobId, item.id);
    if (status === 'cancelled') {
      await discardAutoDatasetBuild(result.datasetId);
      await refreshAutoDatasetJobStatus(jobId);
      return true;
    }
    await completeAutoDatasetJobItem(jobId, item.id);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (feasibility(message)) await skipAutoDatasetJobItem(jobId, item.id, message);
    else await failAutoDatasetJobItem(jobId, item.id, message);
    return true;
  } finally {
    stopHeartbeat();
  }
}

async function processAvailableJobs(): Promise<void> {
  const config = await getQueueWorkerRuntimeConfig();
  if (config.isPaused) return;

  const jobs = await runningJobIds();
  for (const jobId of jobs) {
    if (stopping) break;
    while (!stopping && await processJob(jobId)) {
      const liveConfig = await getQueueWorkerRuntimeConfig();
      if (liveConfig.isPaused) break;
      // Drain all currently claimable items for this job before waiting.
    }
  }
}

async function main() {
  console.log(`[Dataset Worker] started id=${workerId} reconciliation=${reconciliationMs}ms stale=${staleAfterMinutes}m heartbeat=${heartbeatMs}ms`);
  try {
    await flushStaleWorkerHeartbeats().catch(() => {});
    const migrated = await migrateHistoricalFeasibilityFailures();
    if (migrated > 0) console.log(`[Dataset Worker] migrated ${migrated} historical feasibility job(s).`);
    await ensureBackgroundJobWakeupTriggers();
    stopWakeupListener = await startBackgroundJobWakeupListener('dataset_jobs', wakeWorker);
  } catch (error) {
    console.error('[Dataset Worker] startup wakeup initialization failed; reconciliation remains active:', error);
  }

  try { await recordWorkerHeartbeat(workerId, 'online', 'dataset_worker', gatherWorkerTelemetry()); } catch (err) { console.warn('[Dataset Worker] initial heartbeat deferred:', (err as Error).message); }
  statusHeartbeatTimer = setInterval(() => {
    void recordWorkerHeartbeat(workerId, stopping ? 'stopping' : 'online', 'dataset_worker', gatherWorkerTelemetry()).catch((error) => {
      console.error('[Dataset Worker] status heartbeat failed:', error);
    });
  }, heartbeatMs);

  while (!stopping) {
    try {
      await flushStaleWorkerHeartbeats().catch(() => {});
      await processAvailableJobs();
      if (!stopping) await waitForWakeup(reconciliationMs);
    } catch (error) {
      console.error('[Dataset Worker] loop error:', error);
      await sleep(Math.min(30000, reconciliationMs));
    }
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  wakeWorker();
  if (statusHeartbeatTimer) clearInterval(statusHeartbeatTimer);
  statusHeartbeatTimer = null;
  if (stopWakeupListener) {
    try { await stopWakeupListener(); } catch (error) { console.error('[Dataset Worker] listener shutdown failed:', error); }
  }
  try { await recordWorkerHeartbeat(workerId, 'stopping', 'dataset_worker', gatherWorkerTelemetry()); } catch { /* best effort */ }
  console.warn(`[Dataset Worker] received ${signal}; activeItem=${activeItem ? `${activeItem.jobId}/${activeItem.itemId}` : 'none'}.`);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('uncaughtException', (error) => console.error('[Dataset Worker] uncaught exception:', error));
process.on('unhandledRejection', (reason) => console.error('[Dataset Worker] unhandled rejection:', reason));
void main().catch((error) => { console.error('[Dataset Worker] fatal:', error); process.exitCode = 1; });
