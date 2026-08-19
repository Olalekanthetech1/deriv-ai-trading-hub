import WebSocket from 'ws';
import { openDerivPublicWebSocket } from './deriv-public-websocket';
import { DERIV_TIME_DURATION_BANDS, type DerivTimeDurationUnit } from './deriv-duration-policy';

export type DerivDurationUnit = 't' | 's' | 'm' | 'h' | 'd';
export type DerivDurationRange = { id: string; unit: DerivDurationUnit; min: number; max: number; step: number; tradeTypes: string[]; source: 'deriv-proposal-probe' };
export type DerivDurationDiscovery = { symbol: string; ranges: DerivDurationRange[]; fetchedAt: string; source: 'deriv-proposal-probe'; warning?: string };
type RecordLike = Record<string, unknown>;
type ContractCapability = { type: 'CALL' | 'PUT'; expiryType: string; probe: Record<string, unknown> };

const MAX_PROBE: Record<DerivDurationUnit, number> = { t: 1000, s: DERIV_TIME_DURATION_BANDS.s.max, m: DERIV_TIME_DURATION_BANDS.m.max, h: DERIV_TIME_DURATION_BANDS.h.max, d: DERIV_TIME_DURATION_BANDS.d.max };
const MIN_PROBE: Record<DerivDurationUnit, number> = { t: 1, s: DERIV_TIME_DURATION_BANDS.s.min, m: DERIV_TIME_DURATION_BANDS.m.min, h: DERIV_TIME_DURATION_BANDS.h.min, d: DERIV_TIME_DURATION_BANDS.d.min };
const PROBE_SEEDS: Record<DerivDurationUnit, number[]> = {
  t: [1, 2, 3, 5, 10, 15, 20, 30, 60, 100, 200, 500, 1000],
  s: [15, 20, 30, 60],
  m: [1, 2, 5, 10, 15, 30, 60],
  h: [1, 2, 4, 6, 12, 24],
  d: [1, 2, 3, 5, 7, 14, 30, 60, 90, 180, 365],
};
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const configuredProbeInterval = Number(process.env.DERIV_DISCOVERY_PROBE_INTERVAL_MS);
const PROBE_INTERVAL_MS = Number.isFinite(configuredProbeInterval)
  ? Math.min(2000, Math.max(200, Math.floor(configuredProbeInterval)))
  : 250;
const MAX_RATE_LIMIT_RETRIES = 2;
const STEP_DISCOVERY_WINDOW = 128;

// Rise/Fall only. CALL and PUT are the canonical Deriv Rise/Fall contract types.
// Do not probe MULTUP, MULTDOWN, UPORDOWN, digits, barriers, resets, etc.
const RISE_FALL_TYPES = new Set(['CALL', 'PUT']);
// Training is intentionally scoped to the high-frequency Rise/Fall duration units
// used by this application. Day durations remain valid at the broker API level but
// are not exposed by this training-data selector.
const TRAINING_DURATION_UNITS: DerivDurationUnit[] = ['t', 's', 'm', 'h'];
const cache = new Map<string, { value: DerivDurationDiscovery; expiresAt: number }>();
const inFlight = new Map<string, Promise<DerivDurationDiscovery>>();

function asRecord(value: unknown): RecordLike | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordLike : null; }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function isRateLimited(error: unknown): boolean { const message = error instanceof Error ? error.message : String(error); return /429|ratelimit|rate.?limit|too many requests|throttle/i.test(message); }
function isUnsupportedRiseFallSymbol(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /OfferingsInvalidSymbol|no Rise\/Fall \(CALL\/PUT\) contracts|Rise\/Fall proposal probing found no supported durations/i.test(message);
}

class DerivDiscoverySession {
  private ws: WebSocket | null = null;
  private sequence = 0;
  private lastProposalAt = 0;

  async connect(timeoutMs = 10000): Promise<void> { this.ws = await openDerivPublicWebSocket(timeoutMs); }
  close(): void { try { this.ws?.close(); } catch {} this.ws = null; }

