'use client';

import { useEffect, useRef } from 'react';
import type { DerivWS } from '@deriv/core';

/**
 * Automated Tick Recorder Hook
 * Streams incoming live ticks into the PostgreSQL database in small background batches,
 * and fetches historical ticks on symbol load.
 */
export function useTickRecorder(
  symbol: string | undefined,
  currentTick: { price: number; timestamp?: number } | null,
  ws?: DerivWS | null
) {
  const bufferRef = useRef<Array<{ price: number; timestamp: number }>>([]);
  const lastProcessedTimeRef = useRef<number>(0);
  const symbolRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!symbol || !ws || symbol === symbolRef.current) return;
    symbolRef.current = symbol;

    ws.send({
      ticks_history: symbol,
      end: 'latest',
      count: 100,
      style: 'ticks'
    }).then((res: any) => {
      if (res.history && res.history.prices && res.history.times) {
        const prices = res.history.prices;
        const times = res.history.times;
        const ticks = prices.map((price: number, i: number) => ({
          price,
          timestamp: times[i] * 1000 // Convert to ms
        }));

        fetch('/api/db/ticks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, ticks }),
        }).catch(err => console.warn('[Tick History Pre-fetch Error]:', err));
      }
    }).catch(() => {
      // ignore
    });
  }, [symbol, ws]);

  useEffect(() => {
    if (!symbol || !currentTick || !currentTick.price) return;

    const ts = currentTick.timestamp || Date.now();
    if (ts <= lastProcessedTimeRef.current) return;

    lastProcessedTimeRef.current = ts;
    bufferRef.current.push({ price: currentTick.price, timestamp: ts });

    // Flush batch to database every 5 ticks or when buffer gets large
    if (bufferRef.current.length >= 5) {
      const batchToSend = [...bufferRef.current];
      bufferRef.current = [];

      fetch('/api/db/ticks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          ticks: batchToSend,
        }),
      }).catch((err) => {
        console.warn('[Tick Recorder Background Error]:', err);
      });
    }
  }, [symbol, currentTick]);
}
