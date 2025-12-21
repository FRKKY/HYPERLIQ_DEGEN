import { describe, it, expect, vi } from 'vitest';
import { withRetry, retry } from '../src/utils/retry';
import { NetworkError } from '../src/utils/errors';

describe('Retry utilities', () => {
  describe('withRetry', () => {
    it('should succeed on first try', async () => {
      const operation = vi.fn().mockResolvedValue('success');

      const result = await withRetry(operation, 'test-op');

      expect(result.success).toBe(true);
      expect(result.data).toBe('success');
      expect(result.attempts).toBe(1);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable failure and eventually succeed', async () => {
      // NetworkError is retryable
      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('fail1'))
        .mockRejectedValueOnce(new NetworkError('fail2'))
        .mockResolvedValue('success');

      const result = await withRetry(operation, 'test-op', {
        maxAttempts: 5,
        initialDelayMs: 10,
      });

      expect(result.success).toBe(true);
      expect(result.data).toBe('success');
      expect(result.attempts).toBe(3);
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should fail after max attempts with retryable error', async () => {
      const operation = vi.fn().mockRejectedValue(new NetworkError('always fails'));

      const result = await withRetry(operation, 'test-op', {
        maxAttempts: 3,
        initialDelayMs: 10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.attempts).toBe(3);
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should not retry non-retryable errors', async () => {
      // Regular Error is not retryable by default
      const error = new Error('non-retryable');
      const operation = vi.fn().mockRejectedValue(error);

      const result = await withRetry(operation, 'test-op', {
        maxAttempts: 5,
        initialDelayMs: 10,
      });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry function', () => {
    it('should wrap function with retry logic', async () => {
      let attempts = 0;
      const flaky = async () => {
        attempts++;
        if (attempts < 3) throw new NetworkError('not yet'); // NetworkError is retryable
        return 'done';
      };

      const result = await retry(flaky, 5);

      expect(result).toBe('done');
      expect(attempts).toBe(3);
    });

    it('should throw on final failure', async () => {
      const failing = async () => {
        throw new NetworkError('always fails');
      };

      await expect(retry(failing, 2)).rejects.toThrow('always fails');
    });
  });
});
