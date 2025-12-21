import { describe, it, expect } from 'vitest';
import {
  TradingError,
  NetworkError,
  RateLimitError,
  ValidationError,
  DatabaseError,
  ErrorCode,
  handleError,
  isTradingError,
} from '../src/utils/errors';

describe('Custom Errors', () => {
  describe('TradingError', () => {
    it('should create error with code and retryable flag', () => {
      const error = new TradingError(ErrorCode.NETWORK_ERROR, 'Test error', undefined, true);

      expect(error.message).toBe('Test error');
      expect(error.code).toBe(ErrorCode.NETWORK_ERROR);
      expect(error.isRetryable).toBe(true);
      expect(error.name).toBe('TradingError');
    });
  });

  describe('NetworkError', () => {
    it('should be retryable by default', () => {
      const error = new NetworkError('Connection failed');

      expect(error.isRetryable).toBe(true);
      expect(error.code).toBe(ErrorCode.NETWORK_ERROR);
    });
  });

  describe('RateLimitError', () => {
    it('should store retry after duration', () => {
      const error = new RateLimitError(5000);

      expect(error.retryAfter).toBe(5000);
      expect(error.isRetryable).toBe(true);
      expect(error.code).toBe(ErrorCode.RATE_LIMITED);
    });
  });

  describe('ValidationError', () => {
    it('should not be retryable', () => {
      const error = new ValidationError('Invalid input');

      expect(error.isRetryable).toBe(false);
      expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  describe('DatabaseError', () => {
    it('should handle connection errors as retryable', () => {
      const error = new DatabaseError('Connection lost');

      expect(error.isRetryable).toBe(true);
      expect(error.code).toBe(ErrorCode.DB_CONNECTION_ERROR);
    });
  });

  describe('isTradingError', () => {
    it('should identify TradingError instances', () => {
      expect(isTradingError(new TradingError(ErrorCode.SYSTEM_ERROR, 'test'))).toBe(true);
      expect(isTradingError(new NetworkError('test'))).toBe(true);
      expect(isTradingError(new Error('test'))).toBe(false);
    });
  });

  describe('handleError', () => {
    it('should return TradingError as-is', () => {
      const original = new NetworkError('test');
      const handled = handleError(original);

      expect(handled).toBe(original);
    });

    it('should wrap regular Error in TradingError', () => {
      const original = new Error('test');
      const handled = handleError(original);

      expect(handled).toBeInstanceOf(TradingError);
      expect(handled.message).toBe('test');
    });

    it('should handle unknown errors', () => {
      const handled = handleError('string error');

      expect(handled).toBeInstanceOf(TradingError);
      expect(handled.message).toBe('Unknown error occurred');
    });
  });
});
