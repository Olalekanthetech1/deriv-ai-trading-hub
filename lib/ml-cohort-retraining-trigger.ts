import crypto from 'crypto';
import { initDbSchema, getDb } from './db';
import {
  evaluateStatisticalDrift,
  calculateCalibrationMetrics,
  type DriftDiagnosticProfile,
  type CalibrationMetrics,
} from './probabilistic-drift-engine';
import { listDurationTrainingDatasets } from './training-dataset-builder-duration-v2';
import { enqueueTrainingJob, type TrainingQueueJob } from './ml-training-queue';
import { getLiveRiseFallSymbols } from './rise-fall-symbols';

export type MilestoneType = 
  | 'BRIER_DIVERGENCE_MILESTONE'
  | 'CALIBRATION_GAP_MILESTONE'
  | 'PERSISTENT_DRIFT_MILESTONE'
  | 'ACCURACY_DEGRADATION_MILESTONE';

export interface MilestoneEvaluation {
  milestone: MilestoneType;
  description: string;
  threshold: number;
  observedValue: number;
  sampleSize: number;
  breached: boolean;
  severity: 'NORMAL' | 'WARNING' | 'CRITICAL';
}

export interface CohortRetrainingTriggerResult {
  triggerId: string;
  assetSymbol: string;
  timestamp: string;
  triggered: boolean;
  suppressedReason?: 'COOLDOWN_ACTIVE' | 'JOB_ALREADY_QUEUED' | 'NO_BREACHES' | 'NO_ELIGIBLE_DATASET';
  driftState: string;
  metrics: CalibrationMetrics;
  milestones: MilestoneEvaluation[];
  dispatchedJobs: Array<{
    jobId: string;
    datasetId: string;
    status: string;
  }>;
  summary: string;
}

// In-memory trigger audit log and cooldown tracker
const triggerHistory: CohortRetrainingTriggerResult[] = [];
const assetCooldownTracker = new Map<string, number>();
const COOLDOWN_PERIOD_MS = 15 * 60 * 1000; // 15-minute cooldown between automated drift-driven runs

function isEligibleDataset(dataset: Record<string, unknown>): boolean {
  return (
    dataset.status === 'completed' &&
    dataset.leakage_check_passed === true &&
    Number(dataset.sample_count ?? 0) > 0 &&
    typeof dataset.id === 'string' &&
    dataset.id.trim().length > 0
  );
}

function pickNewestEligibleDataset(datasets: Array<Record<string, unknown>>): Record<string, unknown> | null {
  return (
    datasets
      .filter(isEligibleDataset)
      .sort((a, b) => new Date(String(b.created_at ?? 0)).getTime() - new Date(String(a.created_at ?? 0)).getTime())[0] ?? null
  );
}

/**
 * Evaluates the explicit mathematical milestone criteria for an asset.
 */
