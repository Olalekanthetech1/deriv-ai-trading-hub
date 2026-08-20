import { neon } from '@neondatabase/serverless';
import { getDbConnectionString, initDbSchema } from '@/lib/db';
import {
  getHistoricalIngestionCheckpoint,
  ingestDerivHistoricalTicks,
  purgeMarketTicksForSymbol,
  type HistoricalIngestionRun,
} from '@/lib/deriv-historical-ingestion';

type Sql = any;

type StoredRunRow = {
  runId: string;
  symbol: string;
  requestedCount: number;
  requestedFrom: string | null;
  requestedTo: string | null;
  startedAt: string;
  completedAt: string | null;
  status: HistoricalIngestionRun['status'];
  recordsReceived: number;
  recordsInserted: number;
  recordsRejected: number;
  firstTickTime: string | null;
  lastTickTime: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
};

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function normalizeSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map(normalizeSymbol).filter((symbol) => /^[A-Z0-9_./:-]{2,64}$/.test(symbol)))];
}

async function getLatestLogicalRun(sql: Sql, symbol: string): Promise<StoredRunRow | null> {
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
      AND COALESCE(metadata->>'supersededBy', '') = ''
    ORDER BY started_at DESC
    LIMIT 1
  `) as any[];

  if (!rows.length) return null;
  const row = rows[0];
  return {
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
  };
}

async function getStoredTickCount(sql: Sql, symbol: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::bigint AS count
    FROM market_ticks
    WHERE source = 'deriv' AND symbol = ${symbol}
  `) as Array<{ count?: number | string | null }>;
  return Math.max(0, Number(rows[0]?.count || 0));
}

function readBatches(metadata: Record<string, unknown>): unknown[] {
  return Array.isArray(metadata.batches) ? metadata.batches : [];
}