  async request(request: RecordLike, expected: string, timeoutMs = 10000): Promise<RecordLike> {
    if (!this.ws) throw new Error('Deriv discovery session is not connected.');
    const ws = this.ws;
    const reqId = ++this.sequence;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn: (value: any) => void, value: any) => { if (done) return; done = true; clearTimeout(timer); ws.off('message', onMessage); fn(value); };
      const timer = setTimeout(() => finish(reject, new Error(`Deriv ${expected} discovery timed out.`)), timeoutMs);
      const onMessage = (data: WebSocket.Data) => {
        try {
          const response = JSON.parse(data.toString()) as RecordLike;
          if (Number(response.req_id) !== reqId) return;
          const error = asRecord(response.error);
          if (error) {
            const code = String(error.code ?? '');
            finish(reject, new Error(`Deriv ${expected} discovery failed${code ? ` (${code})` : ''}: ${String(error.message ?? 'Unknown Deriv error')}`));
            return;
          }
          if (response.msg_type === expected) finish(resolve, response);
        } catch (error) {
          finish(reject, error instanceof Error ? error : new Error(`Invalid Deriv ${expected} response.`));
        }
      };
      ws.on('message', onMessage);
      try { ws.send(JSON.stringify({ ...request, req_id: reqId })); }
      catch (error) { finish(reject, error instanceof Error ? error : new Error(`Unable to request Deriv ${expected}.`)); }
    });
  }

  async proposal(symbol: string, capability: ContractCapability, value: number, unit: DerivDurationUnit): Promise<boolean> {
    const elapsed = Date.now() - this.lastProposalAt;
    if (elapsed < PROBE_INTERVAL_MS) await sleep(PROBE_INTERVAL_MS - elapsed);
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      this.lastProposalAt = Date.now();
      try {
        await this.request({
          proposal: 1,
          amount: 1,
          basis: 'stake',
          contract_type: capability.type,
          currency: process.env.DERIV_DISCOVERY_CURRENCY?.trim().toUpperCase() || 'USD',
          duration: value,
          duration_unit: unit,
          underlying_symbol: symbol,
          ...capability.probe,
        }, 'proposal', 8000);
        return true;
      } catch (error) {
        if (!isRateLimited(error) || attempt === MAX_RATE_LIMIT_RETRIES) return false;
        await sleep(1500 * 2 ** attempt);
      }
    }
    return false;
  }
}

function contractCapabilities(response: RecordLike): ContractCapability[] {
  const contractsFor = asRecord(response.contracts_for);
  const available = contractsFor?.available;
  if (!Array.isArray(available)) return [];

  const byType = new Map<string, ContractCapability>();
  for (const item of available) {
    const contract = asRecord(item);
    if (!contract) continue;
    const type = String(contract.contract_type ?? '').trim().toUpperCase();
    if (!RISE_FALL_TYPES.has(type) || byType.has(type)) continue;
    const expiryType = String(contract.expiry_type ?? '').trim().toLowerCase();
    byType.set(type, { type: type as 'CALL' | 'PUT', expiryType, probe: {} });
  }
  return Array.from(byType.values()).sort((a, b) => (a.type === 'CALL' ? -1 : 1) - (b.type === 'CALL' ? -1 : 1));
}

// The proposal endpoint, not a client preset, remains authoritative for the actual
// broker-supported range inside each training unit. The expiry metadata does not
// itself define the valid duration ladder, so every candidate remains broker-probed.
function unitsForExpiryType(expiryType: string): DerivDurationUnit[] { void expiryType; return TRAINING_DURATION_UNITS; }

async function findValidSeed(session: DerivDiscoverySession, symbol: string, capability: ContractCapability, unit: DerivDurationUnit): Promise<number | null> {
  for (const seed of PROBE_SEEDS[unit]) {
    if (seed >= MIN_PROBE[unit] && seed <= MAX_PROBE[unit] && await session.proposal(symbol, capability, seed, unit)) return seed;
  }
  return null;
}

async function findStep(session: DerivDiscoverySession, symbol: string, capability: ContractCapability, unit: DerivDurationUnit, min: number, max: number): Promise<number | null> {
  if (min >= max) return 1;
  const upper = Math.min(max, min + STEP_DISCOVERY_WINDOW);
  for (let value = min + 1; value <= upper; value += 1) {
    if (await session.proposal(symbol, capability, value, unit)) return value - min;
  }
  return null;
}

async function discoverUnit(session: DerivDiscoverySession, symbol: string, capabilities: ContractCapability[], unit: DerivDurationUnit): Promise<{ range: { min: number; max: number; step: number }; capability: ContractCapability } | null> {
  for (const capability of capabilities) {
    if (!unitsForExpiryType(capability.expiryType).includes(unit)) continue;
    const seed = await findValidSeed(session, symbol, capability, unit);
    if (seed === null) continue;

    let validMin = seed;
    for (let value = seed - 1; value >= MIN_PROBE[unit]; value -= 1) {
      if (await session.proposal(symbol, capability, value, unit)) validMin = value;
      else break;
    }

    const step = await findStep(session, symbol, capability, unit, validMin, MAX_PROBE[unit]);
    if (step === null) continue;

    const max = MAX_PROBE[unit];
    const maxMultiplier = Math.floor((max - validMin) / step);
    let lastValidMultiplier = 0;
    let invalidMultiplier: number | null = null;
    let multiplier = 1;

    while (multiplier <= maxMultiplier) {
      const candidate = validMin + multiplier * step;
      if (await session.proposal(symbol, capability, candidate, unit)) {
        lastValidMultiplier = multiplier;
        multiplier *= 2;
      } else {
        invalidMultiplier = multiplier;
        break;
      }
    }

    if (invalidMultiplier === null) {
      if (await session.proposal(symbol, capability, max, unit)) lastValidMultiplier = maxMultiplier;
      else invalidMultiplier = maxMultiplier;
    }

    if (invalidMultiplier !== null) {
      let low = lastValidMultiplier;
      let high = invalidMultiplier;
      while (low + 1 < high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = validMin + mid * step;
        if (await session.proposal(symbol, capability, candidate, unit)) low = mid;
        else high = mid;
      }
      lastValidMultiplier = low;
    }

    return { range: { min: validMin, max: validMin + lastValidMultiplier * step, step }, capability };
  }
  return null;
}