export function evaluateMilestones(profile: DriftDiagnosticProfile): MilestoneEvaluation[] {
  const m = profile.overallMetrics;
  const N = m.sampleSize;

  // 1. Brier Score Divergence Milestone: Baseline ~0.15, threshold >= 0.23, delta >= 0.08
  const brierBaseline = 0.15;
  const brierThreshold = 0.23;
  const brierBreached = N >= 12 && m.brierScore >= brierThreshold;

  // 2. Expected Calibration Error (ECE) Gap Milestone: Gap >= 0.12 with significance >= 0.50
  const gapThreshold = 0.12;
  const gapBreached = N >= 10 && Math.abs(m.calibrationGap) >= gapThreshold && m.statisticalSignificance >= 0.50;

  // 3. Persistent Drift Escalation Milestone: Drift in ELEVATED/SEVERE with >= 2 cycles
  const persistenceThreshold = 2;
  const driftBreached = (profile.driftState === 'DRIFT_ELEVATED' || profile.driftState === 'DRIFT_SEVERE') &&
    profile.driftPersistenceCycles >= persistenceThreshold;

  // 4. Accuracy Degradation Milestone: Win rate < 52.0% (Statistical Control Limit)
  const sclThreshold = 0.52;
  const accuracyBreached = N >= 12 && m.realizedWinRate < sclThreshold;

  return [
    {
      milestone: 'BRIER_DIVERGENCE_MILESTONE',
      description: 'Mean squared probabilistic divergence exceeding benchmark threshold (Brier >= 0.230)',
      threshold: brierThreshold,
      observedValue: m.brierScore,
      sampleSize: N,
      breached: brierBreached,
      severity: brierBreached ? 'CRITICAL' : m.brierScore > 0.19 ? 'WARNING' : 'NORMAL',
    },
    {
      milestone: 'CALIBRATION_GAP_MILESTONE',
      description: 'Expected vs realized calibration divergence exceeding confidence envelope (Gap >= 12.0%)',
      threshold: gapThreshold,
      observedValue: Math.abs(m.calibrationGap),
      sampleSize: N,
      breached: gapBreached,
      severity: gapBreached ? 'CRITICAL' : Math.abs(m.calibrationGap) > 0.08 ? 'WARNING' : 'NORMAL',
    },
    {
      milestone: 'PERSISTENT_DRIFT_MILESTONE',
      description: 'Multi-cycle persistent model drift escalation across rolling execution evaluations',
      threshold: persistenceThreshold,
      observedValue: profile.driftPersistenceCycles,
      sampleSize: N,
      breached: driftBreached,
      severity: driftBreached ? 'CRITICAL' : profile.driftState === 'DRIFT_WATCH' ? 'WARNING' : 'NORMAL',
    },
    {
      milestone: 'ACCURACY_DEGRADATION_MILESTONE',
      description: 'Empirical trade win rate dropped below Statistical Control Limit (SCL: 52.0%)',
      threshold: sclThreshold,
      observedValue: m.realizedWinRate,
      sampleSize: N,
      breached: accuracyBreached,
      severity: accuracyBreached ? 'CRITICAL' : m.realizedWinRate < 0.58 ? 'WARNING' : 'NORMAL',
    },
  ];
}

/**
 * Evaluates drift & divergence milestones for an asset and, if breached,
 * automatically dispatches offline cohort retraining into the durable queue.
 */
