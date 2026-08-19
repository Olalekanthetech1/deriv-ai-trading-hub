import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { extractTickFeatures, featureObjToArray } from './ml-feature-extractor';
import {
  buildDatasetFingerprint,
  deriveFeatureSchemaVersion,
  deriveLabelSchemaVersion,
  deriveNormalizationVersion,
  getCanonicalWindowTicks,
  getDefaultHorizonTicks,
  getMlPipelineConfig,
  getRequiredSplitGapTicks,
  type FeaturePipelineConfig,
} from './ml-pipeline-config';
import { getDbConnectionString, initDbSchema } from './db';

type Sql = any;

type RawTick = {
  id: number;
  price: number;
  tick_epoch: number;
  tick_time: string;
  source_tick_id: string | null;
};

type SanitizedTick = RawTick;

type DatasetSample = {
  sampleIndex: number;
  split: 'train' | 'validation' | 'test';
  anchorEpoch: number;
  anchorTime: string;
  outcomeEpoch: number;
  outcomeTime: string;
  entryPrice: number;
  outcomePrice: number;
  label: 'RISE' | 'FALL';
  featureVector: number[];
  sourceWindowFromEpoch: number;
  sourceWindowToEpoch: number;
};

export type DatasetQualityReport = {
  status: 'READY' | 'REVIEW';
  totalTicks: number;
  validTicks: number;
  invalidTicks: number;
  duplicateTicks: number;
  candidateSamples: number;
  generatedSamples: number;
  excludedMissingWindows: number;
  excludedAmbiguousTargets: number;
  excludedSplitGap: number;
  featureCount: number;
  trainCount: number;
  validationCount: number;
  testCount: number;
  splitGapTicks: number;
  leakageCheckPassed: boolean;
  temporalSplitValidated: boolean;
  normalizationVersion: string;
  featureSchemaVersion: string;
  labelSchemaVersion: string;
};

export type DatasetBuildRequest = {
  symbol: string;
  horizonTicks?: number;
  windowTicks?: number;
  datasetName?: string;
};

export type DatasetBuildResult = {
  datasetId: string;
  name: string;
  version: string;
  symbol: string;
  horizonTicks: number;
  windowTicks: number;
  sampleCount: number;
  trainCount: number;
  validationCount: number;
  testCount: number;
  sourceFrom: string;
  sourceTo: string;
  checksum: string;
  leakageCheckPassed: boolean;
  normalizationVersion: string;
  datasetFingerprint: string;
  qualityReport: DatasetQualityReport;
  status: 'completed';
};

function getSql(): Sql | null {
  const dbUrl = getDbConnectionString();
  return dbUrl ? neon(dbUrl) : null;
}

function normalizePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`Value must be a positive integer no greater than ${max}.`);
  }
  return parsed;
}

function compactIsoStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/-/g, '')
    .replace(/:/g, '')
    .replace(/\./g, '')
    .replace(/T/g, '')
    .replace(/Z/g, '')
    .slice(0, 14);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function inferDeadZone(ticks: SanitizedTick[]): number {
  const moves: number[] = [];
  for (let i = 1; i < ticks.length; i += 1) {
    const move = Math.abs(ticks[i].price - ticks[i - 1].price);
    if (Number.isFinite(move) && move > 0) moves.push(move);
  }
  if (!moves.length) return 0;
  return Math.max(median(moves) * 0.25, 1e-12);
}

function normalizeTickRows(rows: any[]): { ticks: SanitizedTick[]; invalidTicks: number; duplicateTicks: number } {
  const seen = new Set<string>();
  let invalidTicks = 0;
  let duplicateTicks = 0;
  const ticks: SanitizedTick[] = [];

  for (const row of rows) {
    const tick: SanitizedTick = {
      id: Number(row.id),
      price: Number(row.price),
      tick_epoch: Number(row.tick_epoch),
      tick_time: new Date(row.tick_time).toISOString(),
      source_tick_id: row.source_tick_id == null ? null : String(row.source_tick_id),
    };

    const isValid = Number.isSafeInteger(tick.id) && tick.id > 0 && Number.isFinite(tick.price) && tick.price > 0 && Number.isSafeInteger(tick.tick_epoch) && tick.tick_epoch > 0;
    if (!isValid) {
      invalidTicks += 1;
      continue;
    }

    const dedupeKey = tick.source_tick_id?.trim() || `${tick.tick_epoch}:${tick.price.toFixed(12)}`;
    if (seen.has(dedupeKey)) {
      duplicateTicks += 1;
      continue;
    }

    seen.add(dedupeKey);
    ticks.push(tick);
  }

  return { ticks, invalidTicks, duplicateTicks };
}

