import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from '@/lib/db';
import { fetchDerivTickHistory, type TickPoint } from '@/lib/ticks-helper';

type Sql = any;

type IngestionBatch = {
  batchId: string;
  startedAt: string;
  completedAt: string | null;
  requestedCount: number;
  recordsReceived: number;
  recordsInserted: number;
  recordsRejected: number;
  firstTickTime: string | null;
  lastTickTime: string | null;
  checkpointEpoch: number | null;
  status: 'completed' | 'partial' | 'failed';
  errorMessage: string | null;
};

export type HistoricalTick = TickPoint & {
  epochMs: number;
  sourceTickId: string;
};

export type HistoricalIngestionRun = {
  runId: string;
  symbol: string;
  requestedCount: number;
  requestedFrom: string | null;
  requestedTo: string | null;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'partial' | 'failed';
  recordsReceived: number;
  recordsInserted: number;
  recordsRejected: number;
  firstTickTime: string | null;
  lastTickTime: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
};

export type HistoricalCheckpoint = {
  source: string;
  symbol: string;
  lastTickEpoch: number | null;
  lastTickTime: string | null;
  updatedAt: string;
};

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function isValidSymbol(symbol: string): boolean {
  return /^[A-Z0-9_./:-]{2,64}$/.test(symbol);
}

function makeSourceTickId(symbol: string, epochMs: number, price: number, index: number): string {
  return crypto.createHash('sha1').update(`${symbol}:${epochMs}:${price}:${index}`).digest('hex');
}

function normalizeTicks(symbol: string, ticks: TickPoint[]): HistoricalTick[] {
  const cleaned = ticks
    .map((tick, index) => {
      const epochMs = Number(tick.timestamp);
      const price = Number(tick.price);
      if (!Number.isFinite(epochMs) || epochMs <= 0 || !Number.isFinite(price) || price <= 0) return null;
      return {
        price,
        timestamp: epochMs,
        epochMs,
        sourceTickId: makeSourceTickId(symbol, epochMs, price, index),
      } satisfies HistoricalTick;
    })
    .filter((tick): tick is HistoricalTick => tick !== null)
    .sort((a, b) => a.epochMs - b.epochMs);

  const deduped = new Map<string, HistoricalTick>();
  for (const tick of cleaned) deduped.set(tick.sourceTickId, tick);
  return [...deduped.values()].sort((a, b) => a.epochMs - b.epochMs);
}

function readBatches(metadata: Record<string, unknown>): IngestionBatch[] {
  return Array.isArray(metadata.batches) ? metadata.batches.filter((batch): batch is IngestionBatch => Boolean(batch && typeof batch === 'object')) : [];
}

