import crypto from 'node:crypto';
import os from 'node:os';
import { recordWorkerHeartbeat, claimNextTrainingJob, finishTrainingJob, heartbeatTrainingJob, recoverAbandonedTrainingJobs, flushStaleWorkerHeartbeats, type TrainingQueueJob, type WorkerTelemetryMetrics } from '@/lib/ml-training-queue';
import { claimArtifactBackfill, finishArtifactBackfill, heartbeatArtifactBackfill } from '@/lib/ml-artifact-maintenance';
import { mlRuntimeClient } from '@/lib/ml-runtime-client';
import { trainDatasetModels } from '@/lib/ml-training-orchestrator';
import { trainUnifiedSequenceModels } from '@/lib/ml-unified-sequence-training-orchestrator';
import { claimNextSequenceTrainingJob, finishSequenceTrainingJob, heartbeatSequenceTrainingJob, recoverAbandonedSequenceTrainingJobs, type SequenceTrainingQueueJob } from '@/lib/ml-sequence-training-queue';
import { ensureBackgroundJobWakeupTriggers, startBackgroundJobWakeupListener } from '@/lib/background-job-wakeup';
import { executeArtifactBackfill } from '@/lib/ml-artifact-maintenance';

type ModelType = Parameters<typeof trainDatasetModels>[0]['modelTypes'];

const workerId = `${process.env.RENDER_INSTANCE_ID?.trim() || 'ml-worker'}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const reconciliationRaw = Number(process.env.ML_WORKER_RECONCILIATION_INTERVAL_MS || 60000);
const reconciliationMs = Math.max(10000, Math.min(300000, Number.isFinite(reconciliationRaw) ? Math.trunc(reconciliationRaw) : 60000));
const heartbeatRaw = Number(process.env.ML_WORKER_HEARTBEAT_INTERVAL_MS || 5000);
const heartbeatMs = Math.max(2000, Math.min(30000, Number.isFinite(heartbeatRaw) ? Math.trunc(heartbeatRaw) : 5000));
const workerStatusHeartbeatMs = Math.max(5000, Math.min(60000, Number(process.env.ML_WORKER_STATUS_HEARTBEAT_INTERVAL_MS || 15000)));
let stopping = false;
let activeJob: TrainingQueueJob | null = null;
let activeSequenceJob: SequenceTrainingQueueJob | null = null;
let stopActiveHeartbeat: (() => void) | null = null;
let stopActiveSequenceHeartbeat: (() => void) | null = null;
let stopWakeupListener: (() => Promise<void>) | null = null;
let workerStatusTimer: ReturnType<typeof setInterval> | null = null;
let wakeupResolver: (() => void) | null = null;

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
    activeJobsCount: (activeJob || activeSequenceJob) ? 1 : 0,
  };
}

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

process.env.OMP_NUM_THREADS = process.env.OMP_NUM_THREADS || '1';
process.env.OPENBLAS_NUM_THREADS = process.env.OPENBLAS_NUM_THREADS || '1';
process.env.MKL_NUM_THREADS = process.env.MKL_NUM_THREADS || '1';
process.env.NUMEXPR_NUM_THREADS = process.env.NUMEXPR_NUM_THREADS || '1';
process.env.TORCH_NUM_THREADS = process.env.TORCH_NUM_THREADS || '1';
process.env.TORCH_N_THREADS = process.env.TORCH_N_THREADS || '1';
process.env.MALLOC_ARENA_MAX = process.env.MALLOC_ARENA_MAX || '2';

function startJobHeartbeat(job: TrainingQueueJob) {
  let active = true;
  const beat = async () => {
    if (!active) return;
    try {
      await heartbeatTrainingJob(job.jobId, workerId);
      await recordWorkerHeartbeat(workerId, stopping && !activeJob && !activeSequenceJob ? 'stopping' : 'online', 'training_worker', gatherWorkerTelemetry());
    } catch (error) {
      console.error('[ML Worker] heartbeat failed:', error);
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), heartbeatMs);
  return () => {
    active = false;
    clearInterval(timer);
  };
}

function startSequenceJobHeartbeat(job: SequenceTrainingQueueJob) {
  let active = true;
  const beat = async () => {
    if (!active) return;
    try {
      await heartbeatSequenceTrainingJob(job.jobId, workerId, job.trainingRunId || undefined);
      await recordWorkerHeartbeat(workerId, stopping && !activeJob && !activeSequenceJob ? 'stopping' : 'online', 'training_worker', gatherWorkerTelemetry());
    } catch (error) {
      console.error('[ML Worker] sequence heartbeat failed:', error);
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), heartbeatMs);
  return () => {
    active = false;
    clearInterval(timer);
  };
}

async function processJob(job: TrainingQueueJob) {
  activeJob = job;
  stopActiveHeartbeat = startJobHeartbeat(job);
  console.log(`[ML Worker] claimed ${job.jobId} dataset=${job.datasetId} attempt=${job.attempts} pid=${process.pid}`);
  try {
    const modelTypes = job.modelTypes.length ? job.modelTypes as ModelType : undefined;
    const result = await trainDatasetModels({ datasetId: job.datasetId, modelTypes });
    const queueStatus = result.status === 'failed' ? 'failed' : 'completed';
    await finishTrainingJob(job.jobId, workerId, queueStatus, result.status === 'failed' ? 'All requested models failed.' : undefined, result.runId, {
      trainingRunId: result.runId,
      status: result.status,
      completedModels: result.completedModels,
      failedModels: result.failedModels,
    });
    console.log(`[ML Worker] completed ${job.jobId} run=${result.runId} status=${result.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await finishTrainingJob(job.jobId, workerId, 'failed', message);
    } catch (finishError) {
      console.error('[ML Worker] could not persist failed job state:', finishError);
    }
    console.error(`[ML Worker] failed ${job.jobId}: ${message}`);
  } finally {
    stopActiveHeartbeat?.();
    stopActiveHeartbeat = null;
    activeJob = null;
    try { mlRuntimeClient.resetAfterTraining(); } catch (error) {
      console.error('[ML Worker] runtime recycle failed:', error);
    }
  }
}

