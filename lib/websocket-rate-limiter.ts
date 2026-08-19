import { RateLimiterMemory } from 'rate-limiter-flexible';

// 3000 messages max per 60 seconds per IP / key for high-frequency tick streams
const wsLimiter = new RateLimiterMemory({
  points: 3000,
  duration: 60,
});

export async function checkWebSocketRateLimit(ipOrKey: string = 'client-connection'): Promise<boolean> {
  try {
    await wsLimiter.consume(ipOrKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Client-side windowed rate limiter for WebSocket message sending/handling
 */
export class ClientWSRateLimiter {
  private points: number;
  private durationMs: number;
  private tokens: number;
  private lastReset: number;

  constructor(points: number = 100, durationSec: number = 60) {
    this.points = points;
    this.durationMs = durationSec * 1000;
    this.tokens = points;
    this.lastReset = Date.now();
  }

  tryConsume(count: number = 1): boolean {
    const now = Date.now();
    if (now - this.lastReset >= this.durationMs) {
      this.tokens = this.points;
      this.lastReset = now;
    }
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  getRemainingTokens(): number {
    const now = Date.now();
    if (now - this.lastReset >= this.durationMs) {
      this.tokens = this.points;
      this.lastReset = now;
    }
    return this.tokens;
  }
}
