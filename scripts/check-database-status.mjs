import { getDb } from '../lib/db.ts';
import { mlRuntimeClient } from '../lib/ml-runtime-client.ts';

async function run() {
  const sql = getDb();
  if (!sql) {
    console.error('Database connection could not be established. DATABASE_URL is probably missing.');
    return;
  }
  
  try {
    console.log('--- PINGING ML RUNTIME CLIENT ---');
    try {
      const pingRes = await mlRuntimeClient.sendCommand('ping');
      console.log('Ping response:', pingRes);
    } catch (err) {
      console.error('Ping failed:', err);
    }

    const models = await sql`
      SELECT model_id, asset_symbol, duration_value, duration_unit, status, updated_at 
      FROM ml_model_registry_v2
      ORDER BY updated_at DESC
      LIMIT 3
    `;
    console.log('--- LATEST registered models ---');
    console.table(models);
    
    const productionModels = await sql`
      SELECT model_id, asset_symbol, duration_value, duration_unit, status, updated_at 
      FROM ml_model_registry_v2
      WHERE status = 'production' AND asset_symbol = 'JD75'
      ORDER BY updated_at DESC
      LIMIT 10
    `;
    console.log('\n--- ACTIVE PRODUCTION MODELS FOR JD75 ---');
    console.table(productionModels);
    
    const ticksCount = await sql`
      SELECT symbol, COUNT(*)::int AS tick_count, MAX(tick_time) AS latest_tick
      FROM market_ticks
      GROUP BY symbol
      LIMIT 3
    `;
    console.log('\n--- TICK COUNTS BY SYMBOL ---');
    console.table(ticksCount);

    const logs = await sql`
      SELECT message, metadata, created_at
      FROM admin_observability_events
      WHERE event_type = 'signal_prediction_failed'
      ORDER BY created_at DESC
      LIMIT 3
    `;
    console.log('\n--- FAILED SIGNAL PREDICTIONS ---');
    console.log(JSON.stringify(logs, null, 2));

  } catch (error) {
    console.error('Error querying database:', error);
  } finally {
    process.exit(0);
  }
}

run();