async function loadTicks(sql: Sql, symbol: string): Promise<{ ticks: SanitizedTick[]; invalidTicks: number; duplicateTicks: number; totalTicks: number }> {
  const rows = await sql`
    SELECT id, price, tick_epoch, tick_time, source_tick_id
    FROM market_ticks
    WHERE symbol = ${symbol}
      AND source = 'deriv'
    ORDER BY tick_epoch ASC, id ASC
  `;

  const rowArray = Array.isArray(rows) ? rows : [];
  const { ticks, invalidTicks, duplicateTicks } = normalizeTickRows(rowArray);
  return { ticks, invalidTicks, duplicateTicks, totalTicks: rowArray.length };
}

async function resolveAssetContext(sql: Sql, symbol: string) {
  const rows = await sql`
    SELECT display_name, asset_class, market_type
    FROM market_assets
    WHERE symbol = ${symbol}
    LIMIT 1
  `;

  const row = (rows as any[])[0] ?? null;
  return {
    displayName: row?.display_name ? String(row.display_name) : symbol,
    assetCategory: `${String(row?.asset_class ?? '')} ${String(row?.market_type ?? '')}`.toLowerCase().includes('forex')
      ? 1
      : `${String(row?.asset_class ?? '')} ${String(row?.market_type ?? '')}`.toLowerCase().includes('metal') || `${String(row?.asset_class ?? '')} ${String(row?.market_type ?? '')}`.toLowerCase().includes('commodity')
        ? 2
        : 0,
  };
}

function computeNormalizationStats(vectors: number[][], epsilon: number) {
  if (!vectors.length) throw new Error('Cannot fit normalization without training samples.');
  const featureCount = vectors[0].length;
  const means = new Array(featureCount).fill(0);
  const stds = new Array(featureCount).fill(0);

  for (const vector of vectors) {
    vector.forEach((value, index) => {
      means[index] += value;
    });
  }
  for (let i = 0; i < featureCount; i += 1) {
    means[i] /= vectors.length;
  }
  for (const vector of vectors) {
    vector.forEach((value, index) => {
      stds[index] += Math.pow(value - means[index], 2);
    });
  }
  for (let i = 0; i < featureCount; i += 1) {
    stds[i] = Math.sqrt(stds[i] / vectors.length);
    if (!Number.isFinite(stds[i]) || stds[i] < epsilon) stds[i] = 1;
  }

  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ means, stds })).digest('hex').slice(0, 16);
  return { means, stds, fingerprint };
}

function normalizeVector(vector: number[], means: number[], stds: number[]): number[] {
  return vector.map((value, index) => (value - means[index]) / stds[index]);
}

function updateChecksum(hash: crypto.Hash, sample: DatasetSample) {
  hash.update(JSON.stringify({
    i: sample.sampleIndex,
    s: sample.split,
    a: sample.anchorEpoch,
    o: sample.outcomeEpoch,
    p: sample.entryPrice,
    q: sample.outcomePrice,
    l: sample.label,
    f: sample.featureVector,
  }));
}

