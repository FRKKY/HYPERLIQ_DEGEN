import { RateLimitError } from './errors';
import { logger } from './logger';

interface RateLimitConfig {
  maxRequests: number;      // Maximum requests allowed
  windowMs: number;         // Time window in milliseconds
  minDelayMs?: number;      // Minimum delay between requests
}

interface RequestRecord {
  timestamp: number;
  endpoint: string;
}

export class RateLimiter {
  private requests: RequestRecord[] = [];
  private config: RateLimitConfig;
  private queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    endpoint: string;
  }> = [];
  private processing = false;

  constructor(config: RateLimitConfig) {
    this.config = {
      minDelayMs: 100, // Default 100ms between requests
      ...config,
    };
  }

  private cleanOldRequests(): void {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    this.requests = this.requests.filter((r) => r.timestamp > windowStart);
  }

  private canMakeRequest(): boolean {
    this.cleanOldRequests();
    return this.requests.length < this.config.maxRequests;
  }

  private getWaitTime(): number {
    this.cleanOldRequests();

    if (this.requests.length === 0) {
      return 0;
    }

    // Check if we need to wait for rate limit window
    if (this.requests.length >= this.config.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitForWindow = oldestRequest.timestamp + this.config.windowMs - Date.now();
      return Math.max(0, waitForWindow);
    }

    // Check minimum delay between requests
    const lastRequest = this.requests[this.requests.length - 1];
    const timeSinceLastRequest = Date.now() - lastRequest.timestamp;
    const minDelay = this.config.minDelayMs || 0;

    if (timeSinceLastRequest < minDelay) {
      return minDelay - timeSinceLastRequest;
    }

    return 0;
  }

  async acquire(endpoint: string = 'default'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, endpoint });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const waitTime = this.getWaitTime();

      if (waitTime > 0) {
        logger.debug('RateLimiter', `Waiting ${waitTime}ms before next request`);
        await this.sleep(waitTime);
      }

      if (this.canMakeRequest()) {
        const item = this.queue.shift();
        if (item) {
          this.requests.push({ timestamp: Date.now(), endpoint: item.endpoint });
          item.resolve();
        }
      } else {
        // Should not happen, but safety check
        const waitForSlot = this.getWaitTime();
        if (waitForSlot > 30000) {
          // If wait is too long, reject with rate limit error
          const item = this.queue.shift();
          if (item) {
            item.reject(new RateLimitError(waitForSlot));
          }
        }
        await this.sleep(100);
      }
    }

    this.processing = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getStats(): { pending: number; requestsInWindow: number; windowMs: number } {
    this.cleanOldRequests();
    return {
      pending: this.queue.length,
      requestsInWindow: this.requests.length,
      windowMs: this.config.windowMs,
    };
  }
}

// Default rate limiter for Hyperliquid API
// Hyperliquid has a rate limit of ~10 requests per second
export const hyperliquidRateLimiter = new RateLimiter({
  maxRequests: 8,      // Stay under 10/second limit
  windowMs: 1000,      // 1 second window
  minDelayMs: 100,     // At least 100ms between requests
});

// Separate rate limiter for WebSocket messages
export const wsRateLimiter = new RateLimiter({
  maxRequests: 20,
  windowMs: 1000,
  minDelayMs: 50,
});
