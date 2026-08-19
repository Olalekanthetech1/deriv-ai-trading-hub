import WebSocket from 'ws';

const DEFAULT_PUBLIC_WS_ENDPOINT = 'wss://api.derivws.com/trading/v1/options/ws/public';

export function getDerivPublicWebSocketUrls(): string[] {
  const configured = process.env.DERIV_PUBLIC_WS_URL?.trim();
  if (!configured) return [DEFAULT_PUBLIC_WS_ENDPOINT];
  const parsed = new URL(configured);
  if (parsed.protocol !== 'wss:') {
    throw new Error('DERIV_PUBLIC_WS_URL_MUST_USE_WSS');
  }
  return [parsed.toString()];
}

export function getDerivPublicWebSocketUrl(): string {
  return getDerivPublicWebSocketUrls()[0];
}

async function connectToEndpoint(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws: WebSocket | null = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws?.close(); } catch {}
      reject(new Error(`WebSocket connection to ${url} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    try {
      ws = new WebSocket(url, {
        handshakeTimeout: timeoutMs,
        headers: { 'User-Agent': 'MarketDataIngestionEngine/2.0' },
      });

      ws.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(ws as WebSocket);
      });
      ws.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { ws?.close(); } catch {}
        reject(error instanceof Error ? error : new Error(`WebSocket connection failed for ${url}`));
      });
      ws.once('close', (code, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const reasonStr = reason ? ` (${reason.toString()})` : '';
        reject(new Error(`WebSocket closed before connection was established: code ${code}${reasonStr}`));
      });
    } catch (error) {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(`Unable to instantiate WebSocket for ${url}`));
    }
  });
}

export async function openDerivPublicWebSocket(timeoutMs = 10_000): Promise<WebSocket> {
  const urls = getDerivPublicWebSocketUrls();
  return connectToEndpoint(urls[0], timeoutMs);
}
