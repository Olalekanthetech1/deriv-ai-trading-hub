import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const EXECUTE = process.argv.includes('--execute');
const ARCHIVE = process.argv.includes('--archive');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_TABLE = 'ml_model_registry';
const TARGET_TABLE = 'ml_model_registry_v2';

if (!DATABASE_URL) {
  console.error('[Legacy Model Registry Migration] DATABASE_URL is required.');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

function pick(row, ...names) {
  const entries = Object.entries(row);
  for (const name of names) {
    const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match && match[1] !== null && match[1] !== undefined && String(match[1]).trim() !== '') return match[1];
  }
  return null;
}

function jsonValue(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function optionalUuid(value) {
  const normalized = value == null ? '' : String(value).trim();
  if (!normalized) return null;
  return UUID_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeStatus(value) {
  const status = String(value ?? '').trim().toLowerCase();
  return ['candidate', 'staging', 'production', 'retired'].includes(status) ? status : null;
}

function mapRow(row) {
  const modelId = pick(row, 'model_id', 'modelId', 'id');
  const modelFamily = pick(row, 'model_family', 'modelFamily', 'model_name', 'modelName', 'family');
  const version = pick(row, 'version', 'model_version', 'modelVersion');
  const assetSymbol = pick(row, 'asset_symbol', 'symbol', 'assetSymbol');
  const assetClass = pick(row, 'asset_class', 'assetClass');
  const horizonTicks = toInteger(pick(row, 'horizon_ticks', 'horizonTicks'));
  const format = pick(row, 'format', 'model_format');
  const status = normalizeStatus(pick(row, 'status', 'state'));
  const featureSchemaVersion = pick(row, 'feature_schema_version', 'featureSchemaVersion', 'feature_schema', 'featureSchema');
  const framework = pick(row, 'framework');
  const datasetId = optionalUuid(pick(row, 'dataset_id', 'datasetId'));
  const trainingRunId = optionalUuid(pick(row, 'training_run_id', 'trainingRunId', 'run_id'));

  const missing = [];
  if (!modelId) missing.push('model_id');
  if (!modelFamily) missing.push('model_family');
  if (!version) missing.push('version');
  if (!assetSymbol) missing.push('asset_symbol');
  if (!assetClass) missing.push('asset_class');
  if (!horizonTicks) missing.push('horizon_ticks');
  if (!format) missing.push('format');
  if (!status) missing.push('status');
  if (!featureSchemaVersion) missing.push('feature_schema_version');
  if (datasetId === undefined) missing.push('dataset_id_invalid_uuid');
  if (trainingRunId === undefined) missing.push('training_run_id_invalid_uuid');

  return {
    modelId: modelId ? String(modelId) : null,
    modelFamily: modelFamily ? String(modelFamily) : null,
    version: version ? String(version) : null,
    assetSymbol: assetSymbol ? String(assetSymbol) : null,
    assetClass: assetClass ? String(assetClass) : null,
    horizonTicks,
    format: format ? String(format) : null,
    status,
    featureSchemaVersion: featureSchemaVersion ? String(featureSchemaVersion) : null,
    framework: framework ? String(framework) : null,
    datasetId: datasetId ?? null,
    trainingRunId: trainingRunId ?? null,
    metrics: jsonValue(pick(row, 'metrics'), {
      legacyAccuracy: pick(row, 'accuracy'),
      legacyBacktestWinRate: pick(row, 'backtest_win_rate', 'backtestWinRate'),
      legacyBacktestProfitFactor: pick(row, 'backtest_profit_factor', 'backtestProfitFactor'),
    }),
    hyperparameters: jsonValue(pick(row, 'hyperparameters', 'params')),
    missing,
    raw: row,
  };
}

async function tableExists(tableName) {
  const rows = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${tableName}
    ) AS exists
  `;
  return Boolean(rows[0]?.exists);
}

async function loadLegacyRows() {
  // Fixed internal identifier; never derived from request/user input.
  const rows = await sql.query(`SELECT to_jsonb(t) AS row FROM public.${LEGACY_TABLE} AS t`);
  return rows.map((entry) => entry.row ?? {});
}

async function main() {
  if (!(await tableExists(LEGACY_TABLE))) {
    console.log('[Legacy Model Registry Migration] No legacy table exists. Nothing to migrate.');
    return;
  }
  if (!(await tableExists(TARGET_TABLE))) {
    throw new Error(`${TARGET_TABLE} does not exist. Deploy the new registry architecture first.`);
  }

  const mapped = (await loadLegacyRows()).map(mapRow);
  const migratable = mapped.filter((row) => row.missing.length === 0);
  const skipped = mapped.filter((row) => row.missing.length > 0);

  console.log(JSON.stringify({
    mode: EXECUTE ? 'execute' : 'dry-run',
    archiveAfterMigration: ARCHIVE,
    legacyRows: mapped.length,
    migratableRows: migratable.length,
    skippedRows: skipped.length,
    skipped: skipped.map(({ modelId, missing }) => ({ modelId, missing })),
  }, null, 2));

  if (!EXECUTE) return;
  if (skipped.length) {
    throw new Error(`Migration blocked: ${skipped.length} row(s) lack verifiable required metadata.`);
  }

  await sql`BEGIN`;
  try {
    for (const row of migratable) {
      const metrics = {
        ...row.metrics,
        legacyRegistryMigration: true,
        legacyRegistrySource: LEGACY_TABLE,
        legacyRegistryRow: row.raw,
      };

      await sql`
        INSERT INTO ml_model_registry_v2 (
          model_id, model_family, version, asset_symbol, asset_class, horizon_ticks,
          dataset_id, format, status, feature_schema_version, framework, training_run_id,
          metrics, hyperparameters, updated_at
        ) VALUES (
          ${row.modelId}, ${row.modelFamily}, ${row.version}, ${row.assetSymbol}, ${row.assetClass}, ${row.horizonTicks},
          ${row.datasetId}, ${row.format}, ${row.status}, ${row.featureSchemaVersion}, ${row.framework}, ${row.trainingRunId},
          ${JSON.stringify(metrics)}::jsonb, ${JSON.stringify(row.hyperparameters)}::jsonb, NOW()
        )
        ON CONFLICT (model_id) DO NOTHING
      `;
    }

    const verification = await sql`
      SELECT COUNT(*)::int AS count
      FROM ml_model_registry_v2
      WHERE metrics->>'legacyRegistryMigration' = 'true'
    `;
    const migratedCount = Number(verification[0]?.count ?? 0);
    if (migratedCount < migratable.length) {
      throw new Error(`Migration verification failed: expected ${migratable.length}, found ${migratedCount}.`);
    }

    await sql`
      INSERT INTO ops_audit_events (category, severity, actor, action, resource_type, resource_id, metadata)
      VALUES (
        'model-registry', 'info', 'migration-script', 'migrate-legacy-registry', 'table', ${LEGACY_TABLE},
        ${JSON.stringify({ source: LEGACY_TABLE, target: TARGET_TABLE, migratedCount })}::jsonb
      )
    `;

    if (ARCHIVE) {
      const archiveName = `ml_model_registry_legacy_archive_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
      if (!/^[a-z0-9_]+$/.test(archiveName)) throw new Error('INVALID_ARCHIVE_TABLE_NAME');
      if (await tableExists(archiveName)) throw new Error(`Archive table already exists: ${archiveName}`);
      await sql.query(`ALTER TABLE public.${LEGACY_TABLE} RENAME TO ${archiveName}`);
      console.log(`[Legacy Model Registry Migration] Archived ${LEGACY_TABLE} as ${archiveName}.`);
    }

    await sql`COMMIT`;
    console.log(`[Legacy Model Registry Migration] Migrated ${migratable.length} row(s) into ${TARGET_TABLE}.`);
  } catch (error) {
    await sql`ROLLBACK`;
    throw error;
  }
}

main().catch((error) => {
  console.error('[Legacy Model Registry Migration] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
