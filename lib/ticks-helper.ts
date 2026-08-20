import { saveTicksBatch, getTicksHistory, initDbSchema } from '@/lib/db';
import WebSocket from 'ws';
import { openDerivPublicWebSocket } from '@/lib/deriv-public-websocket';

export type TickPoint = { price: number; timestamp: number };

const tickHistoryInFlight = new Map<string, Promise<TickPoint[]>>();

async function fetchDerivTickHistoryOnce(
  symbol: string,
  count: number,
  end: number | 'latest',
): Promise<TickPoint[]> {
  const ws = await openDerivPublicWebSocket(10_000);
  return new Promise<TickPoint[]>((resolve, reject) => {
    let handled = false;
    const reqCount = Math.min(5000, Math.max(50, count));
    const timeout = setTimeout(() => {
      if (handled) return;
      handled = true;
      try { ws.close(); } catch {}
      reject(new Error(`Deriv tick history request timed out for ${symbol}.`));
    }, 12_000);
    const finish = (fn: (value: TickPoint[] | Error) => void, value: TickPoint[] | Error) => {
      if (handled) return;
      handled = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      fn(value);
    };
    const fail = (error: Error) => finish(reject, error);

    ws.send(JSON.stringify({ ticks_history: symbol, adjust_start_time: 1, count: reqCount, end, style: 'ticks', req_id: 1 }));
    ws.on('message', (data: WebSocket.Data) => {
      try {
        const res = JSON.parse(data.toString());
        if (res?.error) {
          const code = res.error.code ? ` (${res.error.code})` : '';
          fail(new Error(`Deriv tick history failed for ${symbol}${code}: ${String(res.error.message || 'Unknown Deriv error')}`));
          return;
        }
        if (res?.msg_type !== 'history' && !res?.history) return;
        if (res?.history && Array.isArray(res.history.prices) && Array.isArray(res.history.times)) {
          const prices: number[] = res.history.prices;
          const times: number[] = res.history.times;
          const ticks = prices.map((price, idx) => ({
            price: Number(price),
            timestamp: Number(times[idx] ?? 0) * 1000,
          })).filter((tick) => Number.isFinite(tick.price) && tick.price > 0 && Number.isFinite(tick.timestamp) && tick.timestamp > 0);
          if (!ticks.length) {
            fail(new Error(`Deriv returned no valid historical ticks for ${symbol}.`));
            return;
          }
          finish(resolve, ticks);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(`Invalid Deriv tick history response for ${symbol}.`));
      }
    });
    ws.on('error', (error) => fail(error instanceof Error ? error : new Error(`Deriv WebSocket error while loading ${symbol}.`)));
    ws.on('close', (code, reason) => {
      if (!handled) {
        const reasonStr = reason ? ` (${reason.toString()})` : '';
        fail(new Error(`Deriv WebSocket closed before data received (code ${code}${reasonStr}) for ${symbol}.`));
      }
    });
  });
}

export async function fetchDerivTickHistory(
  symbol: string,
  count: number = 1000,
  end: number | 'latest' = 'latest',
  retries = 2,
): Promise<TickPoint[]> {
  const normalizedSymbol = String(symbol ?? '').trim().toUpperCase();
  if (!normalizedSymbol) throw new Error('DERIV_SYMBOL_REQUIRED');

  const existing = tickHistoryInFlight.get(normalizedSymbol);
  if (existing) return existing;

  const promise = (async (): Promise<TickPoint[]> => {
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= retries) {
      try {
        return await fetchDerivTickHistoryOnce(normalizedSymbol, count, end);
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        attempt++;
        if (attempt <= retries) {
          const backoffMs = attempt * 800 + Math.floor(Math.random() * 300);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw lastError || new Error(`Deriv tick history failed for ${normalizedSymbol}.`);
  })();

  tickHistoryInFlight.set(normalizedSymbol, promise);
  promise.finally(() => {
    if (tickHistoryInFlight.get(normalizedSymbol) === promise) {
      tickHistoryInFlight.delete(normalizedSymbol);
    }
  }).catch(() => undefined);

  return promise;
}

export async function ensureMinTicks(symbol: string, minRequired: number = 100, forceDerivFetch = false) {
  if (!Number.isInteger(minRequired) || minRequired <= 0) throw new Error('TICK_REQUIREMENT_INVALID');

  if (forceDerivFetch) {
    const liveTicks = await fetchDerivTickHistory(symbol, Math.max(1000, minRequired), 'latest');
    return liveTicks;
  }

  await initDbSchema();
  let dbTicks = await getTicksHistory(symbol, Math.max(1000, minRequired));
  if (!dbTicks || dbTicks.length < minRequired) {
    const realDerivTicks = await fetchDerivTickHistory(symbol, Math.max(1000, minRequired), 'latest');
    await saveTicksBatch(symbol, realDerivTicks);
    dbTicks = await getTicksHistory(symbol, Math.max(1000, minRequired));
    if (!dbTicks || dbTicks.length < minRequired) return realDerivTicks;
  }
  return dbTicks;
}