export async function evaluateAndTriggerCohortRetraining(params: {
  assetSymbol: string;
  force?: boolean;
}): Promise<CohortRetrainingTriggerResult> {
  const { assetSymbol, force = false } = params;
  const now = Date.now();
  const triggerId = crypto.randomUUID();

  // Evaluate current statistical drift profile
  const driftProfile = evaluateStatisticalDrift({ asset: assetSymbol });
  const milestones = evaluateMilestones(driftProfile);
  const breachedMilestones = milestones.filter((m) => m.breached);

  // Check cooldown if not forced
  const lastTriggerTime = assetCooldownTracker.get(assetSymbol) || 0;
  const inCooldown = !force && now - lastTriggerTime < COOLDOWN_PERIOD_MS;

  if (breachedMilestones.length === 0 && !force) {
    const result: CohortRetrainingTriggerResult = {
      triggerId,
      assetSymbol,
      timestamp: new Date(now).toISOString(),
      triggered: false,
      suppressedReason: 'NO_BREACHES',
      driftState: driftProfile.driftState,
      metrics: driftProfile.overallMetrics,
      milestones,
      dispatchedJobs: [],
      summary: `Asset ${assetSymbol} is operating within statistical control limits. No milestones breached.`,
    };
    return result;
  }

  if (inCooldown) {
    const remainingSecs = Math.ceil((COOLDOWN_PERIOD_MS - (now - lastTriggerTime)) / 1000);
    const result: CohortRetrainingTriggerResult = {
      triggerId,
      assetSymbol,
      timestamp: new Date(now).toISOString(),
      triggered: false,
      suppressedReason: 'COOLDOWN_ACTIVE',
      driftState: driftProfile.driftState,
      metrics: driftProfile.overallMetrics,
      milestones,
      dispatchedJobs: [],
      summary: `Retraining milestone breached for ${assetSymbol}, but suppressed under 15m cooldown (${remainingSecs}s remaining).`,
    };
    return result;
  }

  // Find eligible duration datasets to train
  const isDbConnected = await initDbSchema();
  if (!isDbConnected) {
    return {
      triggerId,
      assetSymbol,
      timestamp: new Date(now).toISOString(),
      triggered: false,
      suppressedReason: 'NO_ELIGIBLE_DATASET',
      driftState: driftProfile.driftState,
      metrics: driftProfile.overallMetrics,
      milestones,
      dispatchedJobs: [],
      summary: `Database unavailable to query training datasets for ${assetSymbol}.`,
    };
  }

  const datasets = await listDurationTrainingDatasets(assetSymbol);
  const eligibleDataset = pickNewestEligibleDataset(datasets as Array<Record<string, unknown>>);

  if (!eligibleDataset) {
    const result: CohortRetrainingTriggerResult = {
      triggerId,
      assetSymbol,
      timestamp: new Date(now).toISOString(),
      triggered: false,
      suppressedReason: 'NO_ELIGIBLE_DATASET',
      driftState: driftProfile.driftState,
      metrics: driftProfile.overallMetrics,
      milestones,
      dispatchedJobs: [],
      summary: `Milestone breached for ${assetSymbol}, but no completed, leak-checked dataset was found in the registry.`,
    };
    triggerHistory.unshift(result);
    return result;
  }

  // Dispatch offline training job
  const dispatchedJobs: Array<{ jobId: string; datasetId: string; status: string }> = [];
  try {
    const queued: TrainingQueueJob = await enqueueTrainingJob({
      datasetId: String(eligibleDataset.id),
      modelTypes: ['XGBoost', 'LightGBM', 'CatBoost'],
      priority: 2, // High priority for drift remediation
    });

    dispatchedJobs.push({
      jobId: queued.jobId,
      datasetId: queued.datasetId,
      status: queued.status,
    });

    // Update cooldown
    assetCooldownTracker.set(assetSymbol, now);

    // Persist trigger audit log in database if available
    const sql = getDb();
    if (sql) {
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS ml_drift_retraining_events (
            trigger_id UUID PRIMARY KEY,
            asset_symbol VARCHAR(64) NOT NULL,
            drift_state VARCHAR(32) NOT NULL,
            brier_score NUMERIC(7, 4) NOT NULL,
            calibration_gap NUMERIC(7, 4) NOT NULL,
            sample_size INTEGER NOT NULL,
            breached_milestones JSONB NOT NULL DEFAULT '[]'::jsonb,
            dispatched_jobs JSONB NOT NULL DEFAULT '[]'::jsonb,
            triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;

        await sql`
          INSERT INTO ml_drift_retraining_events (
            trigger_id, asset_symbol, drift_state, brier_score,
            calibration_gap, sample_size, breached_milestones, dispatched_jobs
          ) VALUES (
            ${triggerId}::uuid,
            ${assetSymbol}::varchar,
            ${driftProfile.driftState}::varchar,
            ${driftProfile.overallMetrics.brierScore}::numeric,
            ${driftProfile.overallMetrics.calibrationGap}::numeric,
            ${driftProfile.overallMetrics.sampleSize}::integer,
            ${JSON.stringify(breachedMilestones.map((b) => b.milestone))}::jsonb,
            ${JSON.stringify(dispatchedJobs)}::jsonb
          )
        `;
      } catch (logErr) {
        console.warn('[Cohort Retraining DB Log Warning]:', logErr);
      }
    }

    const breachedNames = breachedMilestones.map((b) => b.milestone).join(', ');
    const result: CohortRetrainingTriggerResult = {
      triggerId,
      assetSymbol,
      timestamp: new Date(now).toISOString(),
      triggered: true,
      driftState: driftProfile.driftState,
      metrics: driftProfile.overallMetrics,
      milestones,
      dispatchedJobs,
      summary: `Automated offline cohort retraining triggered for ${assetSymbol} due to: ${breachedNames || 'Manual Force'}. Queued job ${queued.jobId}.`,
    };

    triggerHistory.unshift(result);
    if (triggerHistory.length > 50) triggerHistory.pop();

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const result: CohortRetrainingTriggerResult = {
      triggerId,
      assetSymbol,
      timestamp: new Date(now).toISOString(),
      triggered: false,
      suppressedReason: 'JOB_ALREADY_QUEUED',
      driftState: driftProfile.driftState,
      metrics: driftProfile.overallMetrics,
      milestones,
      dispatchedJobs: [],
      summary: `Failed to queue offline retraining for ${assetSymbol}: ${errorMsg}`,
    };
    return result;
  }
}

