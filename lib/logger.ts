import pino from 'pino';
import { redisClient } from '@/lib/rate-limiter';

const pinoLogger = pino(
  process.env.NODE_ENV !== 'production'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
          },
        },
      }
    : {}
);

export const logger = {
  info: async (msg: string, meta?: any) => {
    pinoLogger.info(meta, msg);
    await persistLog('info', msg, meta);
  },
  warn: async (msg: string, meta?: any) => {
    pinoLogger.warn(meta, msg);
    await persistLog('warn', msg, meta);
  },
  error: async (msg: string, meta?: any) => {
    pinoLogger.error(meta, msg);
    await persistLog('error', msg, meta);
  },
};

async function persistLog(level: string, message: string, meta?: any) {
  if (redisClient) {
    try {
      const logEntry = JSON.stringify({
        level,
        message,
        meta,
        timestamp: new Date().toISOString(),
      });
      await redisClient.lpush('recent_system_logs', logEntry);
      await redisClient.ltrim('recent_system_logs', 0, 99); // Keep latest 100
    } catch (err) {
      // ignore
    }
  }
}