async function getAssetId(sql: Sql, symbol: string): Promise<number> {
  const rows = (await sql`
    INSERT INTO market_assets (symbol, display_name, asset_class, market_type, source, is_active)
    VALUES (${symbol}, ${symbol}, 'unknown', 'unknown', 'deriv', TRUE)
    ON CONFLICT (symbol) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `) as Array<{ id?: number | string | null }>;

  const id = Number(rows[0]?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Unable to resolve market asset id for ${symbol}.`);
  }
  return id;
}

async function createRunRecord(sql: Sql, run: HistoricalIngestionRun): Promise<void> {
  await sql`
    INSERT INTO data_ingestion_runs (
      id, source, asset_symbol, requested_from, requested_to, started_at, completed_at, status,
      records_received, records_inserted, records_rejected, first_tick_time, last_tick_time, error_message, metadata
    ) VALUES (
      ${run.runId}, 'deriv', ${run.symbol}, ${run.requestedFrom}, ${run.requestedTo}, ${run.startedAt}, ${run.completedAt}, ${run.status},
      ${run.recordsReceived}, ${run.recordsInserted}, ${run.recordsRejected}, ${run.firstTickTime}, ${run.lastTickTime}, ${run.errorMessage},
      ${JSON.stringify(run.metadata)}::jsonb
    )
  `;
}

async function updateRunRecord(sql: Sql, run: HistoricalIngestionRun): Promise<void> {
  await sql`
    UPDATE data_ingestion_runs
    SET completed_at = ${run.completedAt},
        status = ${run.status},
        records_received = ${run.recordsReceived},
        records_inserted = ${run.recordsInserted},
        records_rejected = ${run.recordsRejected},
        first_tick_time = ${run.firstTickTime},
        last_tick_time = ${run.lastTickTime},
        error_message = ${run.errorMessage},
        metadata = ${JSON.stringify(run.metadata)}::jsonb
    WHERE id = ${run.runId}
  `;
}

async function findResumableRun(sql: Sql, symbol: string, requestedCount: number): Promise<HistoricalIngestionRun | null> {
  const rows = (await sql`
    SELECT
      id AS "runId",
      asset_symbol AS "symbol",
      COALESCE((metadata->>'requestedCount')::int, 0) AS "requestedCount",
      requested_from AS "requestedFrom",
      requested_to AS "requestedTo",
      started_at AS "startedAt",
      completed_at AS "completedAt",
      status,
      records_received AS "recordsReceived",
      records_inserted AS "recordsInserted",
      records_rejected AS "recordsRejected",
      first_tick_time AS "firstTickTime",
      last_tick_time AS "lastTickTime",
      error_message AS "errorMessage",
      COALESCE(metadata, '{}'::jsonb) AS metadata
    FROM data_ingestion_runs
    WHERE source = 'deriv'
      AND asset_symbol = ${symbol}
      AND status = 'partial'
      AND COALESCE((metadata->>'requestedCount')::int, 0) = ${requestedCount}
      AND COALESCE(metadata->>'supersededBy', '') = ''
    ORDER BY started_at DESC
    LIMIT 1
  `) as any[];

  if (!rows.length) return null;
  const row = rows[0];
  let metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {};
  let recordsReceived = Number(row.recordsReceived || 0);
  let recordsInserted = Number(row.recordsInserted || 0);
  let recordsRejected = Number(row.recordsRejected || 0);
  let firstTickTime = row.firstTickTime ? new Date(row.firstTickTime).toISOString() : null;
  let lastTickTime = row.lastTickTime ? new Date(row.lastTickTime).toISOString() : null;
  let batches = readBatches(metadata);

  if (typeof metadata.backfillSessionId !== 'string' || !metadata.backfillSessionId) {
    const legacyRows = (await sql`
      SELECT
        id,
        records_received,
        records_inserted,
        records_rejected,
        first_tick_time,
        last_tick_time,
        COALESCE(metadata, '{}'::jsonb) AS metadata
      FROM data_ingestion_runs
      WHERE source = 'deriv'
        AND asset_symbol = ${symbol}
        AND status = 'partial'
        AND COALESCE((metadata->>'requestedCount')::int, 0) = ${requestedCount}
        AND COALESCE(metadata->>'backfillSessionId', '') = ''
        AND COALESCE(metadata->>'supersededBy', '') = ''
      ORDER BY started_at ASC
    `) as any[];

    const sessionId = crypto.randomUUID();
    for (const legacy of legacyRows) {
      if (String(legacy.id) !== String(row.runId)) {
        recordsReceived += Number(legacy.records_received || 0);
        recordsInserted += Number(legacy.records_inserted || 0);
        recordsRejected += Number(legacy.records_rejected || 0);
        if (legacy.first_tick_time && (!firstTickTime || new Date(legacy.first_tick_time).getTime() < new Date(firstTickTime).getTime())) firstTickTime = new Date(legacy.first_tick_time).toISOString();
        if (legacy.last_tick_time && (!lastTickTime || new Date(legacy.last_tick_time).getTime() > new Date(lastTickTime).getTime())) lastTickTime = new Date(legacy.last_tick_time).toISOString();
        batches = [...batches, ...readBatches(legacy.metadata && typeof legacy.metadata === 'object' ? legacy.metadata : {})];
        await sql`
          UPDATE data_ingestion_runs
          SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{supersededBy}', to_jsonb(${String(row.runId)}::text))
          WHERE id = ${legacy.id}
        `;
      }
    }

    metadata = {
      ...metadata,
      backfillSessionId: sessionId,
      migratedLegacyRuns: legacyRows.length,
      batches,
    };
  }

  return {
    runId: String(row.runId),
    symbol: String(row.symbol),
    requestedCount: Number(row.requestedCount || 0),
    requestedFrom: row.requestedFrom ? new Date(row.requestedFrom).toISOString() : null,
    requestedTo: row.requestedTo ? new Date(row.requestedTo).toISOString() : null,
    startedAt: new Date(row.startedAt).toISOString(),
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    status: row.status,
    recordsReceived,
    recordsInserted,
    recordsRejected,
    firstTickTime,
    lastTickTime,
    errorMessage: row.errorMessage ? String(row.errorMessage) : null,
    metadata,
  };
}

async function upsertCheckpoint(sql: Sql, symbol: string, lastTickEpoch: number, lastTickTime: string): Promise<void> {
  await sql`
    INSERT INTO data_ingestion_checkpoints (source, asset_symbol, last_tick_epoch, last_tick_time, updated_at)
    VALUES ('deriv', ${symbol}, ${lastTickEpoch}, ${lastTickTime}, NOW())
    ON CONFLICT (source, asset_symbol) DO UPDATE SET
      last_tick_epoch = EXCLUDED.last_tick_epoch,
      last_tick_time = EXCLUDED.last_tick_time,
      updated_at = NOW()
  `;
}

async function insertTickBatch(sql: Sql, symbol: string, assetId: number, runId: string, ticks: HistoricalTick[]): Promise<number> {
  if (!ticks.length) return 0;

  const insertedRows = await sql`
    INSERT INTO market_ticks (
      asset_id, symbol, price, tick_epoch, tick_time, source, source_tick_id, ingest_run_id
    )
    SELECT * FROM UNNEST(
      ${ticks.map(() => assetId)}::bigint[],
      ${ticks.map(() => symbol)}::text[],
      ${ticks.map((tick) => tick.price)}::numeric[],
      ${ticks.map((tick) => Math.floor(tick.epochMs / 1000))}::bigint[],
      ${ticks.map((tick) => new Date(tick.epochMs).toISOString())}::timestamptz[],
      ${ticks.map(() => 'deriv')}::text[],
      ${ticks.map((tick) => tick.sourceTickId)}::text[],
      ${ticks.map(() => runId)}::uuid[]
    )
    ON CONFLICT (source, source_tick_id) WHERE source_tick_id IS NOT NULL DO NOTHING
    RETURNING id
  `;

  return Array.isArray(insertedRows) ? insertedRows.length : 0;
}

export async function ingestDerivHistoricalTicks(input: {
  symbol: string;
  count: number;
  resumeFromCheckpoint?: boolean;
  endEpoch?: number | 'latest';
}) {
  const dbUrl = getDbConnectionString();
  if (!dbUrl) throw new Error('DATABASE_URL is required for ingestion.');

  const normalizedSymbol = normalizeSymbol(input.symbol);
  if (!isValidSymbol(normalizedSymbol)) {
    throw new Error(`Invalid Deriv symbol: ${input.symbol}`);
  }

  const requestedCount = Math.min(50_000, Math.max(50, Math.floor(input.count)));
  await initDbSchema();
  const sql: Sql = neon(dbUrl) as any;
  const startedAt = new Date().toISOString();
  const shouldResume = Boolean(input.resumeFromCheckpoint);

  let run = shouldResume ? await findResumableRun(sql, normalizedSymbol, requestedCount) : null;
  const isContinuingSession = Boolean(run);
  const runId = run?.runId || crypto.randomUUID();
  const backfillSessionId = String(run?.metadata?.backfillSessionId || crypto.randomUUID());
  const previousBatches = run ? readBatches(run.metadata) : [];

  if (!run) {
    run = {
      runId,
      symbol: normalizedSymbol,
      requestedCount,
      requestedFrom: null,
      requestedTo: null,
      startedAt,
      completedAt: null,
      status: 'running',
      recordsReceived: 0,
      recordsInserted: 0,
      recordsRejected: 0,
      firstTickTime: null,
      lastTickTime: null,
      errorMessage: null,
      metadata: {
        requestedCount,
        resumeFromCheckpoint: shouldResume,
        backfillSessionId,
        batches: [],
      },
    };
    await createRunRecord(sql, run);
  } else {
    run = {
      ...run,
      status: 'running',
      completedAt: null,
      errorMessage: null,
      metadata: {
        ...run.metadata,
        resumedAt: startedAt,
        resumeFromCheckpoint: shouldResume,
        backfillSessionId,
        batches: previousBatches,
      },
    };
  }

  try {
    let cursor: number | 'latest' = typeof input.endEpoch === 'number' && Number.isFinite(input.endEpoch) ? input.endEpoch : 'latest';

    if (shouldResume) {
      const checkpointRows = (await sql`
        SELECT last_tick_epoch
        FROM data_ingestion_checkpoints
        WHERE source = 'deriv' AND asset_symbol = ${normalizedSymbol}
        LIMIT 1
      `) as Array<{ last_tick_epoch?: number | string | null }>;

      const checkpointEpoch = Number(checkpointRows[0]?.last_tick_epoch);
      if (Number.isFinite(checkpointEpoch) && checkpointEpoch > 0) {
        cursor = Math.max(1, Math.floor(checkpointEpoch) - 1);
        run.metadata = { ...run.metadata, resumedFromCheckpointEpoch: checkpointEpoch };
      }
    }

    let remaining = Math.max(0, requestedCount - run.recordsInserted);
    let chunks = Number(run.metadata.chunks || 0);
    let earliestEpoch = run.firstTickTime ? new Date(run.firstTickTime).getTime() : Number.POSITIVE_INFINITY;
    let latestEpoch = run.lastTickTime ? new Date(run.lastTickTime).getTime() : 0;
    const assetId = await getAssetId(sql, normalizedSymbol);
    const batchId = crypto.randomUUID();
    const batch: IngestionBatch = {
      batchId,
      startedAt,
      completedAt: null,
      requestedCount: remaining,
      recordsReceived: 0,
      recordsInserted: 0,
      recordsRejected: 0,
      firstTickTime: null,
      lastTickTime: null,
      checkpointEpoch: null,
      status: 'partial',
      errorMessage: null,
    };

    while (remaining > 0) {
      const batchSize = Math.min(5000, remaining);
      const rawTicks = await fetchDerivTickHistory(normalizedSymbol, batchSize, cursor);
      if (!rawTicks.length) break;

      chunks += 1;
      run.recordsReceived += rawTicks.length;
      batch.recordsReceived += rawTicks.length;

      const cleanedTicks = normalizeTicks(normalizedSymbol, rawTicks);
      run.recordsRejected += rawTicks.length - cleanedTicks.length;
      batch.recordsRejected += rawTicks.length - cleanedTicks.length;
      if (!cleanedTicks.length) break;

      const inserted = await insertTickBatch(sql, normalizedSymbol, assetId, runId, cleanedTicks);
      run.recordsInserted += inserted;
      batch.recordsInserted += inserted;

      const oldest = cleanedTicks[0];
      const newest = cleanedTicks[cleanedTicks.length - 1];
      earliestEpoch = Math.min(earliestEpoch, oldest.epochMs);
      latestEpoch = Math.max(latestEpoch, newest.epochMs);
      batch.firstTickTime = new Date(oldest.epochMs).toISOString();
      batch.lastTickTime = new Date(newest.epochMs).toISOString();

      const checkpointEpoch = Math.floor(oldest.epochMs / 1000);
      batch.checkpointEpoch = checkpointEpoch;
      await upsertCheckpoint(sql, normalizedSymbol, checkpointEpoch, new Date(oldest.epochMs).toISOString());

      cursor = Math.max(1, checkpointEpoch - 1);
      remaining = Math.max(0, requestedCount - run.recordsInserted);
      if (rawTicks.length < batchSize) break;
      if (typeof cursor !== 'number' || cursor <= 0) break;
    }

    batch.completedAt = new Date().toISOString();
    batch.status = run.recordsInserted >= requestedCount ? 'completed' : (run.recordsReceived > 0 ? 'partial' : 'failed');
    const batches = [...previousBatches, batch];

    run = {
      ...run,
      completedAt: batch.completedAt,
      status: run.recordsInserted >= requestedCount ? 'completed' : (run.recordsInserted > 0 ? 'partial' : 'failed'),
      firstTickTime: Number.isFinite(earliestEpoch) ? new Date(earliestEpoch).toISOString() : null,
      lastTickTime: latestEpoch > 0 ? new Date(latestEpoch).toISOString() : null,
      errorMessage: null,
      metadata: {
        ...run.metadata,
        requestedCount,
        backfillSessionId,
        chunks,
        batches,
        cumulativeProgress: {
          requested: requestedCount,
          received: run.recordsReceived,
          inserted: run.recordsInserted,
          rejected: run.recordsRejected,
          percent: Math.min(100, Number(((run.recordsInserted / requestedCount) * 100).toFixed(2))),
        },
      },
    };

    await updateRunRecord(sql, run);

    return {
      success: true,
      ...run,
      dataSource: 'deriv-historical',
      liveDatabase: true,
      resumedExistingSession: isContinuingSession,
      progress: {
        requested: requestedCount,
        received: run.recordsReceived,
        inserted: run.recordsInserted,
        rejected: run.recordsRejected,
        percent: Math.min(100, Number(((run.recordsInserted / requestedCount) * 100).toFixed(2))),
        remaining: Math.max(0, requestedCount - run.recordsInserted),
      },
    };
  } catch (error: any) {
    run = {
      ...run,
      completedAt: new Date().toISOString(),
      status: 'failed',
      errorMessage: error?.message || 'Historical ingestion failed.',
      metadata: {
        ...run.metadata,
        backfillSessionId,
      },
    };
    await updateRunRecord(sql, run).catch(() => {});
    throw error;
  }
}

export async function listHistoricalIngestionRuns(limit = 10): Promise<HistoricalIngestionRun[]> {
  const dbUrl = getDbConnectionString();
  if (!dbUrl) return [];

  await initDbSchema();
  const sql: Sql = neon(dbUrl) as any;
  const rows = await sql`
    SELECT
      id AS "runId",
      asset_symbol AS "symbol",
      COALESCE((metadata->>'requestedCount')::int, 0) AS "requestedCount",
      requested_from AS "requestedFrom",
      requested_to AS "requestedTo",
      started_at AS "startedAt",
      completed_at AS "completedAt",
      status,
      records_received AS "recordsReceived",
      records_inserted AS "recordsInserted",
      records_rejected AS "recordsRejected",
      first_tick_time AS "firstTickTime",
      last_tick_time AS "lastTickTime",
      error_message AS "errorMessage",
      COALESCE(metadata, '{}'::jsonb) AS metadata
    FROM data_ingestion_runs
    WHERE source = 'deriv'
      AND COALESCE(metadata->>'supersededBy', '') = ''
    ORDER BY started_at DESC
    LIMIT ${Math.max(1, Math.min(50, limit))}
  `;

  return (rows as any[]).map((row: any) => ({
    runId: String(row.runId),
    symbol: String(row.symbol),
    requestedCount: Number(row.requestedCount || 0),
    requestedFrom: row.requestedFrom ? new Date(row.requestedFrom).toISOString() : null,
    requestedTo: row.requestedTo ? new Date(row.requestedTo).toISOString() : null,
    startedAt: new Date(row.startedAt).toISOString(),
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    status: row.status,
    recordsReceived: Number(row.recordsReceived || 0),
    recordsInserted: Number(row.recordsInserted || 0),
    recordsRejected: Number(row.recordsRejected || 0),
    firstTickTime: row.firstTickTime ? new Date(row.firstTickTime).toISOString() : null,
    lastTickTime: row.lastTickTime ? new Date(row.lastTickTime).toISOString() : null,
    errorMessage: row.errorMessage ? String(row.errorMessage) : null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
  }));
}

export async function getHistoricalIngestionCheckpoint(symbol?: string): Promise<HistoricalCheckpoint | null> {
  const dbUrl = getDbConnectionString();
  if (!dbUrl) return null;

  await initDbSchema();
  const sql: Sql = neon(dbUrl) as any;
  const rows = symbol
    ? await sql`
        SELECT source, asset_symbol, last_tick_epoch, last_tick_time, updated_at
        FROM data_ingestion_checkpoints
        WHERE source = 'deriv' AND asset_symbol = ${normalizeSymbol(symbol)}
        LIMIT 1
      `
    : await sql`
        SELECT source, asset_symbol, last_tick_epoch, last_tick_time, updated_at
        FROM data_ingestion_checkpoints
        WHERE source = 'deriv'
        ORDER BY updated_at DESC
        LIMIT 1
      `;

  if (!(rows as any[]).length) return null;
  const row: any = (rows as any[])[0];
  return {
    source: String(row.source),
    symbol: String(row.asset_symbol),
    lastTickEpoch: row.last_tick_epoch != null ? Number(row.last_tick_epoch) : null,
    lastTickTime: row.last_tick_time ? new Date(row.last_tick_time).toISOString() : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function clearHistoricalIngestionRuns(filter: 'all' | 'failed' | string[] = 'all'): Promise<{ deletedCount: number }> {
  const dbUrl = getDbConnectionString();
  if (!dbUrl) return { deletedCount: 0 };

  await initDbSchema();
  const sql: Sql = neon(dbUrl) as any;

  let rows: any[] = [];
  if (filter === 'failed') {
    rows = await sql`
      DELETE FROM data_ingestion_runs
      WHERE source = 'deriv' AND status = 'failed'
      RETURNING id
    `;
  } else if (Array.isArray(filter) && filter.length > 0) {
    rows = await sql`
      DELETE FROM data_ingestion_runs
      WHERE source = 'deriv' AND id = ANY(${filter})
      RETURNING id
    `;
  } else {
    rows = await sql`
      DELETE FROM data_ingestion_runs
      WHERE source = 'deriv'
      RETURNING id
    `;
  }

  return { deletedCount: rows.length };
}