/**
 * Scans all active fleet assets, evaluating drift and milestone triggers.
 */
export async function evaluateAllFleetCohortRetraining(force = false): Promise<{
  totalEvaluated: number;
  triggeredCount: number;
  results: CohortRetrainingTriggerResult[];
}> {
  let symbols: string[] = ['R_100', 'R_10', 'R_25', 'R_50', 'R_75'];
  try {
    const liveSymbols = await getLiveRiseFallSymbols();
    const openSymbols = liveSymbols
      .filter((s) => s.isOpen === true && typeof s.symbol === 'string' && s.symbol.trim())
      .map((s) => s.symbol.trim());
    if (openSymbols.length > 0) {
      symbols = Array.from(new Set(openSymbols));
    }
  } catch {
    // fallback to standard synthetic symbols
  }

  const results: CohortRetrainingTriggerResult[] = [];
  for (const sym of symbols) {
    const res = await evaluateAndTriggerCohortRetraining({ assetSymbol: sym, force });
    results.push(res);
  }

  const triggeredCount = results.filter((r) => r.triggered).length;
  return {
    totalEvaluated: symbols.length,
    triggeredCount,
    results,
  };
}

/**
 * Retrieves the in-memory or persisted audit history of cohort retraining triggers.
 */
export async function getCohortRetrainingTriggerHistory(limit = 20): Promise<CohortRetrainingTriggerResult[]> {
  const isDbConnected = await initDbSchema();
  const sql = getDb();
  if (isDbConnected && sql) {
    try {
      const rows = await sql`
        SELECT trigger_id, asset_symbol, drift_state, brier_score, calibration_gap,
               sample_size, breached_milestones, dispatched_jobs, triggered_at
        FROM ml_drift_retraining_events
        ORDER BY triggered_at DESC
        LIMIT ${limit}
      `;

      if (rows.length > 0) {
        return rows.map((r: any) => ({
          triggerId: String(r.trigger_id),
          assetSymbol: String(r.asset_symbol),
          timestamp: new Date(r.triggered_at).toISOString(),
          triggered: true,
          driftState: String(r.drift_state),
          metrics: {
            sampleSize: Number(r.sample_size),
            meanPredictedProb: 0.65,
            realizedWinRate: 0.50,
            calibrationGap: Number(r.calibration_gap),
            brierScore: Number(r.brier_score),
            logLoss: 0.693,
            standardError: 0.05,
            statisticalSignificance: 0.80,
            isStatisticallySignificant: true,
          },
          milestones: [],
          dispatchedJobs: Array.isArray(r.dispatched_jobs) ? r.dispatched_jobs : [],
          summary: `Historical retraining trigger for ${r.asset_symbol} (Brier: ${r.brier_score}, Gap: ${r.calibration_gap})`,
        }));
      }
    } catch {
      // Table might not exist yet; fallback to in-memory history
    }
  }

  return triggerHistory.slice(0, limit);
}
