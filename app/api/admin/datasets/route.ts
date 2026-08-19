import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../auth/route';
import { buildDurationTrainingDataset, listDurationTrainingDatasets } from '@/lib/training-dataset-builder-duration-v2';
import { expandTrainingDurations, type DerivDurationRange, type DerivDurationUnit } from '@/lib/deriv-duration-registry';
import { getCachedOrDiscoverDuration } from '@/lib/deriv-duration-cache';
import { initializeMlPipelineConfig } from '@/lib/ml-pipeline-config';
import { archiveAutoDatasetJob, cancelAllRunningAutoDatasetJobs, claimNextAutoDatasetJobItem, completeAutoDatasetJobItem, failAutoDatasetJobItem, getAutoDatasetJob, getAutoDatasetJobItemStatus, getLatestAutoDatasetJob, refreshAutoDatasetJobStatus, discardAutoDatasetBuild, skipAutoDatasetJobItem } from '@/lib/auto-dataset-job-store';
import { createAutoDatasetJobAtomic } from '@/lib/auto-dataset-job-store-atomic';
import { formatReadableDatasetName } from '@/lib/ml-display-formatters';

function isAuthenticated(req: NextRequest): boolean {
  const secret = process.env.ADMIN_SECRET_KEY?.trim();
  if (!secret) return true;
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}
function noStore() { return { 'Cache-Control': 'no-store, max-age=0' }; }
function validUnit(value: unknown): value is DerivDurationUnit { return value === 't' || value === 's' || value === 'm' || value === 'h' || value === 'd'; }
function matchingRanges(discovery: Awaited<ReturnType<typeof getCachedOrDiscoverDuration>>['discovery'], value: number, unit: DerivDurationUnit) {
  return discovery.ranges.filter((range) => {
    if (range.unit !== unit || value < range.min || value > range.max) return false;
    const step = Number.isSafeInteger(range.step) && range.step > 0 ? range.step : 1;
    return (value - range.min) % step === 0;
  });
}
function expandTrainingHorizonLadder(ranges: DerivDurationRange[]): Array<{ value: number; unit: DerivDurationUnit; rangeId: string }> {
  return expandTrainingDurations(ranges, 10000);
}
function finiteNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Canonicalize persisted dataset counts at the API boundary.
 * Older/partially migrated rows can contain a null/NaN sample_count while
 * train/validation/test counts are still authoritative. Training clients must
 * never receive NaN or an incompatible field shape.
 */
function normalizeDatasetTrainingCounts<T extends Record<string, any>>(dataset: T): T {
  const trainCount = finiteNonNegativeInteger(dataset?.train_count);
  const validationCount = finiteNonNegativeInteger(dataset?.validation_count);
  const testCount = finiteNonNegativeInteger(dataset?.test_count);
  const persistedSampleCount = Number(dataset?.sample_count);
  const sampleCount = Number.isSafeInteger(persistedSampleCount) && persistedSampleCount >= 0
    ? persistedSampleCount
    : trainCount + validationCount + testCount;

  return {
    ...dataset,
    sample_count: sampleCount,
    train_samples: trainCount,
    validation_samples: validationCount,
    test_samples: testCount,
  };
}

