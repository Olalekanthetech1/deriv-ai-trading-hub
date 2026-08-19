import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { extractTickFeatures, featureObjToArray } from './ml-feature-extractor';
import {
  deriveFeatureSchemaVersion,
  deriveNormalizationVersion,
  getCanonicalWindowTicks,
  getMlPipelineConfig,
  getRequiredSplitGapTicks,
} from './ml-pipeline-config';
import { getDbConnectionString, initDbSchema } from './db';
import { DerivDurationUnit, durationToSeconds, expandTrainingDurations } from './deriv-duration-registry';
import { getCachedOrDiscoverDuration } from './deriv-duration-cache';
import {
  DEFAULT_UNIFIED_HORIZONS,
  buildUnifiedHorizonKey,
  createUnifiedHorizon,
  type UnifiedHorizon,
  type UnifiedMultiHorizonDatasetSummary,
} from './ml-unified-horizon-contract';
import { ensureUnifiedHorizonSchema } from './ml-unified-horizon-schema';

type Sql = any;
type RawTick = { id: number; price: number; tick_epoch: number; tick_time: string; source_tick_id: string | null };

export type UnifiedDatasetBuildRequest = {
  symbol: string;
  name?: string;
  horizons?: Array<{ value: number; unit: DerivDurationUnit }>;
  maxSamples?: number;
};

function sqlClient(): Sql | null {
  const url = getDbConnectionString();
  return url ? neon(url) : null;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function deadZone(ticks: RawTick[]): number {
  const moves: number[] = [];
  for (let i = 1; i < ticks.length; i += 1) {
    const d = Math.abs(ticks[i].price - ticks[i - 1].price);
    if (Number.isFinite(d) && d > 0) moves.push(d);
  }
  return moves.length ? Math.max(median(moves) * 0.25, 1e-12) : 0;
}

function firstTickAtOrAfter(ticks: RawTick[], epoch: number, start: number): number {
  let lo = Math.max(0, start);
  let hi = ticks.length - 1;
  let answer = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ticks[mid].tick_epoch >= epoch) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return answer;
}

function normalizeTicks(rows: any[]): { ticks: RawTick[]; totalTicks: number; invalidTicks: number; duplicateTicks: number } {
  const seen = new Set<string>();
  const ticks: RawTick[] = [];
  let invalidTicks = 0;
  let duplicateTicks = 0;

  for (const row of rows) {
    const tick = {
      id: Number(row.id),
      price: Number(row.price),
      tick_epoch: Number(row.tick_epoch),
      tick_time: new Date(row.tick_time).toISOString(),
      source_tick_id: row.source_tick_id == null ? null : String(row.source_tick_id),
    };
    const valid =
      Number.isSafeInteger(tick.id) &&
      tick.id > 0 &&
      Number.isFinite(tick.price) &&
      tick.price > 0 &&
      Number.isSafeInteger(tick.tick_epoch) &&
      tick.tick_epoch > 0;
    if (!valid) {
      invalidTicks += 1;
      continue;
    }
    const key = tick.source_tick_id?.trim() || `${tick.tick_epoch}:${tick.price.toFixed(12)}`;
    if (seen.has(key)) {
      duplicateTicks += 1;
      continue;
    }
    seen.add(key);
    ticks.push(tick);
  }
  return { ticks, totalTicks: rows.length, invalidTicks, duplicateTicks };
}

function computeNormStats(vectors: number[][], epsilon: number) {
  if (!vectors.length) throw new Error('Cannot fit normalization without training samples.');
  const n = vectors[0].length;
  const means = new Array(n).fill(0);
  const stds = new Array(n).fill(0);
  for (const v of vectors) v.forEach((x, i) => { means[i] += x; });
  for (let i = 0; i < n; i += 1) means[i] /= vectors.length;
  for (const v of vectors) v.forEach((x, i) => { stds[i] += (x - means[i]) ** 2; });
  for (let i = 0; i < n; i += 1) {
    stds[i] = Math.sqrt(stds[i] / vectors.length);
    if (!Number.isFinite(stds[i]) || stds[i] < epsilon) stds[i] = 1;
  }
  return {
    means,
    stds,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify({ means, stds })).digest('hex').slice(0, 16),
  };
}

function applyNorm(v: number[], means: number[], stds: number[]): number[] {
  return v.map((x, i) => (x - means[i]) / stds[i]);
}