async function processSequenceJob(job: SequenceTrainingQueueJob) {
  activeSequenceJob = job;
  stopActiveSequenceHeartbeat = startSequenceJobHeartbeat(job);
  console.log(`[ML Worker] claimed sequence ${job.jobId} source=${job.sourceType}:${job.sourceDatasetId} horizon=${job.horizonKey || 'n/a'} attempt=${job.attempts} pid=${process.pid}`);
  try {
    if (job.sourceType !== 'unified') throw new Error('UNSUPPORTED_SEQUENCE_DATASET_SOURCE');
    if (!job.horizonKey) throw new Error('UNIFIED_SEQUENCE_REQUIRES_HORIZON');
    const result = await trainUnifiedSequenceModels({
      datasetId: job.sourceDatasetId,
      horizonKey: job.horizonKey,
      modelTypes: job.modelTypes,
      trainingRunId: job.trainingRunId || undefined,
    });
    const queueStatus = result.status === 'failed' ? 'failed' : 'completed';
    await finishSequenceTrainingJob(job.jobId, workerId, queueStatus, result.status === 'failed' ? 'All requested sequence models failed.' : undefined, result.runId);
    console.log(`[ML Worker] completed sequence ${job.jobId} run=${result.runId} status=${result.status} source=${result.sourceDatasetId} horizon=${result.horizonKey}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await finishSequenceTrainingJob(job.jobId, workerId, 'failed', message, job.trainingRunId || undefined);
    } catch (finishError) {
      console.error('[ML Worker] could not persist failed sequence job state:', finishError);
    }
    console.error(`[ML Worker] failed sequence ${job.jobId}: ${message}`);
  } finally {
    stopActiveSequenceHeartbeat?.();
    stopActiveSequenceHeartbeat = null;
    activeSequenceJob = null;
    try { mlRuntimeClient.resetAfterTraining(); } catch (error) {
      console.error('[ML Worker] sequence runtime recycle failed:', error);
    }
  }
}

async function processArtifactMaintenance(): Promise<boolean> {
  const job = await claimArtifactBackfill(workerId);
  if (!job) return false;
  console.log(`[ML Worker] claimed artifact maintenance ${job.jobId} attempt=${job.attempts}`);
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  try {
    heartbeatTimer = setInterval(() => {
      void heartbeatArtifactBackfill(job.jobId, workerId).catch((error) => console.error('[ML Worker] artifact maintenance heartbeat failed:', error));
    }, heartbeatMs);
    const summary = await executeArtifactBackfill();
    await finishArtifactBackfill(job.jobId, workerId, 'completed', summary);
    console.log(`[ML Worker] completed artifact maintenance ${job.jobId} summary=${JSON.stringify(summary)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await finishArtifactBackfill(job.jobId, workerId, 'failed', { error: message }, message); } catch (finishError) { console.error('[ML Worker] could not persist artifact maintenance failure:', finishError); }
    console.error(`[ML Worker] artifact maintenance failed ${job.jobId}: ${message}`);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
  return true;
}

async function processAvailableJob(): Promise<boolean> {
  const recovered = await recoverAbandonedTrainingJobs();
  if (recovered > 0) console.warn(`[ML Worker] recovered ${recovered} abandoned job(s) after worker lease expiry.`);
  const recoveredSequence = await recoverAbandonedSequenceTrainingJobs();
  if (recoveredSequence > 0) console.warn(`[ML Worker] recovered ${recoveredSequence} abandoned sequence job(s) after worker lease expiry.`);
  await flushStaleWorkerHeartbeats().catch(() => {});

  const sequenceJob = await claimNextSequenceTrainingJob(workerId);
  if (sequenceJob) {
    await processSequenceJob(sequenceJob);
    return true;
  }

  const job = await claimNextTrainingJob(workerId);
  if (job) {
    await processJob(job);
    return true;
  }
  return processArtifactMaintenance();
}

async function main() {
  console.log(`[ML Worker] started id=${workerId} reconciliation=${reconciliationMs}ms heartbeat=${heartbeatMs}ms`);
  try {
    await flushStaleWorkerHeartbeats().catch(() => {});
    await ensureBackgroundJobWakeupTriggers();
    stopWakeupListener = await startBackgroundJobWakeupListener('ml_training_jobs', wakeWorker);
    const stopArtifactWakeupListener = await startBackgroundJobWakeupListener('artifact_maintenance_jobs', wakeWorker);
    const stopSequenceWakeupListener = await startBackgroundJobWakeupListener('ml_sequence_training_jobs', wakeWorker);
    const originalStopWakeupListener = stopWakeupListener;
    stopWakeupListener = async () => {
      try { await originalStopWakeupListener?.(); } finally {
        await stopArtifactWakeupListener();
        await stopSequenceWakeupListener();
      }
    };
  } catch (error) {
    console.error('[ML Worker] startup wakeup initialization failed; reconciliation remains active:', error);
  }
  try { await recordWorkerHeartbeat(workerId, 'online', 'training_worker', gatherWorkerTelemetry()); } catch (err) { console.warn('[ML Worker] initial heartbeat deferred:', (err as Error).message); }
  workerStatusTimer = setInterval(() => {
    void recordWorkerHeartbeat(workerId, stopping ? 'stopping' : 'online', 'training_worker', gatherWorkerTelemetry()).catch((error) => {
      console.error('[ML Worker] worker status heartbeat failed:', error);
    });
  }, workerStatusHeartbeatMs);

  while (!stopping) {
    try {
      const progressed = await processAvailableJob();
      if (!progressed && !stopping) await waitForWakeup(reconciliationMs);
    } catch (error) {
      console.error('[ML Worker] loop error:', error);
      await new Promise((resolve) => setTimeout(resolve, Math.min(30000, reconciliationMs)));
    }
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  wakeWorker();
  if (workerStatusTimer) clearInterval(workerStatusTimer);
  workerStatusTimer = null;
  stopActiveHeartbeat?.();
  stopActiveHeartbeat = null;
  stopActiveSequenceHeartbeat?.();
  stopActiveSequenceHeartbeat = null;
  if (stopWakeupListener) {
    try { await stopWakeupListener(); } catch (error) { console.error('[ML Worker] listener shutdown failed:', error); }
  }
  try { await recordWorkerHeartbeat(workerId, (activeJob || activeSequenceJob) ? 'online' : 'stopping'); } catch { /* best effort */ }
  console.warn(`[ML Worker] received ${signal}; activeJob=${activeJob?.jobId || activeSequenceJob?.jobId || 'none'}.`);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('uncaughtException', (error) => console.error('[ML Worker] uncaught exception:', error));
process.on('unhandledRejection', (reason) => console.error('[ML Worker] unhandled rejection:', reason));
void main().catch(async (error) => {
  console.error('[ML Worker] fatal:', error);
  try { await recordWorkerHeartbeat(workerId, 'stopping'); } catch { /* best effort */ }
  process.exitCode = 1;
});
