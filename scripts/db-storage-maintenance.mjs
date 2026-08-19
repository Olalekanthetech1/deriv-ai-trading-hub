import { neon } from '@neondatabase/serverless';

const dbUrl = process.env.DATABASE_URL?.trim();
if (!dbUrl) {
  console.error('[DB Storage] DATABASE_URL is required.');
  process.exit(1);
}

const sql = neon(dbUrl);
const args = new Set(process.argv.slice(2));
const retentionArg = process.argv.find((arg) => arg.startsWith('--retention-hours='));
const retentionHours = retentionArg ? Number(retentionArg.split('=')[1]) : null;
const batchSizeArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
const batchSize = batchSizeArg ? Math.max(100, Math.min(10000, Number(batchSizeArg.split('=')[1]))) : 5000;

if (retentionArg && (!Number.isFinite(retentionHours) || retentionHours <= 0)) {
  console.error('[DB Storage] --retention-hours must be a positive number.');
  process.exit(1);
}

async function audit() {
  const sizes = await sql`
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      pg_total_relation_size(c.oid) AS total_bytes,
      pg_relation_size(c.oid) AS table_bytes,
      pg_indexes_size(c.oid) AS index_bytes,
      c.reltuples::bigint AS estimated_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'm')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY pg_total_relation_size(c.oid) DESC
  `;

  console.log('\n[DB Storage] Relation sizes');
  for (const row of sizes) {
    console.log(
      `${row.schema_name}.${row.table_name} ` +
      `total=${formatBytes(row.total_bytes)} ` +
      `table=${formatBytes(row.table_bytes)} ` +
      `indexes=${formatBytes(row.index_bytes)} ` +
      `estimated_rows=${row.estimated_rows}`
    );
  }

  const tickStats = await sql`
    SELECT
      COUNT(*)::bigint AS rows,
      MIN(tick_time) AS oldest_tick,
      MAX(tick_time) AS newest_tick
    FROM market_ticks
  `.catch(() => []);

  if (tickStats.length) {
    const row = tickStats[0];
    console.log('\n[DB Storage] market_ticks');
    console.log(`rows=${row.rows}`);
    console.log(`oldest_tick=${row.oldest_tick ?? 'n/a'}`);
    console.log(`newest_tick=${row.newest_tick ?? 'n/a'}`);
  }

  const growth = await sql`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour')::bigint AS last_hour,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::bigint AS last_24_hours,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::bigint AS last_7_days
    FROM market_ticks
  `.catch(() => []);

  if (growth.length) {
    const row = growth[0];
    console.log('\n[DB Storage] market_ticks growth');
    console.log(`last_hour=${row.last_hour}`);
    console.log(`last_24_hours=${row.last_24_hours}`);
    console.log(`last_7_days=${row.last_7_days}`);
  }
}

async function pruneTicks() {
  if (retentionHours == null) {
    console.error('[DB Storage] Refusing to prune without an explicit --retention-hours value.');
    process.exit(2);
  }

  console.log(`\n[DB Storage] PRUNE MODE: deleting market_ticks older than ${retentionHours} hours in batches of ${batchSize}.`);
  console.log('[DB Storage] This is destructive. Training data must already be preserved elsewhere before running this mode.');

  let deletedTotal = 0;
  while (true) {
    const result = await sql`
      WITH doomed AS (
        SELECT id
        FROM market_ticks
        WHERE tick_time < NOW() - (${retentionHours} * INTERVAL '1 hour')
        ORDER BY tick_time ASC
        LIMIT ${batchSize}
      )
      DELETE FROM market_ticks mt
      USING doomed
      WHERE mt.id = doomed.id
      RETURNING mt.id
    `;

    deletedTotal += result.length;
    console.log(`[DB Storage] deleted=${result.length} total_deleted=${deletedTotal}`);

    if (result.length < batchSize) break;
  }

  await sql`VACUUM (ANALYZE) market_ticks`;
  console.log(`[DB Storage] prune complete; deleted ${deletedTotal} rows.`);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

try {
  await audit();
  if (args.has('--prune-ticks')) {
    await pruneTicks();
  }
} catch (error) {
  console.error('[DB Storage] maintenance failed:', error);
  process.exit(1);
}