/**
 * Builds a single unified multi-horizon training dataset from raw Deriv tick data.
 * Computes pure tick microstructure features and future directional labels across
 * all specified horizons (both tick-based and time-based) in a single pass.
 */
export async function buildUnifiedMultiHorizonDataset(
  request: UnifiedDatasetBuildRequest,
): Promise<UnifiedMultiHorizonDatasetSummary> {
  const symbol = String(request.symbol ?? '').trim().toUpperCase();
  if (!symbol) throw new Error('Symbol is required for Unified Multi-Horizon Dataset.');

  const sql = sqlClient();
  if (!sql || !(await initDbSchema())) {
    throw new Error('Database is unavailable.');
  }
  await ensureUnifiedHorizonSchema(sql);

  // Broker capability revalidation: Ensure requested horizons match Deriv live discovered capabilities
  let validatedHorizons = request.horizons?.length ? request.horizons : DEFAULT_UNIFIED_HORIZONS;
  try {
    const durationDiscovery = await getCachedOrDiscoverDuration(symbol);
    if (durationDiscovery?.discovery?.ranges?.length) {
      const brokerHorizons = expandTrainingDurations(durationDiscovery.discovery.ranges);
      const brokerKeys = new Set(brokerHorizons.map((h) => `${h.value}:${h.unit}`));
      const matched = validatedHorizons.filter((h) => brokerKeys.has(`${h.value}:${h.unit}`));
      if (matched.length > 0) {
        validatedHorizons = matched;
      } else if (request.horizons?.length) {
        throw new Error(
          `UNSUPPORTED_BROKER_HORIZONS: Selected prediction horizons are not supported by Deriv for ${symbol}. Supported units: ${[...new Set(brokerHorizons.map((h) => h.unit))].join(', ')}.`
        );
      }
    }
  } catch (discoveryErr: any) {
    if (discoveryErr?.message?.startsWith('UNSUPPORTED_BROKER_HORIZONS')) {
      throw discoveryErr;
    }
    // Non-fatal if duration discovery cache is refreshing, fall through to requested horizons
  }

  const horizonInputs = validatedHorizons;
  const pipelineConfig = getMlPipelineConfig();
  const windowTicks = getCanonicalWindowTicks(pipelineConfig);

  // Determine maximum tick buffer needed
  const maxTimeSeconds = Math.max(
    ...horizonInputs.map((h) => (h.unit === 't' ? 0 : Number(durationToSeconds(h.value, h.unit)))),
  );
  const maxTickHorizon = Math.max(
    ...horizonInputs.map((h) => (h.unit === 't' ? h.value : 0)),
  );
  const minRequiredTicks = Math.max(50000, Math.ceil(maxTimeSeconds * 2) + maxTickHorizon + windowTicks + 5000);
  const maxTicks = Math.min(300000, Math.max(minRequiredTicks, 60000));

  // Load ticks from database
  const rows = await sql`
    SELECT id, price, tick_epoch, tick_time, source_tick_id
    FROM market_ticks
    WHERE symbol = ${symbol} AND source = 'deriv'
    ORDER BY tick_epoch DESC, id DESC
    LIMIT ${maxTicks}
  `;
  const chronological = Array.isArray(rows) ? [...rows].reverse() : [];
  const { ticks, totalTicks } = normalizeTicks(chronological);

  if (ticks.length <= windowTicks + 10) {
    throw new Error(
      `Insufficient real Deriv ticks for ${symbol}. Found ${ticks.length} valid ticks, require at least ${windowTicks + 50}.`,
    );
  }

  const assetRows = await sql`
    SELECT display_name, asset_class, market_type
    FROM market_assets
    WHERE symbol = ${symbol}
    LIMIT 1
  `;
  const assetRow = (assetRows as any[])[0] ?? null;
  const textCategory = `${assetRow?.asset_class ?? ''} ${assetRow?.market_type ?? ''}`.toLowerCase();
  const assetCategoryNum = textCategory.includes('forex') ? 1 : textCategory.includes('metal') || textCategory.includes('commodity') ? 2 : 0;
  const displayName = assetRow?.display_name ? String(assetRow.display_name) : symbol;

  const labelDeadZone = deadZone(ticks.slice(0, Math.min(ticks.length, windowTicks + 512)));
  const firstAnchor = windowTicks - 1;

  // Resolve effective horizons
  const resolvedHorizons: UnifiedHorizon[] = horizonInputs.map((h) => {
    return createUnifiedHorizon(h.value, h.unit);
  });

  // Calculate candidate anchors where all horizons can be evaluated
  type CandidateSample = {
    anchorIndex: number;
    anchorEpoch: number;
    anchorTime: string;
    entryPrice: number;
    labels: Record<string, 'RISE' | 'FALL' | 'FLAT'>;
    effectiveTicksMap: Record<string, number>;
  };

  const candidateSamples: CandidateSample[] = [];

  for (let anchorIdx = firstAnchor; anchorIdx < ticks.length - 1; anchorIdx += 1) {
    const entry = ticks[anchorIdx];
    const labelsMap: Record<string, 'RISE' | 'FALL' | 'FLAT'> = {};
    const effectiveTicksMap: Record<string, number> = {};
    let allHorizonsValid = true;

    for (const h of resolvedHorizons) {
      let outcomeIdx = -1;
      if (h.type === 'tick') {
        outcomeIdx = anchorIdx + h.value;
      } else {
        const targetEpoch = entry.tick_epoch + (h.seconds ?? 0);
        outcomeIdx = firstTickAtOrAfter(ticks, targetEpoch, anchorIdx + 1);
      }

      if (outcomeIdx < 0 || outcomeIdx >= ticks.length) {
        allHorizonsValid = false;
        break;
      }

      const outcome = ticks[outcomeIdx];
      const delta = outcome.price - entry.price;
      effectiveTicksMap[h.key] = outcomeIdx - anchorIdx;

      if (Math.abs(delta) <= labelDeadZone) {
        labelsMap[h.key] = 'FLAT';
      } else {
        labelsMap[h.key] = delta > 0 ? 'RISE' : 'FALL';
      }
    }

    if (allHorizonsValid) {
      candidateSamples.push({
        anchorIndex: anchorIdx,
        anchorEpoch: entry.tick_epoch,
        anchorTime: entry.tick_time,
        entryPrice: entry.price,
        labels: labelsMap,
        effectiveTicksMap,
      });
    }
  }

  if (candidateSamples.length < 50) {
    throw new Error(`Insufficient multi-horizon candidate samples for ${symbol}. Found ${candidateSamples.length}.`);
  }

  // Update effective horizon ticks in metadata
  for (const h of resolvedHorizons) {
    const avgTicks = Math.round(
      candidateSamples.reduce((acc, c) => acc + (c.effectiveTicksMap[h.key] || 0), 0) / candidateSamples.length,
    );
    h.effectiveHorizonTicks = avgTicks;
  }

  const maxEffectiveHorizonTicks = Math.max(...resolvedHorizons.map((h) => h.effectiveHorizonTicks || 1));
  const splitGapTicks = getRequiredSplitGapTicks(maxEffectiveHorizonTicks, pipelineConfig);

  const trainRatio = pipelineConfig.splitRatios.train;
  const valRatio = pipelineConfig.splitRatios.validation;
  const trainEnd = Math.floor(candidateSamples.length * trainRatio);
  const validationEnd = Math.floor(candidateSamples.length * (trainRatio + valRatio));

  const maxDesiredSamples = request.maxSamples ?? 25000;
  const sampleStride = Math.max(1, Math.ceil(candidateSamples.length / maxDesiredSamples));

  type BuiltSample = {
    sampleIndex: number;
    split: 'train' | 'validation' | 'test';
    anchorEpoch: number;
    anchorTime: string;
    entryPrice: number;
    featureVector: number[];
    rawVector: number[];
    horizonLabels: Record<string, 'RISE' | 'FALL' | 'FLAT'>;
    sourceWindowFromEpoch: number;
    sourceWindowToEpoch: number;
  };

  const preSamples: BuiltSample[] = [];

  for (let i = 0; i < candidateSamples.length; i += 1) {
    const isTrainGap = i >= trainEnd - splitGapTicks && i < trainEnd + splitGapTicks;
    const isValGap = i >= validationEnd - splitGapTicks && i < validationEnd + splitGapTicks;
    if (isTrainGap || isValGap) continue;
    if (i % sampleStride !== 0) continue;

    const cand = candidateSamples[i];
    const window = ticks.slice(cand.anchorIndex - windowTicks + 1, cand.anchorIndex + 1);
    if (window.length !== windowTicks) continue;

    const split: 'train' | 'validation' | 'test' =
      i < trainEnd - splitGapTicks ? 'train' : i < validationEnd - splitGapTicks ? 'validation' : 'test';

    const features = extractTickFeatures(
      window.map((t) => ({ price: t.price, timestamp: t.tick_epoch * 1000 })),
      {
        symbol,
        assetCategoryNum,
        contractDurationSecs: 60, // base canonical scale
        pipelineConfig,
      },
    );
    const rawVector = featureObjToArray(features, pipelineConfig.featureOrder);

    preSamples.push({
      sampleIndex: preSamples.length,
      split,
      anchorEpoch: cand.anchorEpoch,
      anchorTime: cand.anchorTime,
      entryPrice: cand.entryPrice,
      featureVector: rawVector,
      rawVector,
      horizonLabels: cand.labels,
      sourceWindowFromEpoch: window[0].tick_epoch,
      sourceWindowToEpoch: cand.anchorEpoch,
    });
  }

  if (preSamples.length < 50) {
    throw new Error(`Constructed fewer than 50 valid multi-horizon samples for ${symbol}.`);
  }

  // Normalize feature vectors based on train split stats
  const trainRawVectors = preSamples.filter((s) => s.split === 'train').map((s) => s.rawVector);
  const normStats = computeNormStats(trainRawVectors, pipelineConfig.normalizationEpsilon);
  const normalizationVersion = deriveNormalizationVersion(normStats.fingerprint, pipelineConfig);

  const samples = preSamples.map((s) => ({
    ...s,
    featureVector: applyNorm(s.rawVector, normStats.means, normStats.stds),
  }));

  const trainCount = samples.filter((s) => s.split === 'train').length;
  const validationCount = samples.filter((s) => s.split === 'validation').length;
  const testCount = samples.filter((s) => s.split === 'test').length;

  const leakageCheckPassed = samples.every(
    (s) => s.sourceWindowToEpoch === s.anchorEpoch && s.sourceWindowFromEpoch < s.sourceWindowToEpoch,
  );

  const featureSchemaVersion = deriveFeatureSchemaVersion(pipelineConfig.featureOrder, pipelineConfig.pipelineVersion);
  const datasetId = crypto.randomUUID();
  const datasetName =
    request.name ||
    `Unified Multi-Horizon Dataset ${displayName} (${resolvedHorizons.length} Horizons: ${resolvedHorizons.map((h) => h.key).join(', ')})`;

  const sourceFrom = ticks[0].tick_time;
  const sourceTo = ticks[ticks.length - 1].tick_time;

  const checksumHasher = crypto.createHash('sha256');
  for (const s of samples) {
    checksumHasher.update(`${s.sampleIndex}:${s.anchorEpoch}:${s.entryPrice}:${JSON.stringify(s.horizonLabels)}`);
  }
  const checksum = checksumHasher.digest('hex');

  const metadata = {
    source: 'deriv',
    assetDisplayName: displayName,
    horizons: resolvedHorizons,
    windowTicks,
    featureCount: pipelineConfig.featureOrder.length,
    featureOrder: pipelineConfig.featureOrder,
    normalization: {
      method: pipelineConfig.normalizationMethod,
      version: normalizationVersion,
      statsFingerprint: normStats.fingerprint,
    },
    splitGapTicks,
    sampling: { stride: sampleStride, sourceTicks: ticks.length, candidateCount: candidateSamples.length },
    quality: {
      totalTicks,
      validTicks: ticks.length,
      sampleCount: samples.length,
      trainCount,
      validationCount,
      testCount,
      leakageCheckPassed,
    },
  };

  // Insert dataset row
  await sql`
    INSERT INTO ml_unified_horizon_datasets (
      id, name, symbol, horizons, feature_schema_version, pipeline_version,
      window_ticks, sample_count, train_count, validation_count, test_count,
      source_from, source_to, status, checksum, leakage_check_passed, metadata
    ) VALUES (
      ${datasetId}::uuid, ${datasetName}::varchar, ${symbol}::varchar,
      ${JSON.stringify(resolvedHorizons)}::jsonb, ${featureSchemaVersion}::varchar,
      ${pipelineConfig.pipelineVersion}::varchar, ${windowTicks}::integer,
      ${samples.length}::integer, ${trainCount}::integer, ${validationCount}::integer, ${testCount}::integer,
      ${sourceFrom}::timestamptz, ${sourceTo}::timestamptz, 'completed'::varchar,
      ${checksum}::varchar, ${leakageCheckPassed}::boolean, ${JSON.stringify(metadata)}::jsonb
    )
  `;

  // Batch insert sample rows
  for (let offset = 0; offset < samples.length; offset += 250) {
    const batch = samples.slice(offset, offset + 250);
    await sql`
      INSERT INTO ml_unified_horizon_samples (
        dataset_id, sample_index, split, anchor_tick_epoch, anchor_tick_time,
        entry_price, feature_vector, horizon_labels, source_window_from_epoch, source_window_to_epoch
      ) SELECT * FROM UNNEST(
        ${batch.map(() => datasetId)}::uuid[],
        ${batch.map((s) => s.sampleIndex)}::integer[],
        ${batch.map((s) => s.split)}::varchar[],
        ${batch.map((s) => s.anchorEpoch)}::bigint[],
        ${batch.map((s) => s.anchorTime)}::timestamptz[],
        ${batch.map((s) => s.entryPrice)}::numeric[],
        ${batch.map((s) => JSON.stringify(s.featureVector))}::jsonb[],
        ${batch.map((s) => JSON.stringify(s.horizonLabels))}::jsonb[],
        ${batch.map((s) => s.sourceWindowFromEpoch)}::bigint[],
        ${batch.map((s) => s.sourceWindowToEpoch)}::bigint[]
      ) ON CONFLICT (dataset_id, sample_index) DO NOTHING
    `;
  }

  return {
    datasetId,
    name: datasetName,
    symbol,
    horizons: resolvedHorizons,
    sampleCount: samples.length,
    trainCount,
    validationCount,
    testCount,
    featureCount: pipelineConfig.featureOrder.length,
    featureOrder: pipelineConfig.featureOrder,
    featureSchemaVersion,
    sourceFrom,
    sourceTo,
    checksum,
    leakageCheckPassed,
    status: 'completed',
    createdAt: new Date().toISOString(),
  };
}