async function discover(symbol: string): Promise<DerivDurationDiscovery> {
  const session = new DerivDiscoverySession();
  try {
    await session.connect();

    // contracts_for is used only to identify whether CALL/PUT (Rise/Fall)
    // exists for this symbol. No other contract family is eligible for probing.
    const contracts = await session.request({ contracts_for: symbol }, 'contracts_for');
    const capabilities = contractCapabilities(contracts);
    if (!capabilities.length) throw new Error(`Deriv returned no Rise/Fall (CALL/PUT) contracts for ${symbol}.`);

    const units = TRAINING_DURATION_UNITS.filter(unit => capabilities.some(c => unitsForExpiryType(c.expiryType).includes(unit)));
    const ranges: DerivDurationRange[] = [];
    for (const unit of units) {
      const result = await discoverUnit(session, symbol, capabilities, unit);
      if (!result) continue;
      ranges.push({
        id: `${symbol}:${result.capability.type}:${unit}:${result.range.min}-${result.range.max}:${result.range.step}`,
        unit,
        min: result.range.min,
        max: result.range.max,
        step: result.range.step,
        tradeTypes: [result.capability.type],
        source: 'deriv-proposal-probe',
      });
    }

    if (!ranges.length) throw new Error(`Deriv Rise/Fall proposal probing found no supported durations for ${symbol}.`);
    return { symbol, ranges, fetchedAt: new Date().toISOString(), source: 'deriv-proposal-probe' };
  } finally { session.close(); }
}

export async function getDerivDurationDiscovery(symbol: string): Promise<DerivDurationDiscovery> {
  const normalized = String(symbol ?? '').trim().toUpperCase();
  if (!normalized) throw new Error('A Deriv symbol is required for duration discovery.');
  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = inFlight.get(normalized);
  if (existing) return existing;
  const promise = discover(normalized)
    .then(value => { cache.set(normalized, { value, expiresAt: Date.now() + DISCOVERY_TTL_MS }); return value; })
    .catch(error => {
      if (!isUnsupportedRiseFallSymbol(error)) throw error;
      return {
        symbol: normalized,
        ranges: [],
        fetchedAt: new Date().toISOString(),
        source: 'deriv-proposal-probe' as const,
        warning: error instanceof Error ? error.message : String(error),
      };
    })
    .finally(() => { inFlight.delete(normalized); });
  inFlight.set(normalized, promise);
  return promise;
}

export function durationToSeconds(value: number, unit: DerivDurationUnit): number | null {
  if (!Number.isSafeInteger(value) || value <= 0 || unit === 't') return null;
  return value * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<Exclude<DerivDurationUnit, 't'>, number>)[unit];
}
export function durationLabel(value: number, unit: DerivDurationUnit): string { return `${value} ${{ t: 'ticks', s: 'seconds', m: 'minutes', h: 'hours', d: 'days' }[unit]}`; }
export function durationRangeLabel(range: DerivDurationRange): string { return range.min === range.max ? durationLabel(range.min, range.unit) : `${durationLabel(range.min, range.unit)} – ${durationLabel(range.max, range.unit)}`; }

export function expandTrainingDurations(ranges: DerivDurationRange[], maxExpandedPerRange = 24): Array<{ value: number; unit: DerivDurationUnit; rangeId: string }> {
  const result: Array<{ value: number; unit: DerivDurationUnit; rangeId: string }> = [];
  for (const range of ranges) {
    const step = Number.isSafeInteger(range.step) && range.step > 0 ? range.step : 1;
    const count = Math.floor((range.max - range.min) / step) + 1;
    if (count <= maxExpandedPerRange) {
      for (let value = range.min; value <= range.max; value += step) result.push({ value, unit: range.unit, rangeId: range.id });
      continue;
    }

    // For large broker-validated ranges, derive a compact UI ladder directly
    // from the validated range/step. There are no predefined duration anchors.
    const targetCount = Math.max(2, Math.min(maxExpandedPerRange, count));
    const lastIndex = count - 1;
    const selectedIndexes = new Set<number>();
    for (let i = 0; i < targetCount; i += 1) {
      const rawIndex = targetCount === 1 ? 0 : Math.round((i * lastIndex) / (targetCount - 1));
      selectedIndexes.add(rawIndex);
    }
    for (const index of selectedIndexes) {
      result.push({
        value: range.min + index * step,
        unit: range.unit,
        rangeId: range.id,
      });
    }
  }

  const seen = new Set<string>();
  return result
    .sort((a, b) => a.unit.localeCompare(b.unit) || a.value - b.value)
    .filter(item => {
      const itemKey = `${item.value}:${item.unit}`;
      if (seen.has(itemKey)) return false;
      seen.add(itemKey);
      return true;
    });
}
