import { saveTicksBatch, getTicksHistory, initDbSchema } from '@/lib/db';
import WebSocket from 'ws';
import { openDerivPublicWebSocket } from '@/lib/deriv-public-websocket';
import { canonicalizeDerivSymbol } from '@/lib/deriv-symbol-utils';

export type TickPoint = { price: number; timestamp: number };

const inFlightTickHistory = new Map<string, Promise<TickPoint[]>>();

function buildTickHistoryFlightKey(symbol: string, count: number, end: number | 'latest'): string {
  const canonical = canonicalizeDerivSymbol(symbol);
  return `${canonical}:${count}:${String(end)}`;
}

async function fetchDerivTickHistoryUncoalesced(
  symbol: string,
  count: number,
  end: number | 'latest',
  retries: number,
): Promise<TickPoint[]> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt <= retries) {
    try {
      const ws = await openDerivPublicWebSocket(10_000);
      const result = await new Promise<TickPoint[]>((resolve, reject) => {
        let handled = false;
        let historyTicks: TickPoint[] | null = null;
        let liveTickRequested = false;
        const reqCount = Math.min(5000, Math.max(50, count));
        const timeout = setTimeout(() => {
          if (handled) return;
          handled = true;
          try { ws.close(); } catch {}
          reject(new Error(`Deriv tick history request timed out for ${symbol}.`));
        }, 12_000);
        const fail = (error: Error) => {
          if (handled) return;
          handled = true;
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          reject(error);
        };
        const complete = (ticks: TickPoint[]) => {
          handled = true;
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          resolve(ticks);
        };

        ws.send(JSON.stringify({ ticks_history: symbol, adjust_start_time: 1, count: reqCount, end, style: 'ticks', req_id: 1 }));
        ws.on('message', (data: WebSocket.Data) => {
          try {
            const res = JSON.parse(data.toString());
            if (res?.error) {
              const code = res.error.code ? ` (${res.error.code})` : '';
              fail(new Error(`Deriv tick history failed for ${symbol}${code}: ${String(res.error.message || 'Unknown Deriv error')}`));
              return;
            }

            if (res?.msg_type === 'history' || res?.history) {
              if (!res?.history || !Array.isArray(res.history.prices) || !Array.isArray(res.history.times)) return;
              const prices: number[] = res.history.prices;
              const times: number[] = res.history.times;
              historyTicks = prices.map((price, idx) => ({
                price: Number(price),
                timestamp: Number(times[idx] ?? 0) * 1000,
              })).filter((tick) => Number.isFinite(tick.price) && tick.price > 0 && Number.isFinite(tick.timestamp) && tick.timestamp > 0);
              if (!historyTicks.length) {
                fail(new Error(`Deriv returned no valid historical ticks for ${symbol}.`));
                return;
              }
              if (!liveTickRequested) {
                liveTickRequested = true;
                ws.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 2 }));
              }
              return;
            }

            if (res?.msg_type === 'tick' && res?.tick && historyTicks) {
              const price = Number(res.tick.quote);
              const epoch = Number(res.tick.epoch);
              if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(epoch) || epoch <= 0) {
                fail(new Error(`Deriv returned an invalid live tick for ${symbol}.`));
                return;
              }
              const liveTick: TickPoint = { price, timestamp: epoch * 1000 };
              const last = historyTicks[historyTicks.length - 1];
              if (!last || liveTick.timestamp >= last.timestamp) {
                complete([...historyTicks, liveTick]);
              } else {
                complete(historyTicks);
              }
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(`Invalid Deriv tick response for ${symbol}.`));
          }
        });
        ws.on('error', (error) => fail(error instanceof Error ? error : new Error(`Deriv WebSocket error while loading ${symbol}.`)));
        ws.on('close', (code, reason) => {
          if (!handled) {
            const reasonStr = reason ? ` (${reason.toString()})` : '';
            fail(new Error(`Deriv WebSocket closed before live data received (code ${code}${reasonStr}) for ${symbol}.`));
          }
        });
      });
      return result;
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      attempt++;
      if (attempt <= retries) {
        const backoffMs = attempt * 800 + Math.floor(Math.random() * 300);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  throw lastError || new Error(`Deriv tick history failed for ${symbol}.`);
}

export async function fetchDerivTickHistory(
  symbol: string,
  count: number = 1000,
  end: number | 'latest' = 'latest',
  retries = 2,
): Promise<TickPoint[]> {
  const normalizedSymbol = canonicalizeDerivSymbol(symbol);
  if (!normalizedSymbol) throw new Error('TICK_SYMBOL_REQUIRED');
  if (!Number.isInteger(count) || count <= 0) throw new Error('TICK_HISTORY_COUNT_INVALID');
  if (!Number.isInteger(retries) || retries < 0) throw new Error('TICK_HISTORY_RETRIES_INVALID');

  const key = buildTickHistoryFlightKey(normalizedSymbol, count, end);
  const existing = inFlightTickHistory.get(key);
  if (existing) return existing;

  const request = fetchDerivTickHistoryUncoalesced(normalizedSymbol, count, end, retries);
  inFlightTickHistory.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlightTickHistory.get(key) === request) inFlightTickHistory.delete(key);
  }
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
