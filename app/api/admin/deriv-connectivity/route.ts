import { NextRequest, NextResponse } from 'next/server';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import WebSocket from 'ws';
import { verifySessionToken } from '../auth/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 40;

const DEFAULT_ENDPOINT = 'wss://api.derivws.com/trading/v1/options/ws/public';
const DEFAULT_TIMEOUT_MS = 10_000;

function isAuthorized(req: NextRequest): boolean {
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function serializeError(error: unknown): { name: string; message: string; code?: string; errno?: number; syscall?: string; address?: string; port?: number } {
  const value = error as NodeJS.ErrnoException | undefined;
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(value?.code ? { code: String(value.code) } : {}),
    ...(typeof value?.errno === 'number' ? { errno: value.errno } : {}),
    ...(value?.syscall ? { syscall: String(value.syscall) } : {}),
    ...(value?.address ? { address: String(value.address) } : {}),
    ...(typeof value?.port === 'number' ? { port: value.port } : {}),
  };
}

async function resolveHost(hostname: string) {
  const started = process.hrtime.bigint();
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    return { ok: true, elapsedMs: Number(elapsedMs(started).toFixed(2)), addresses };
  } catch (error) {
    return { ok: false, elapsedMs: Number(elapsedMs(started).toFixed(2)), error: serializeError(error) };
  }
}

function tcpProbe(host: string, port: number, timeoutMs: number) {
  const started = process.hrtime.bigint();
  return new Promise<Record<string, unknown>>((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, elapsedMs: Number(elapsedMs(started).toFixed(2)) });
    };
    const timer = setTimeout(() => finish({ ok: false, phase: 'tcp_connect', error: { name: 'TimeoutError', message: `TCP connection timed out after ${timeoutMs}ms`, code: 'ETIMEDOUT' } }), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      finish({ ok: true, phase: 'tcp_connect', remoteAddress: socket.remoteAddress, remoteFamily: socket.remoteFamily, remotePort: socket.remotePort });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, phase: 'tcp_connect', error: serializeError(error) });
    });
  });
}

function tlsProbe(host: string, port: number, timeoutMs: number) {
  const started = process.hrtime.bigint();
  return new Promise<Record<string, unknown>>((resolve) => {
    let settled = false;
    const socket = tls.connect({ host, port, servername: host, ALPNProtocols: ['http/1.1'] });
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, elapsedMs: Number(elapsedMs(started).toFixed(2)) });
    };
    const timer = setTimeout(() => finish({ ok: false, phase: 'tls_handshake', error: { name: 'TimeoutError', message: `TLS handshake timed out after ${timeoutMs}ms`, code: 'ETIMEDOUT' } }), timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      finish({
        ok: true,
        phase: 'tls_handshake',
        protocol: socket.getProtocol(),
        cipher: socket.getCipher()?.name,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError || null,
        alpnProtocol: socket.alpnProtocol || null,
      });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, phase: 'tls_handshake', error: serializeError(error) });
    });
  });
}

function webSocketProbe(endpoint: string, timeoutMs: number) {
  const started = process.hrtime.bigint();
  return new Promise<Record<string, unknown>>((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      try { socket?.removeAllListeners(); } catch {}
      try { socket?.terminate(); } catch {}
      resolve({ ...result, elapsedMs: Number(elapsedMs(started).toFixed(2)) });
    };

    const timer = setTimeout(() => finish({
      ok: false,
      phase: 'websocket_upgrade',
      error: {
        name: 'TimeoutError',
        message: `WebSocket upgrade timed out after ${timeoutMs}ms`,
        code: 'WS_UPGRADE_TIMEOUT',
      },
    }), timeoutMs);

    try {
      socket = new WebSocket(endpoint, {
        handshakeTimeout: timeoutMs,
        headers: { 'User-Agent': 'MarketDataIngestionEngine/2.0' },
      });
      socket.once('open', () => {
        clearTimeout(timer);
        finish({ ok: true, phase: 'websocket_upgrade', readyState: socket?.readyState, protocol: socket?.protocol || null });
      });
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        finish({ ok: false, phase: 'websocket_upgrade', httpStatus: response.statusCode, httpStatusMessage: response.statusMessage || null, headers: response.headers });
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        finish({ ok: false, phase: 'websocket_upgrade', error: serializeError(error) });
      });
      socket.once('close', (code, reason) => {
        clearTimeout(timer);
        finish({ ok: false, phase: 'websocket_upgrade', closeCode: code, closeReason: reason?.toString() || '' });
      });
    } catch (error) {
      clearTimeout(timer);
      finish({ ok: false, phase: 'websocket_upgrade', error: serializeError(error) });
    }
  });
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const endpoint = process.env.DERIV_PUBLIC_WS_URL?.trim() || DEFAULT_ENDPOINT;
  const timeoutMsRaw = Number(req.nextUrl.searchParams.get('timeoutMs') || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.min(20_000, Math.max(2_000, Math.floor(timeoutMsRaw))) : DEFAULT_TIMEOUT_MS;

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
    if (parsed.protocol !== 'wss:') throw new Error('DERIV_PUBLIC_WS_URL_MUST_USE_WSS');
  } catch (error) {
    return NextResponse.json({ success: false, error: serializeError(error), endpoint }, { status: 500 });
  }

  const started = process.hrtime.bigint();
  const dnsResult = await resolveHost(parsed.hostname);
  const tcpResult = dnsResult.ok ? await tcpProbe(parsed.hostname, Number(parsed.port || 443), timeoutMs) : { ok: false, phase: 'tcp_connect', skipped: true, reason: 'DNS resolution failed' };
  const tlsResult = tcpResult.ok ? await tlsProbe(parsed.hostname, Number(parsed.port || 443), timeoutMs) : { ok: false, phase: 'tls_handshake', skipped: true, reason: 'TCP connection failed' };
  const websocketResult = tlsResult.ok ? await webSocketProbe(endpoint, timeoutMs) : { ok: false, phase: 'websocket_upgrade', skipped: true, reason: 'TLS handshake failed' };

  const failedPhase = !dnsResult.ok
    ? 'dns_resolution'
    : !tcpResult.ok
      ? 'tcp_connect'
      : !tlsResult.ok
        ? 'tls_handshake'
        : !websocketResult.ok
          ? 'websocket_upgrade'
          : null;

  return NextResponse.json({
    success: failedPhase === null,
    endpoint,
    hostname: parsed.hostname,
    port: Number(parsed.port || 443),
    timeoutMs,
    failedPhase,
    totalElapsedMs: Number(elapsedMs(started).toFixed(2)),
    probes: { dns: dnsResult, tcp: tcpResult, tls: tlsResult, websocket: websocketResult },
    guidance: failedPhase === null
      ? 'Render can resolve, connect, negotiate TLS, and complete the Deriv WebSocket upgrade.'
      : `Connectivity failed during ${failedPhase}. Do not change the Deriv endpoint until this phase is resolved.`,
    timestamp: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
