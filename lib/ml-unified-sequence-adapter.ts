import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from './db';
import { getMlRuntimeSchemaContract } from './ml-runtime-schema';
import { durationToSeconds, type DerivDurationUnit } from './deriv-duration-registry';

export type UnifiedSequenceDatasetRequest = {
  datasetId: string;
  horizonKey: string;
};

export type SequencePartition = {
  featureSequences: number[][][];
  labels: number[];
  featureCount: number;
  sequenceLength: number;
  schemaVersion: string;
  schemaFingerprint: string;
};

export type TabularPartition = {
  featureVectors: number[][];
  labels: number[];
  sampleCount: number;
  featureCount: number;
  schemaVersion: string;
  schemaFingerprint: string;
};

export type UnifiedSequenceDataset = {
  sourceDatasetId: string;
  horizonKey: string;
  symbol: string;
  durationValue: number;
  durationUnit: DerivDurationUnit;
  durationSeconds: number | null;
  effectiveHorizonTicks: number | null;
  featureSchemaVersion: string;
  schemaFingerprint: string;
  sequenceLength: number;
  train: SequencePartition;
  validation: SequencePartition;
  test: SequencePartition;
  tabularTrain: TabularPartition;
  tabularValidation: TabularPartition;
  tabularTest: TabularPartition;
  trainSamples: number;
  validationSamples: number;
  testSamples: number;
};

function sqlClient() {
  const url = getDbConnectionString();
  return url ? neon(url) : null;
}

function parseHorizonKey(horizonKey: string): { value: number; unit: DerivDurationUnit } | null {
  const match = /^([1-9]\d*)(t|s|m|h|d)$/.exec(horizonKey.trim().toLowerCase());
  if (!match) return null;
  return { value: Number(match[1]), unit: match[2] as DerivDurationUnit };
}

function buildPartitions(rows: any[], sequenceLength: number, schema: any): Record<'train' | 'validation' | 'test', SequencePartition> {
  const result = {} as Record<'train' | 'validation' | 'test', SequencePartition>;

  for (const split of ['train', 'validation', 'test'] as const) {
    const ordered = rows
      .filter((row) => String(row.split) === split)
      .sort((a, b) => Number(a.sample_index) - Number(b.sample_index));

    const featureSequences: number[][][] = [];
    const labels: number[] = [];

    for (let i = sequenceLength - 1; i < ordered.length; i += 1) {
      const window = ordered.slice(i - sequenceLength + 1, i + 1);
      const vectors = window.map((row) =>
        Array.isArray(row.feature_vector) ? row.feature_vector.map(Number) : null,
      );

      if (
        vectors.some(
          (vector: number[] | null) =>
            !vector ||
            vector.length !== schema.featureCount ||
            vector.some((value) => !Number.isFinite(value)),
        )
      ) {
        continue;
      }

      const label = String(ordered[i].label).toUpperCase();
      if (label !== 'RISE' && label !== 'FALL') continue;

      featureSequences.push(vectors as number[][]);
      labels.push(label === 'RISE' ? 1 : 0);
    }

    result[split] = {
      featureSequences,
      labels,
      featureCount: schema.featureCount,
      sequenceLength,
      schemaVersion: schema.featureSchemaVersion,
      schemaFingerprint: schema.schemaFingerprint,
    };
  }

  return result;
}

function buildTabularPartitions(rows: any[], schema: any): Record<'train' | 'validation' | 'test', TabularPartition> {
  const result = {} as Record<'train' | 'validation' | 'test', TabularPartition>;

  for (const split of ['train', 'validation', 'test'] as const) {
    const ordered = rows
      .filter((row) => String(row.split) === split)
      .sort((a, b) => Number(a.sample_index) - Number(b.sample_index));

    const featureVectors: number[][] = [];
    const labels: number[] = [];

    for (const row of ordered) {
      const vector = Array.isArray(row.feature_vector) ? row.feature_vector.map(Number) : null;
      if (!vector || vector.length !== schema.featureCount || vector.some((value: number) => !Number.isFinite(value))) {
        continue;
      }

      const label = String(row.label).toUpperCase();
      if (label !== 'RISE' && label !== 'FALL') continue;

      featureVectors.push(vector);
      labels.push(label === 'RISE' ? 1 : 0);
    }

    result[split] = {
      featureVectors,
      labels,
      sampleCount: featureVectors.length,
      featureCount: schema.featureCount,
      schemaVersion: schema.featureSchemaVersion,
      schemaFingerprint: schema.schemaFingerprint,
    };
  }

  return result;
}

