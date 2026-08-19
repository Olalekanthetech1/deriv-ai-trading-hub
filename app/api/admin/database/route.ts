import { NextRequest, NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { initDbSchema } from '@/lib/db';
import { verifySessionToken } from '../auth/route';

const EXPECTED_TABLES = [
  'ops_schema_migrations',
  'market_assets',
  'market_ticks',
  'data_ingestion_runs',
  'data_ingestion_checkpoints',
  'training_datasets',
  'ml_model_registry_v2',
  'ml_model_metrics',
  'ml_model_artifacts',
  'ml_backtest_runs',
  'ml_performance_events',
  'execution_trades',
  'ops_model_selection_events',
  'ops_audit_events',
  'ops_health_events',
] as const;

function authorized(req: NextRequest) {
  const cookie = req.cookies.get('admin_session_token')?.value;
  const header = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookie) || verifySessionToken(header);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });

  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    return NextResponse.json(
      { success: true, dataSource: 'runtime', status: 'UNAVAILABLE', configured: false, error: 'DATABASE_URL is not configured.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const started = performance.now();
  try {
    const initialized = await initDbSchema();
    if (!initialized) throw new Error('New database schema initialization failed.');

    const sql = neon(url);
    const [health, tableRows, migrationRows] = await Promise.all([
      sql`SELECT NOW() AS server_time, current_database() AS database_name, current_schema() AS schema_name, version() AS version`,
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
      sql`SELECT version, applied_at FROM ops_schema_migrations ORDER BY version DESC LIMIT 20`,
    ]);

    const tables = tableRows.map((row: any) => String(row.table_name));
    const expectedPresent = EXPECTED_TABLES.filter((table) => tables.includes(table));
    const missingExpectedTables = EXPECTED_TABLES.filter((table) => !tables.includes(table));
    const schemaReady = missingExpectedTables.length === 0;
    const latencyMs = Number((performance.now() - started).toFixed(2));

    return NextResponse.json({
      success: true,
      dataSource: 'live-database',
      status: schemaReady ? 'HEALTHY' : 'SCHEMA_INCOMPLETE',
      configured: true,
      latencyMs,
      serverTime: health[0]?.server_time ?? null,
      databaseName: health[0]?.database_name ?? null,
      schemaName: health[0]?.schema_name ?? null,
      version: health[0]?.version ?? null,
      tables,
      tableCount: tables.length,
      schema: {
        version: migrationRows[0]?.version ?? null,
        expectedTableCount: EXPECTED_TABLES.length,
        expectedTablesPresent: expectedPresent.length,
        missingExpectedTables,
      },
      migrations: migrationRows,
      integrity: {
        configurationVerifiedByQuery: true,
        connectionVerifiedByQuery: true,
        valuesDerivedFromLiveDatabase: true,
        schemaDerivedFromExpectedManifest: true,
        newSchemaInitializationVerified: true,
      },
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      dataSource: 'live-database',
      status: 'UNHEALTHY',
      configured: true,
      latencyMs: Number((performance.now() - started).toFixed(2)),
      error: error?.message || 'Database connection/query failed.',
      integrity: { configurationVerifiedByQuery: false, connectionVerifiedByQuery: false, valuesDerivedFromLiveDatabase: false },
    }, { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }
}