export async function listUnifiedMultiHorizonDatasets(symbol?: string): Promise<UnifiedMultiHorizonDatasetSummary[]> {
  const sql = sqlClient();
  if (!sql || !(await initDbSchema())) return [];
  await ensureUnifiedHorizonSchema(sql);

  const rows = symbol
    ? await sql`
        SELECT id, name, symbol, horizons, feature_schema_version, sample_count,
               train_count, validation_count, test_count, source_from, source_to,
               checksum, leakage_check_passed, status, created_at, metadata
        FROM ml_unified_horizon_datasets
        WHERE symbol = ${symbol}
        ORDER BY created_at DESC
        LIMIT 50
      `
    : await sql`
        SELECT id, name, symbol, horizons, feature_schema_version, sample_count,
               train_count, validation_count, test_count, source_from, source_to,
               checksum, leakage_check_passed, status, created_at, metadata
        FROM ml_unified_horizon_datasets
        ORDER BY created_at DESC
        LIMIT 50
      `;

  const pipelineConfig = getMlPipelineConfig();
  return rows.map((r: any) => ({
    datasetId: String(r.id),
    name: String(r.name),
    symbol: String(r.symbol),
    horizons: Array.isArray(r.horizons) ? r.horizons : [],
    sampleCount: Number(r.sample_count),
    trainCount: Number(r.train_count),
    validationCount: Number(r.validation_count),
    testCount: Number(r.test_count),
    featureCount: pipelineConfig.featureOrder.length,
    featureOrder: pipelineConfig.featureOrder,
    featureSchemaVersion: String(r.feature_schema_version),
    sourceFrom: new Date(r.source_from).toISOString(),
    sourceTo: new Date(r.source_to).toISOString(),
    checksum: String(r.checksum),
    leakageCheckPassed: Boolean(r.leakage_check_passed),
    status: String(r.status) as any,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function deleteUnifiedMultiHorizonDataset(datasetId: string): Promise<boolean> {
  const sql = sqlClient();
  if (!sql || !(await initDbSchema())) return false;
  await ensureUnifiedHorizonSchema(sql);

  await sql`DELETE FROM ml_unified_horizon_samples WHERE dataset_id = ${datasetId}::uuid`;
  await sql`DELETE FROM ml_unified_horizon_training_runs WHERE dataset_id = ${datasetId}::uuid`;
  await sql`DELETE FROM ml_unified_horizon_datasets WHERE id = ${datasetId}::uuid`;
  return true;
}
