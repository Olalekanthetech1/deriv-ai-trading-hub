import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from './db';
import { getMlModelDefinitions, type MlModelFamily } from './ml-model-registry';
import { buildUnifiedHorizonKey, createUnifiedHorizon, type UnifiedHorizon } from './ml-unified-horizon-contract';
import type { DerivDurationUnit } from './deriv-duration-registry';
import { resolveAllDatasetsCompatibility, type DatasetCompatibilityReport } from './ml-dataset-compatibility';
import { ensureUnifiedHorizonSchema } from './ml-unified-horizon-schema';

export type MlDatasetSourceType = 'duration' | 'unified_multi_horizon';
export type MlDatasetAdapterStatus = 'native' | 'adapter_required';

export type CanonicalMlDataset = {
  id: string;
  sourceDatasetId: string;
  sourceType: MlDatasetSourceType;
  name: string;
  symbol: string;
  durationValue: number | null;
  durationUnit: DerivDurationUnit | null;
  durationSeconds: number | null;
  horizonKey: string | null;
  horizon: UnifiedHorizon | null;
  sampleCount: number;
  trainCount: number;
  validationCount: number;
  testCount: number;
  featureSchemaVersion: string;
  checksum: string;
  leakageCheckPassed: boolean;
  status: 'completed' | 'failed' | 'building';
  createdAt: string;
  adapterStatus: MlDatasetAdapterStatus;
  supportedModelFamilies: MlModelFamily[];
  compatibility?: DatasetCompatibilityReport;
};

type Sql = ReturnType<typeof neon>;

function sqlClient(): Sql | null {
  const url = getDbConnectionString();
  return url ? neon(url) : null;
}

function finiteCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function supportedFamilies(sourceType: MlDatasetSourceType): MlModelFamily[] {
  return getMlModelDefinitions()
    .map((definition) => definition.family)
    .filter((family, index, values) => values.indexOf(family) === index);
}

function canonicalUnifiedId(datasetId: string, horizonKey: string): string {
  return `unified:${datasetId}:${horizonKey}`;
}

export async function listCanonicalMlDatasets(symbol?: string): Promise<CanonicalMlDataset[]> {
  const sql = sqlClient();
  if (!sql || !(await initDbSchema())) throw new Error('DATABASE_UNAVAILABLE');
  await ensureUnifiedHorizonSchema(sql);

  const normalizedSymbol = symbol?.trim().toUpperCase() || null;

  const durationRows = await sql`
    SELECT id, name, asset_symbol, duration_value, duration_unit, duration_seconds,
           sample_count, train_count, validation_count, test_count,
           feature_schema_version, checksum, leakage_check_passed, status, created_at
    FROM training_datasets
    WHERE status = 'completed'
      AND leakage_check_passed = TRUE
      AND (${normalizedSymbol}::varchar IS NULL OR asset_symbol = ${normalizedSymbol}::varchar)
    ORDER BY created_at DESC
  `;

  const unifiedRows = await sql`
    SELECT id, name, symbol, horizons, feature_schema_version,
           sample_count, train_count, validation_count, test_count,
           checksum, leakage_check_passed, status, created_at
    FROM ml_unified_horizon_datasets
    WHERE status = 'completed'
      AND leakage_check_passed = TRUE
      AND (${normalizedSymbol}::varchar IS NULL OR symbol = ${normalizedSymbol}::varchar)
    ORDER BY created_at DESC
  `;

  const durationDatasets: CanonicalMlDataset[] = (durationRows as any[]).map((row) => ({
    id: `duration:${String(row.id)}`,
    sourceDatasetId: String(row.id),
    sourceType: 'duration',
    name: String(row.name),
    symbol: String(row.asset_symbol),
    durationValue: Number(row.duration_value),
    durationUnit: String(row.duration_unit) as DerivDurationUnit,
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    horizonKey: `${Number(row.duration_value)}${String(row.duration_unit)}`,
    horizon: createUnifiedHorizon(Number(row.duration_value), String(row.duration_unit) as DerivDurationUnit, Number(row.horizon_ticks)),
    sampleCount: finiteCount(row.sample_count) || finiteCount(row.train_count) + finiteCount(row.validation_count) + finiteCount(row.test_count),
    trainCount: finiteCount(row.train_count),
    validationCount: finiteCount(row.validation_count),
    testCount: finiteCount(row.test_count),
    featureSchemaVersion: String(row.feature_schema_version ?? ''),
    checksum: String(row.checksum ?? ''),
    leakageCheckPassed: row.leakage_check_passed === true,
    status: String(row.status) as CanonicalMlDataset['status'],
    createdAt: new Date(row.created_at).toISOString(),
    adapterStatus: 'native',
    supportedModelFamilies: supportedFamilies('duration'),
  }));

  const unifiedDatasets: CanonicalMlDataset[] = [];
  for (const row of unifiedRows as any[]) {
    const horizons = Array.isArray(row.horizons) ? row.horizons : [];
    for (const rawHorizon of horizons) {
      const value = Number(rawHorizon?.value);
      const unit = String(rawHorizon?.unit) as DerivDurationUnit;
      if (!Number.isSafeInteger(value) || value <= 0 || !['t', 's', 'm', 'h', 'd'].includes(unit)) continue;
      const horizon = createUnifiedHorizon(value, unit, Number(rawHorizon?.effectiveHorizonTicks) || null);
      const key = buildUnifiedHorizonKey(value, unit);
      unifiedDatasets.push({
        id: canonicalUnifiedId(String(row.id), key),
        sourceDatasetId: String(row.id),
        sourceType: 'unified_multi_horizon',
        name: `${String(row.name)} — ${key}`,
        symbol: String(row.symbol),
        durationValue: value,
        durationUnit: unit,
        durationSeconds: horizon.seconds,
        horizonKey: key,
        horizon,
        sampleCount: finiteCount(row.sample_count),
        trainCount: finiteCount(row.train_count),
        validationCount: finiteCount(row.validation_count),
        testCount: finiteCount(row.test_count),
        featureSchemaVersion: String(row.feature_schema_version ?? ''),
        checksum: String(row.checksum ?? ''),
        leakageCheckPassed: row.leakage_check_passed === true,
        status: String(row.status) as CanonicalMlDataset['status'],
        createdAt: new Date(row.created_at).toISOString(),
        adapterStatus: 'adapter_required',
        supportedModelFamilies: supportedFamilies('unified_multi_horizon'),
      });
    }
  }

  return [...durationDatasets, ...unifiedDatasets].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function listCanonicalMlDatasetsWithCompatibility(symbol?: string): Promise<CanonicalMlDataset[]> {
  const datasets = await listCanonicalMlDatasets(symbol);
  if (!datasets.length) return [];
  const reports = await resolveAllDatasetsCompatibility(datasets);
  const reportsMap = new Map(reports.map((r) => [r.datasetId, r]));

  return datasets.map((dataset) => ({
    ...dataset,
    compatibility: reportsMap.get(dataset.id),
  }));
}
