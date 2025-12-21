import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../src/utils/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      maxRequests: 3,
      windowMs: 1000,
      minDelayMs: 50,
    });
  });

  it('should allow requests within limit', async () => {
    const start = Date.now();

    await limiter.acquire('test1');
    await limiter.acquire('test2');
    await limiter.acquire('test3');

    const elapsed = Date.now() - start;
    // Should complete relatively quickly (within 500ms with min delays)
    expect(elapsed).toBeLessThan(500);
  });

  it('should track pending requests', async () => {
    const stats = limiter.getStats();
    expect(stats.pending).toBe(0);
    expect(stats.requestsInWindow).toBe(0);
  });

  it('should respect minimum delay between requests', async () => {
    const start = Date.now();

    await limiter.acquire('test1');
    await limiter.acquire('test2');

    const elapsed = Date.now() - start;
    // Should have at least one minDelay (50ms)
    expect(elapsed).toBeGreaterThanOrEqual(45); // Small buffer for timing
  });

  it('should throttle when limit exceeded', async () => {
    // Create a limiter with very restrictive settings
    const strictLimiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 500,
      minDelayMs: 10,
    });

    const start = Date.now();

    // First two should be quick
    await strictLimiter.acquire('test1');
    await strictLimiter.acquire('test2');
    // Third should wait for window
    await strictLimiter.acquire('test3');

    const elapsed = Date.now() - start;
    // Should take longer due to throttling
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });
});