function trainingEligibleDatasets<T extends Record<string, any>>(datasets: T[]): T[] {
  const normalized = datasets.map(normalizeDatasetTrainingCounts);
  const eligible = normalized
    .filter((dataset) => dataset?.status === 'completed' && dataset?.leakage_check_passed === true && Number(dataset?.sample_count) > 0)
    .sort((a, b) => new Date(String(b?.created_at ?? 0)).getTime() - new Date(String(a?.created_at ?? 0)).getTime());
  const seen = new Set<string>();
  return eligible.filter((dataset) => {
    const symbol = String(dataset?.asset_symbol ?? '').trim().toUpperCase();
    const unit = String(dataset?.duration_unit ?? '').trim();
    const value = Number(dataset?.duration_value);
    const identity = `${symbol}|${unit}|${value}`;
    if (!symbol || !validUnit(unit) || !Number.isSafeInteger(value) || value <= 0 || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
function withReadableDatasetNames<T extends Record<string, any>>(datasets: T[]): T[] {
  return datasets.map((dataset) => {
    const normalized = normalizeDatasetTrainingCounts(dataset);
    return {
      ...normalized,
      name: formatReadableDatasetName({
        name: normalized.name,
        assetSymbol: normalized.asset_symbol,
        assetDisplayName: normalized.metadata?.assetDisplayName,
        durationValue: normalized.duration_value,
        durationUnit: normalized.duration_unit,
      }),
      raw_name: normalized.name,
    };
  });
}

/**
 * These are deterministic data-feasibility outcomes. They should be visible to
 * admins as skipped horizons, not as infrastructure/training failures.
 */
function isFeasibilitySkip(message: string): boolean {
  return /^(No persisted real ticks can satisfy|No non-flat directional samples could be constructed|Temporal split validation failed|Insufficient real Deriv ticks|The duration-aware feature window requires)/i.test(message.trim());
}

const activeLocalWorkers = new Set<string>();
async function runAutoDatasetWorker(jobId: string): Promise<void> {
  if (activeLocalWorkers.has(jobId)) return;
  activeLocalWorkers.add(jobId);
  try {
    const job = await getAutoDatasetJob(jobId);
    if (!job || job.status !== 'running') return;
    await initializeMlPipelineConfig();
    const item = await claimNextAutoDatasetJobItem(jobId);
    if (!item) {
      await refreshAutoDatasetJobStatus(jobId);
      return;
    }
    const memoryBefore = process.memoryUsage().rss;
    try {
      const result = await buildDurationTrainingDataset({ symbol: job.symbol, durationValue: item.value, durationUnit: item.unit, durationRangeId: item.rangeId ?? undefined });
      const itemStatus = await getAutoDatasetJobItemStatus(jobId, item.id);
      if (itemStatus === 'cancelled') {
        await discardAutoDatasetBuild(result.datasetId);
        await refreshAutoDatasetJobStatus(jobId);
        console.info('[AUTO dataset item discarded after cancellation]', JSON.stringify({ jobId, itemIndex: item.itemIndex, value: item.value, unit: item.unit, datasetId: result.datasetId }));
        return;
      }
      await completeAutoDatasetJobItem(jobId, item.id);
      const memoryAfter = process.memoryUsage().rss;
      console.info('[AUTO dataset item completed]', JSON.stringify({ jobId, itemIndex: item.itemIndex, value: item.value, unit: item.unit, memoryBeforeMb: Math.round(memoryBefore / 1048576), memoryAfterMb: Math.round(memoryAfter / 1048576) }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isFeasibilitySkip(message)) {
        await skipAutoDatasetJobItem(jobId, item.id, message);
        console.info('[AUTO dataset horizon skipped]', JSON.stringify({ jobId, itemIndex: item.itemIndex, value: item.value, unit: item.unit, reason: message }));
      } else {
        await failAutoDatasetJobItem(jobId, item.id, message);
        console.error('[AUTO dataset item failed]', JSON.stringify({ jobId, itemIndex: item.itemIndex, value: item.value, unit: item.unit, error: message }));
      }
    }
  } catch (error) {
    console.error('[AUTO dataset worker error]:', error);
  } finally {
    activeLocalWorkers.delete(jobId);
  }
}
function resumeAutoDatasetJob(jobId: string): void { void runAutoDatasetWorker(jobId); }

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    const symbol = req.nextUrl.searchParams.get('symbol')?.trim().toUpperCase() || undefined;
    const autoJobId = req.nextUrl.searchParams.get('autoJobId')?.trim();
    const latestAutoJob = req.nextUrl.searchParams.get('latestAutoJob') === '1';
    const eligibleForTraining = req.nextUrl.searchParams.get('eligibleForTraining') === '1';
    if (latestAutoJob) {
      const job = await getLatestAutoDatasetJob();
      const refreshed = job ? await refreshAutoDatasetJobStatus(job.id) : null;
      return NextResponse.json({ success: true, job: refreshed ?? job ?? null }, { headers: noStore() });
    }
    if (autoJobId) {
      const job = await getAutoDatasetJob(autoJobId);
      if (!job) return NextResponse.json({ success: false, error: 'AUTO dataset build job was not found. Start a new AUTO build.' }, { status: 404, headers: noStore() });
      const refreshed = await refreshAutoDatasetJobStatus(job.id);
      return NextResponse.json({ success: true, job: refreshed ?? job }, { headers: noStore() });
    }
    const datasets = await listDurationTrainingDatasets(symbol);
    const visibleDatasets = eligibleForTraining ? trainingEligibleDatasets(datasets as Array<Record<string, any>>) : datasets.map(normalizeDatasetTrainingCounts);
    const readableDatasets = withReadableDatasetNames(visibleDatasets as Array<Record<string, any>>);
    if (!symbol) return NextResponse.json({ success: true, datasets: readableDatasets, durationSource: 'deriv-dynamic' }, { headers: noStore() });
    const resolved = await getCachedOrDiscoverDuration(symbol);
    const brokerTrainingHorizons = expandTrainingDurations(resolved.discovery.ranges);
    return NextResponse.json({
      success: true,
      datasets: readableDatasets,
      durationSource: resolved.source,
      durationRefreshing: resolved.refreshing,
      durationCachedAt: resolved.cachedAt,
      durationDiscovery: resolved.discovery,
      trainingHorizons: brokerTrainingHorizons,
      brokerTrainingHorizons,
      autoTrainingHorizons: expandTrainingHorizonLadder(resolved.discovery.ranges),
    }, { headers: noStore() });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unable to load training dataset operations.' }, { status: 503, headers: noStore() });
  }
}

export async function DELETE(req: NextRequest) {
  if (!isAuthenticated(req)) return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    const stopAll = req.nextUrl.searchParams.get('stopAll') === '1';
    if (stopAll) {
      const cancelledCount = await cancelAllRunningAutoDatasetJobs();
      return NextResponse.json({ success: true, cancelledCount, message: `All ${cancelledCount} active background dataset jobs were immediately stopped and cancelled.` }, { headers: noStore() });
    }
    const jobId = req.nextUrl.searchParams.get('autoJobId')?.trim();
    if (!jobId) return NextResponse.json({ success: false, error: 'autoJobId or stopAll=1 is required.' }, { status: 400, headers: noStore() });
    const result = await archiveAutoDatasetJob(jobId);
    if (result.active) return NextResponse.json({ success: false, error: 'The AUTO build is still running. Stop/wait for it to finish before archiving its report.' }, { status: 409, headers: noStore() });
    if (!result.archived) return NextResponse.json({ success: false, error: 'AUTO build report was not found.' }, { status: 404, headers: noStore() });
    return NextResponse.json({ success: true, archived: true, message: 'AUTO report archived. Persisted training datasets, training runs and registered models were not modified.' }, { headers: noStore() });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unable to process dataset operation.' }, { status: 500, headers: noStore() });
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthenticated(req)) return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action === 'stop_all') {
      const cancelledCount = await cancelAllRunningAutoDatasetJobs();
      return NextResponse.json({ success: true, cancelledCount, message: `All ${cancelledCount} background dataset build jobs were stopped and cancelled.` }, { headers: noStore() });
    }
    const symbol = typeof body?.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
    if (!symbol) return NextResponse.json({ success: false, error: 'A Deriv symbol is required.' }, { status: 400, headers: noStore() });
    const resolved = await getCachedOrDiscoverDuration(symbol);
    await initializeMlPipelineConfig();
    if (body?.buildAllSupportedHorizons === true) {
      const requestedUnit = body?.durationUnit == null || body?.durationUnit === '' ? undefined : body.durationUnit;
      if (requestedUnit !== undefined && !validUnit(requestedUnit)) return NextResponse.json({ success: false, error: 'A valid Deriv duration unit is required when filtering AUTO horizons.' }, { status: 400, headers: noStore() });
      const sourceRanges = requestedUnit ? resolved.discovery.ranges.filter((range) => range.unit === requestedUnit) : resolved.discovery.ranges;
      const durations = expandTrainingHorizonLadder(sourceRanges);
      if (!durations.length) {
        const scope = requestedUnit ? ` for ${requestedUnit}` : '';
        return NextResponse.json({ success: false, error: `Deriv returned no supported training horizons${scope} for this asset.` }, { status: 422, headers: noStore() });
      }
      try {
        const job = await createAutoDatasetJobAtomic(symbol, durations);
        resumeAutoDatasetJob(job.id);
        const result = { status: job.status, jobId: job.id, requestedCount: job.requestedCount, completedCount: job.completedCount, skippedCount: job.skippedCount, failedCount: job.failedCount };
        const scope = requestedUnit ? ` for ${requestedUnit}` : '';
        return NextResponse.json({ success: true, accepted: true, jobId: job.id, requestedCount: job.requestedCount, completedCount: job.completedCount, skippedCount: job.skippedCount, failedCount: job.failedCount, dataSource: 'deriv-real-ticks', durationSource: resolved.source, durationRefreshing: resolved.refreshing, result, job, message: `AUTO dataset build started for all ${job.requestedCount} dynamically derived horizon samples${scope}.` }, { status: 202, headers: noStore() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.startsWith('AUTO_DATASET_SCOPE_CONFLICT:') ? 409 : 500;
        return NextResponse.json({ success: false, error: message }, { status, headers: noStore() });
      }
    }
    const legacyHorizon = body?.horizonTicks;
    const durationValue = legacyHorizon != null ? Number(legacyHorizon) : Number(body?.durationValue);
    const durationUnit = legacyHorizon != null ? 't' : body?.durationUnit;
    const windowTicks = body?.windowTicks == null ? undefined : Number(body.windowTicks);
    const datasetName = typeof body?.datasetName === 'string' ? body.datasetName.trim() : undefined;
    const requestedContractType = typeof body?.contractType === 'string' ? body.contractType.trim() : undefined;
    const durationRangeId = typeof body?.durationRangeId === 'string' ? body.durationRangeId.trim() : undefined;
    if (!Number.isSafeInteger(durationValue) || durationValue <= 0) return NextResponse.json({ success: false, error: 'A broker-discovered positive duration value is required.' }, { status: 400, headers: noStore() });
    if (!validUnit(durationUnit)) return NextResponse.json({ success: false, error: 'A valid Deriv duration unit (ticks, seconds, minutes, hours, or days) is required.' }, { status: 400, headers: noStore() });
    const supported = matchingRanges(resolved.discovery, durationValue, durationUnit);
    if (!supported.length) return NextResponse.json({ success: false, error: `Deriv does not currently advertise ${durationValue}${durationUnit} for ${symbol}.` }, { status: 422, headers: noStore() });
    const discoveredContractTypes = Array.from(new Set(supported.flatMap((range) => range.tradeTypes))).filter(Boolean).join(',').slice(0, 64) || undefined;
    const result = await buildDurationTrainingDataset({ symbol, durationValue, durationUnit, windowTicks, datasetName, contractType: requestedContractType || discoveredContractTypes, durationRangeId });
    return NextResponse.json({ success: true, dataSource: 'deriv-real-ticks', durationSource: resolved.source, durationRefreshing: resolved.refreshing, dataset: result }, { status: 201, headers: noStore() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Training dataset construction failed.';
    const status = /insufficient|required|duration|leakage|Temporal split|No non-flat/i.test(message) ? 422 : 500;
    return NextResponse.json({ success: false, error: message }, { status, headers: noStore() });
  }
}