export async function loadUnifiedSequenceDataset(
  request: UnifiedSequenceDatasetRequest,
): Promise<UnifiedSequenceDataset> {
  const datasetId = String(request.datasetId ?? '').trim();
  const horizonKey = String(request.horizonKey ?? '').trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(datasetId)) throw new Error('INVALID_UNIFIED_DATASET_ID');

  const horizon = parseHorizonKey(horizonKey);
  if (!horizon) throw new Error('INVALID_UNIFIED_HORIZON_KEY');

  const sql = sqlClient();
  if (!sql || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');

  const datasetRows = await sql`
    SELECT id, symbol, horizons, feature_schema_version, status, leakage_check_passed
    FROM ml_unified_horizon_datasets
    WHERE id = ${datasetId}::uuid
    LIMIT 1
  `;
  const dataset = datasetRows[0] as any;
  if (!dataset) throw new Error('UNIFIED_DATASET_NOT_FOUND');
  if (String(dataset.status) !== 'completed' || dataset.leakage_check_passed !== true) {
    throw new Error('UNIFIED_DATASET_NOT_READY_FOR_TRAINING');
  }

  const horizons = Array.isArray(dataset.horizons) ? dataset.horizons : [];
  const selected = horizons.find(
    (item: any) =>
      Number(item?.value) === horizon.value &&
      String(item?.unit).toLowerCase() === horizon.unit,
  );
  if (!selected) throw new Error('UNIFIED_HORIZON_NOT_PRESENT');

  const effectiveHorizonTicks = Number(selected.effectiveHorizonTicks);
  const baseSchema = await getMlRuntimeSchemaContract();
  const schema = await getMlRuntimeSchemaContract({
    durationValue: horizon.value,
    durationUnit: horizon.unit,
  });

  const datasetSchemaVersion = String(dataset.feature_schema_version ?? '').trim();
  if (datasetSchemaVersion) {
    const isCompatible =
      datasetSchemaVersion === schema.featureSchemaVersion ||
      datasetSchemaVersion === baseSchema.featureSchemaVersion ||
      datasetSchemaVersion.startsWith(`feature-schema-${baseSchema.featureCount}`) ||
      datasetSchemaVersion.includes(baseSchema.pipelineVersion);

    if (!isCompatible) {
      throw new Error(
        `UNIFIED_DATASET_FEATURE_SCHEMA_VERSION_MISMATCH: dataset=${datasetSchemaVersion} runtime=${schema.featureSchemaVersion}`,
      );
    }
  }

  const rows = await sql`
    SELECT sample_index, split, feature_vector, horizon_labels
    FROM ml_unified_horizon_samples
    WHERE dataset_id = ${datasetId}::uuid
    ORDER BY sample_index ASC
  `;

  if (!rows.length) throw new Error('UNIFIED_DATASET_CONTAINS_NO_SAMPLES');

  const normalizedRows = (rows as any[]).map((row) => {
    const labels = row.horizon_labels && typeof row.horizon_labels === 'object' ? row.horizon_labels : {};
    return {
      ...row,
      label: String(labels[horizonKey] ?? '').toUpperCase(),
    };
  });

  const partitions = buildPartitions(normalizedRows, schema.sequenceLength, schema);
  const tabularPartitions = buildTabularPartitions(normalizedRows, schema);
  if (partitions.train.featureSequences.length < 2) {
    throw new Error(
      `UNIFIED_SEQUENCE_TRAIN_SPLIT_INSUFFICIENT: train split produced ${partitions.train.featureSequences.length} sequence windows of length ${schema.sequenceLength} (requires >= 2 contiguous windows)`,
    );
  }
  if (new Set(partitions.train.labels).size < 2) {
    throw new Error('UNIFIED_SEQUENCE_TRAIN_LABELS_MONOLITHIC: train split does not contain both RISE and FALL labels');
  }
  if (partitions.validation.featureSequences.length < 2) {
    throw new Error(
      `UNIFIED_SEQUENCE_VALIDATION_SPLIT_INSUFFICIENT: validation split produced ${partitions.validation.featureSequences.length} sequence windows of length ${schema.sequenceLength} (requires >= 2 contiguous windows)`,
    );
  }
  if (new Set(partitions.validation.labels).size < 2) {
    throw new Error('UNIFIED_SEQUENCE_VALIDATION_LABELS_MONOLITHIC: validation split does not contain both RISE and FALL labels');
  }

  return {
    sourceDatasetId: datasetId,
    horizonKey,
    symbol: String(dataset.symbol),
    durationValue: horizon.value,
    durationUnit: horizon.unit,
    durationSeconds: horizon.unit === 't' ? null : Number(durationToSeconds(horizon.value, horizon.unit)),
    effectiveHorizonTicks: Number.isSafeInteger(effectiveHorizonTicks) && effectiveHorizonTicks > 0 ? effectiveHorizonTicks : null,
    featureSchemaVersion: String(schema.featureSchemaVersion),
    schemaFingerprint: String(schema.schemaFingerprint),
    sequenceLength: schema.sequenceLength,
    train: partitions.train,
    validation: partitions.validation,
    test: partitions.test,
    tabularTrain: tabularPartitions.train,
    tabularValidation: tabularPartitions.validation,
    tabularTest: tabularPartitions.test,
    trainSamples: partitions.train.featureSequences.length,
    validationSamples: partitions.validation.featureSequences.length,
    testSamples: partitions.test.featureSequences.length,
  };
}