function minTime(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

function maxTime(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

export async function ingestDerivHistoricalBackfill(input: {
  symbol: string;
  targetCount: number;
  freshIngest?: boolean;
}) {
  const dbUrl = getDbConnectionString();
  if (!dbUrl) throw new Error('DATABASE_URL is required for ingestion.');

  const symbol = normalizeSymbol(input.symbol);
  const targetCount = Math.min(50_000, Math.max(50, Math.floor(input.targetCount)));

  await initDbSchema();
  const sql: Sql = neon(dbUrl) as any;

  if (input.freshIngest) {
    await purgeMarketTicksForSymbol(symbol, { reason: 'fresh_ingest_backfill' });
  }

  const currentCount = input.freshIngest ? 0 : await getStoredTickCount(sql, symbol);
  const latestRun = input.freshIngest ? null : await getLatestLogicalRun(sql, symbol);

  if (currentCount >= targetCount) {
    if (!latestRun) {
      return {
        success: true,
        symbol,
        requestedCount: targetCount,
        recordsReceived: currentCount,
        recordsInserted: currentCount,
        recordsRejected: 0,
        status: 'completed' as const,
        resumedExistingSession: false,
        progress: { requested: targetCount, received: currentCount, inserted: currentCount, rejected: 0, percent: 100, remaining: 0 },
      };
    }

    if (latestRun.requestedCount !== targetCount || latestRun.recordsInserted !== currentCount || latestRun.status !== 'completed') {
      await sql`
        UPDATE data_ingestion_runs
        SET requested_to = COALESCE(requested_to, NOW()),
            status = 'completed',
            records_inserted = ${currentCount},
            error_message = NULL,
            completed_at = COALESCE(completed_at, NOW()),
            metadata = jsonb_set(
              jsonb_set(COALESCE(metadata, '{}'::jsonb), '{requestedCount}', to_jsonb(${targetCount}::int)),
              '{cumulativeProgress}',
              ${JSON.stringify({ requested: targetCount, received: Math.max(latestRun.recordsReceived, currentCount), inserted: currentCount, rejected: latestRun.recordsRejected, percent: 100 })}::jsonb
            )
        WHERE id = ${latestRun.runId}
      `;
    }

    return {
      ...latestRun,
      requestedCount: targetCount,
      recordsInserted: currentCount,
      status: 'completed' as const,
      resumedExistingSession: true,
      progress: { requested: targetCount, received: Math.max(latestRun.recordsReceived, currentCount), inserted: currentCount, rejected: latestRun.recordsRejected, percent: 100, remaining: 0 },
    };
  }

  const missingCount = targetCount - currentCount;
  const checkpoint = await getHistoricalIngestionCheckpoint(symbol);
  const endEpoch = checkpoint?.lastTickEpoch ? Math.max(1, Math.floor(checkpoint.lastTickEpoch) - 1) : undefined;
  const batchRun = await ingestDerivHistoricalTicks({ symbol, count: missingCount, resumeFromCheckpoint: false, endEpoch });

  if (!latestRun) {
    return {
      ...batchRun,
      requestedCount: targetCount,
      resumedExistingSession: false,
      progress: { ...batchRun.progress, requested: targetCount, remaining: Math.max(0, targetCount - batchRun.recordsInserted) },
    };
  }

  const batchMetadata = batchRun.metadata && typeof batchRun.metadata === 'object' ? batchRun.metadata : {};
  const mergedBatches = [...readBatches(latestRun.metadata), ...readBatches(batchMetadata)];
  const totalInserted = await getStoredTickCount(sql, symbol);
  const totalReceived = latestRun.recordsReceived + batchRun.recordsReceived;
  const totalRejected = latestRun.recordsRejected + batchRun.recordsRejected;
  const status = totalInserted >= targetCount ? 'completed' : (totalInserted > 0 ? 'partial' : 'failed');
  const completedAt = batchRun.completedAt || new Date().toISOString();
  const firstTickTime = minTime(latestRun.firstTickTime, batchRun.firstTickTime);
  const lastTickTime = maxTime(latestRun.lastTickTime, batchRun.lastTickTime);
  const cumulativeProgress = {
    requested: targetCount,
    received: totalReceived,
    inserted: totalInserted,
    rejected: totalRejected,
    percent: Math.min(100, Number(((totalInserted / targetCount) * 100).toFixed(2))),
  };

  await sql`
    UPDATE data_ingestion_runs
    SET requested_to = COALESCE(requested_to, ${batchRun.requestedTo}),
        completed_at = ${completedAt},
        status = ${status},
        records_received = ${totalReceived},
        records_inserted = ${totalInserted},
        records_rejected = ${totalRejected},
        first_tick_time = ${firstTickTime},
        last_tick_time = ${lastTickTime},
        error_message = NULL,
        metadata = ${JSON.stringify({ ...latestRun.metadata, requestedCount: targetCount, resumedAt: new Date().toISOString(), cumulativeProgress, batches: mergedBatches })}::jsonb
    WHERE id = ${latestRun.runId}
  `;

  await sql`
    UPDATE data_ingestion_runs
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{supersededBy}', to_jsonb(${latestRun.runId}::text))
    WHERE id = ${batchRun.runId}
  `;

  return {
    ...latestRun,
    requestedCount: targetCount,
    completedAt,
    status,
    recordsReceived: totalReceived,
    recordsInserted: totalInserted,
    recordsRejected: totalRejected,
    firstTickTime,
    lastTickTime,
    errorMessage: null,
    metadata: { ...latestRun.metadata, requestedCount: targetCount, cumulativeProgress, batches: mergedBatches },
    resumedExistingSession: true,
    progress: { ...cumulativeProgress, remaining: Math.max(0, targetCount - totalInserted) },
  };
}

export async function ingestDerivHistoricalBatch(input: {
  symbols: string[];
  targetCount: number;
  resumeFromCheckpoint: boolean;
  freshIngest?: boolean;
  concurrency: number;
}) {
  const symbols = normalizeSymbols(input.symbols);
  if (!symbols.length) throw new Error('At least one valid Deriv symbol is required.');

  const concurrency = Math.max(1, Math.floor(input.concurrency));
  const results: Array<{ symbol: string; success: boolean; status: string; recordsInserted: number; requestedCount: number; errorMessage: string | null }> = [];

  for (let index = 0; index < symbols.length; index += concurrency) {
    const chunk = symbols.slice(index, index + concurrency);
    const chunkResults = await Promise.all(chunk.map(async (symbol) => {
      try {
        let result: any;
        if (input.freshIngest) {
          result = await ingestDerivHistoricalTicks({ symbol, count: input.targetCount, resumeFromCheckpoint: false, freshIngest: true });
        } else if (input.resumeFromCheckpoint) {
          result = await ingestDerivHistoricalBackfill({ symbol, targetCount: input.targetCount });
        } else {
          const checkpoint = await getHistoricalIngestionCheckpoint(symbol);
          const endEpoch = checkpoint?.lastTickEpoch ? Math.max(1, Math.floor(checkpoint.lastTickEpoch) - 1) : undefined;
          result = await ingestDerivHistoricalTicks({ symbol, count: input.targetCount, resumeFromCheckpoint: false, endEpoch });
        }
        return {
          symbol,
          success: true,
          status: String(result.status || 'completed'),
          recordsInserted: Number(result.progress?.inserted ?? result.recordsInserted ?? 0),
          requestedCount: Number(result.progress?.requested ?? result.requestedCount ?? input.targetCount),
          errorMessage: result.errorMessage ? String(result.errorMessage) : null,
        };
      } catch (error) {
        return {
          symbol,
          success: false,
          status: 'failed',
          recordsInserted: 0,
          requestedCount: input.targetCount,
          errorMessage: error instanceof Error ? error.message : 'Historical ingestion failed.',
        };
      }
    }));
    results.push(...chunkResults);
  }

  const completed = results.filter((result) => result.success && result.status === 'completed').length;
  const partial = results.filter((result) => result.success && result.status === 'partial').length;
  const failed = results.filter((result) => !result.success || result.status === 'failed').length;

  return {
    success: failed === 0,
    status: failed === symbols.length ? 'failed' : failed > 0 || partial > 0 ? 'partial' : 'completed',
    requestedAssets: symbols.length,
    completedAssets: completed,
    partialAssets: partial,
    failedAssets: failed,
    results,
  };
}