async function ensureDatasetSampleSchema(sql: Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS training_dataset_samples (
      id BIGSERIAL PRIMARY KEY,
      dataset_id UUID NOT NULL REFERENCES training_datasets(id) ON DELETE CASCADE,
      sample_index INTEGER NOT NULL,
      split VARCHAR(16) NOT NULL,
      anchor_tick_epoch BIGINT NOT NULL,
      anchor_tick_time TIMESTAMPTZ NOT NULL,
      outcome_tick_epoch BIGINT NOT NULL,
      outcome_tick_time TIMESTAMPTZ NOT NULL,
      entry_price NUMERIC(30, 12) NOT NULL,
      outcome_price NUMERIC(30, 12) NOT NULL,
      label VARCHAR(16) NOT NULL,
      feature_vector JSONB NOT NULL,
      source_window_from_epoch BIGINT NOT NULL,
      source_window_to_epoch BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT training_dataset_samples_unique UNIQUE (dataset_id, sample_index),
      CONSTRAINT training_dataset_samples_label_check CHECK (label IN ('RISE', 'FALL'))
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_training_dataset_samples_dataset_split
    ON training_dataset_samples (dataset_id, split, sample_index)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_training_dataset_samples_anchor
    ON training_dataset_samples (dataset_id, anchor_tick_epoch)
  `;
}

async function insertSamples(sql: Sql, datasetId: string, samples: DatasetSample[]) {
  const batchSize = 250;
  for (let offset = 0; offset < samples.length; offset += batchSize) {
    const batch = samples.slice(offset, offset + batchSize);
    const datasetIds = batch.map(() => datasetId);
    const indexes = batch.map((sample) => sample.sampleIndex);
    const splits = batch.map((sample) => sample.split);
    const anchorEpochs = batch.map((sample) => sample.anchorEpoch);
    const anchorTimes = batch.map((sample) => sample.anchorTime);
    const outcomeEpochs = batch.map((sample) => sample.outcomeEpoch);
    const outcomeTimes = batch.map((sample) => sample.outcomeTime);
    const entryPrices = batch.map((sample) => sample.entryPrice);
    const outcomePrices = batch.map((sample) => sample.outcomePrice);
    const labels = batch.map((sample) => sample.label);
    const featureVectors = batch.map((sample) => JSON.stringify(sample.featureVector));
    const windowFrom = batch.map((sample) => sample.sourceWindowFromEpoch);
    const windowTo = batch.map((sample) => sample.sourceWindowToEpoch);

    await sql`
      INSERT INTO training_dataset_samples (
        dataset_id, sample_index, split, anchor_tick_epoch, anchor_tick_time,
        outcome_tick_epoch, outcome_tick_time, entry_price, outcome_price, label,
        feature_vector, source_window_from_epoch, source_window_to_epoch
      )
      SELECT * FROM UNNEST(
        ${datasetIds}::uuid[],
        ${indexes}::integer[],
        ${splits}::text[],
        ${anchorEpochs}::bigint[],
        ${anchorTimes}::timestamptz[],
        ${outcomeEpochs}::bigint[],
        ${outcomeTimes}::timestamptz[],
        ${entryPrices}::numeric[],
        ${outcomePrices}::numeric[],
        ${labels}::text[],
        ${featureVectors}::jsonb[],
        ${windowFrom}::bigint[],
        ${windowTo}::bigint[]
      )
      ON CONFLICT (dataset_id, sample_index) DO NOTHING
    `;
  }
}

export async function buildTrainingDataset(request: DatasetBuildRequest): Promise<DatasetBuildResult> {
  const config = getMlPipelineConfig();
  const symbol = String(request.symbol ?? '').trim().toUpperCase();
  if (!symbol) throw new Error('A Deriv symbol is required.');

  const horizonTicks = normalizePositiveInteger(request.horizonTicks, getDefaultHorizonTicks(config), config.maxHorizonTicks);
  const windowTicks = normalizePositiveInteger(request.windowTicks, getCanonicalWindowTicks(config), getCanonicalWindowTicks(config));
  if (windowTicks !== getCanonicalWindowTicks(config)) {
    throw new Error(`The configured feature window requires ${getCanonicalWindowTicks(config)} real ticks.`);
  }

  const sql = getSql();
  if (!sql || !(await initDbSchema())) throw new Error('Database is unavailable or the Operations schema could not be initialized.');
  await ensureDatasetSampleSchema(sql);

  const { ticks, invalidTicks, duplicateTicks, totalTicks } = await loadTicks(sql, symbol);
  if (ticks.length < windowTicks + horizonTicks + 1) {
    throw new Error(`Insufficient real Deriv ticks for ${symbol}. Need at least ${windowTicks + horizonTicks + 1}; found ${ticks.length}.`);
  }

  const { displayName, assetCategory } = await resolveAssetContext(sql, symbol);
  const now = new Date();
  const datasetId = crypto.randomUUID();
  const featureSchemaVersion = deriveFeatureSchemaVersion(config.featureOrder, config.pipelineVersion);
  const labelDeadZone = inferDeadZone(ticks.slice(0, Math.min(ticks.length, windowTicks + horizonTicks + 100)));
  const labelSchemaVersion = deriveLabelSchemaVersion(labelDeadZone, horizonTicks, config);
  const splitGapTicks = getRequiredSplitGapTicks(horizonTicks, config);

  const firstUsableAnchor = windowTicks - 1;
  const lastUsableAnchor = ticks.length - horizonTicks - 1;
  const totalCandidates = lastUsableAnchor - firstUsableAnchor + 1;
  const rawTrainEnd = firstUsableAnchor + Math.floor(totalCandidates * config.splitRatios.train);
  const rawValidationEnd = firstUsableAnchor + Math.floor(totalCandidates * (config.splitRatios.train + config.splitRatios.validation));

  const preSamples: Array<DatasetSample & { rawFeatureVector: number[]; split: 'train' | 'validation' | 'test' }> = [];
  let excludedMissingWindows = 0;
  let excludedAmbiguousTargets = 0;
  let excludedSplitGap = 0;

  for (let anchorIndex = firstUsableAnchor; anchorIndex <= lastUsableAnchor; anchorIndex += 1) {
    const outcomeIndex = anchorIndex + horizonTicks;
    const entry = ticks[anchorIndex];
    const outcome = ticks[outcomeIndex];
    if (!entry || !outcome) {
      excludedMissingWindows += 1;
      continue;
    }

    const featureWindow = ticks.slice(anchorIndex - windowTicks + 1, anchorIndex + 1);
    if (featureWindow.length !== windowTicks) {
      excludedMissingWindows += 1;
      continue;
    }

    const delta = outcome.price - entry.price;
    if (Math.abs(delta) <= labelDeadZone) {
      excludedAmbiguousTargets += 1;
      continue;
    }

    const anchorInsideTrainGap = anchorIndex >= rawTrainEnd - splitGapTicks && anchorIndex < rawTrainEnd + splitGapTicks;
    const anchorInsideValidationGap = anchorIndex >= rawValidationEnd - splitGapTicks && anchorIndex < rawValidationEnd + splitGapTicks;
    if (anchorInsideTrainGap || anchorInsideValidationGap) {
      excludedSplitGap += 1;
      continue;
    }

    const split = anchorIndex < rawTrainEnd - splitGapTicks
      ? 'train'
      : anchorIndex < rawValidationEnd - splitGapTicks
        ? 'validation'
        : 'test';

    const tickPoints = featureWindow.map((tick) => ({ price: tick.price, timestamp: tick.tick_epoch * 1000 }));
    const featureObject = extractTickFeatures(tickPoints, {
      symbol,
      assetCategoryNum: assetCategory,
      contractDurationSecs: horizonTicks,
      pipelineConfig: config,
    });
    const rawFeatureVector = featureObjToArray(featureObject, config.featureOrder);

    preSamples.push({
      sampleIndex: preSamples.length,
      split,
      anchorEpoch: entry.tick_epoch,
      anchorTime: entry.tick_time,
      outcomeEpoch: outcome.tick_epoch,
      outcomeTime: outcome.tick_time,
      entryPrice: entry.price,
      outcomePrice: outcome.price,
      label: delta > 0 ? 'RISE' : 'FALL',
      featureVector: rawFeatureVector,
      rawFeatureVector,
      sourceWindowFromEpoch: featureWindow[0].tick_epoch,
      sourceWindowToEpoch: featureWindow[featureWindow.length - 1].tick_epoch,
    });
  }

  if (!preSamples.length) {
    throw new Error('No non-flat directional samples could be constructed from the persisted real ticks.');
  }

  const trainVectors = preSamples.filter((sample) => sample.split === 'train').map((sample) => sample.rawFeatureVector);
  const normalizationStats = computeNormalizationStats(trainVectors, config.normalizationEpsilon);
  const normalizationVersion = deriveNormalizationVersion(normalizationStats.fingerprint, config);

  const samples: DatasetSample[] = preSamples.map((sample) => ({
    sampleIndex: sample.sampleIndex,
    split: sample.split,
    anchorEpoch: sample.anchorEpoch,
    anchorTime: sample.anchorTime,
    outcomeEpoch: sample.outcomeEpoch,
    outcomeTime: sample.outcomeTime,
    entryPrice: sample.entryPrice,
    outcomePrice: sample.outcomePrice,
    label: sample.label,
    featureVector: normalizeVector(sample.rawFeatureVector, normalizationStats.means, normalizationStats.stds),
    sourceWindowFromEpoch: sample.sourceWindowFromEpoch,
    sourceWindowToEpoch: sample.sourceWindowToEpoch,
  }));

  const trainCount = samples.filter((sample) => sample.split === 'train').length;
  const validationCount = samples.filter((sample) => sample.split === 'validation').length;
  const testCount = samples.filter((sample) => sample.split === 'test').length;
  const generatedSamples = samples.length;
  const leakageCheckPassed = samples.every((sample) => sample.outcomeEpoch > sample.anchorEpoch && sample.sourceWindowToEpoch === sample.anchorEpoch);
  const temporalSplitValidated = splitGapTicks >= 1 && trainCount > 0 && validationCount > 0 && testCount > 0;

  if (!leakageCheckPassed) throw new Error('Dataset leakage validation failed. No dataset was persisted.');
  if (!temporalSplitValidated) throw new Error('Temporal split validation failed. No dataset was persisted.');

  const sourceFrom = ticks[0].tick_time;
  const sourceTo = ticks[ticks.length - 1].tick_time;
  const checksum = crypto.createHash('sha256').update(JSON.stringify(samples)).digest('hex');
  const datasetFingerprint = buildDatasetFingerprint(
    [symbol, horizonTicks, windowTicks, generatedSamples, sourceFrom, sourceTo, checksum, featureSchemaVersion, labelSchemaVersion, normalizationVersion],
    config,
  );
  const version = `v${compactIsoStamp(now)}-${datasetFingerprint.slice(0, 8)}`;
  const qualityReport: DatasetQualityReport = {
    status: 'READY',
    totalTicks,
    validTicks: ticks.length,
    invalidTicks,
    duplicateTicks,
    candidateSamples: totalCandidates,
    generatedSamples,
    excludedMissingWindows,
    excludedAmbiguousTargets,
    excludedSplitGap,
    featureCount: config.featureOrder.length,
    trainCount,
    validationCount,
    testCount,
    splitGapTicks,
    leakageCheckPassed,
    temporalSplitValidated,
    normalizationVersion,
    featureSchemaVersion,
    labelSchemaVersion,
  };

  await sql`
    INSERT INTO training_datasets (
      id, name, version, asset_symbol, horizon_ticks, feature_schema_version,
      label_schema_version, source_from, source_to, sample_count, train_count,
      validation_count, test_count, status, checksum, leakage_check_passed, metadata
    ) VALUES (
      ${datasetId}, ${String(request.datasetName ?? `Deriv ${displayName} ${horizonTicks}-tick direction dataset`).trim().slice(0, 160)}, ${version}, ${symbol}, ${horizonTicks}, ${featureSchemaVersion},
      ${labelSchemaVersion}, ${sourceFrom}, ${sourceTo}, ${generatedSamples}, ${trainCount},
      ${validationCount}, ${testCount}, 'completed', ${checksum}, ${leakageCheckPassed},
      ${JSON.stringify({
        source: 'deriv',
        assetDisplayName: displayName,
        windowTicks,
        featureCount: config.featureOrder.length,
        labelValues: ['RISE', 'FALL'],
        splitStrategy: 'chronological-70-15-15',
        splitGapTicks,
        labelDeadZone,
        normalization: {
          method: config.normalizationMethod,
          version: normalizationVersion,
          fitSplit: 'train',
          statsFingerprint: normalizationStats.fingerprint,
        },
        qualityReport,
        pipelineConfig: {
          pipelineVersion: config.pipelineVersion,
          canonicalFeatureWindowTicks: config.canonicalFeatureWindowTicks,
          defaultHorizonTicks: config.defaultHorizonTicks,
          featureWindows: config.featureWindows,
          featureOrder: config.featureOrder,
        },
        generatedAt: now.toISOString(),
      })}::jsonb
    )
  `;

  await insertSamples(sql, datasetId, samples).catch(async (error) => {
    await sql`DELETE FROM training_datasets WHERE id = ${datasetId}`;
    throw error;
  });

  return {
    datasetId,
    name: String(request.datasetName ?? `Deriv ${displayName} ${horizonTicks}-tick direction dataset`).trim().slice(0, 160),
    version,
    symbol,
    horizonTicks,
    windowTicks,
    sampleCount: generatedSamples,
    trainCount,
    validationCount,
    testCount,
    sourceFrom,
    sourceTo,
    checksum,
    leakageCheckPassed,
    normalizationVersion,
    datasetFingerprint,
    qualityReport,
    status: 'completed',
  };
}

export async function listTrainingDatasets(symbol?: string) {
  const sql = getSql();
  if (!sql || !(await initDbSchema())) return [];
  await ensureDatasetSampleSchema(sql);
  if (symbol) {
    return await sql`
      SELECT id, name, version, asset_symbol, horizon_ticks, feature_schema_version,
        label_schema_version, source_from, source_to, sample_count, train_count,
        validation_count, test_count, status, checksum, leakage_check_passed,
        metadata, created_at
      FROM training_datasets
      WHERE asset_symbol = ${symbol}
      ORDER BY created_at DESC
      LIMIT 50
    `;
  }
  return await sql`
    SELECT id, name, version, asset_symbol, horizon_ticks, feature_schema_version,
      label_schema_version, source_from, source_to, sample_count, train_count,
      validation_count, test_count, status, checksum, leakage_check_passed,
      metadata, created_at
    FROM training_datasets
    ORDER BY created_at DESC
    LIMIT 50
  `;
}
