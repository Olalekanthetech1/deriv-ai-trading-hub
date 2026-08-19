import { Client, neon, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

type WakeupChannel = 'dataset_jobs' | 'ml_training_jobs' | 'ml_sequence_training_jobs' | 'artifact_maintenance_jobs';

type ChannelConfig = { table: string; queuedPredicate?: string; updateStatus?: boolean };
const CHANNEL_CONFIG: Record<WakeupChannel, ChannelConfig> = {
  dataset_jobs: { table: 'ops_ml_dataset_build_jobs', updateStatus: false },
  ml_training_jobs: { table: 'ml_training_job_queue', queuedPredicate: "NEW.status = 'queued'", updateStatus: true },
  ml_sequence_training_jobs: { table: 'ml_sequence_training_job_queue', queuedPredicate: "NEW.status = 'queued'", updateStatus: true },
  artifact_maintenance_jobs: { table: 'ml_artifact_maintenance_jobs', queuedPredicate: "NEW.status = 'queued'", updateStatus: true },
};

function connectionString(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('[Background Wakeup] DATABASE_URL is required.');
  return value;
}

export async function ensureBackgroundJobWakeupTriggers(): Promise<void> {
  const sql = neon(connectionString());
  await sql`
    CREATE OR REPLACE FUNCTION ops_notify_background_job()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM pg_notify(TG_ARGV[0], row_to_json(NEW)::text);
      RETURN NEW;
    END;
    $$
  `;

  for (const [channel, config] of Object.entries(CHANNEL_CONFIG) as Array<[WakeupChannel, ChannelConfig]>) {
    const triggerName = `trg_${channel}`;
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON ${config.table}`);
    const timing = config.updateStatus ? 'AFTER INSERT OR UPDATE OF status' : 'AFTER INSERT';
    await sql.unsafe(`
      CREATE TRIGGER ${triggerName}
      ${timing} ON ${config.table}
      FOR EACH ROW
      ${config.queuedPredicate ? `WHEN (${config.queuedPredicate})` : ''}
      EXECUTE FUNCTION ops_notify_background_job('${channel}')
    `);
  }
}

export async function startBackgroundJobWakeupListener(
  channel: WakeupChannel,
  onWake: () => void,
): Promise<() => Promise<void>> {
  const databaseUrl = connectionString();
  let stopped = false;
  let client: Client | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = 1000;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(30000, reconnectDelayMs * 2);
  };

  const connect = async () => {
    if (stopped || client) return;
    const nextClient = new Client(databaseUrl);
    client = nextClient;
    try {
      nextClient.on('notification', (message: { channel?: string }) => {
        if (message.channel === channel && !stopped) onWake();
      });
      nextClient.on('error', (error: unknown) => {
        console.error(`[Background Wakeup] ${channel} listener error:`, error);
        if (client === nextClient) client = null;
        scheduleReconnect();
      });
      await nextClient.connect();
      await nextClient.query(`LISTEN ${channel}`);
      reconnectDelayMs = 1000;
      console.log(`[Background Wakeup] listening on ${channel}`);
    } catch (error) {
      console.error(`[Background Wakeup] ${channel} connection failed:`, error);
      if (client === nextClient) client = null;
      try { await nextClient.end(); } catch { /* best effort */ }
      scheduleReconnect();
    }
  };

  await connect();

  return async () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const current = client;
    client = null;
    if (current) {
      try { await current.query(`UNLISTEN ${channel}`); } catch { /* best effort */ }
      try { await current.end(); } catch { /* best effort */ }
    }
  };
}
