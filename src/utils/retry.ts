import { logger } from './logger';
import { TradingError, RateLimitError, isTradingError } from './errors';

interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;  // 0-1, adds randomness to delay
  retryableErrors?: string[];  // Error names that should be retried
}

const DEFAULT_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterFactor: 0.2,
};

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  totalDelayMs: number;
}

function calculateDelay(attempt: number, config: RetryConfig, error?: Error): number {
  // Check for rate limit error with specific retry-after
  if (error instanceof RateLimitError && error.retryAfter) {
    return Math.min(error.retryAfter, config.maxDelayMs);
  }

  // Exponential backoff
  let delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);

  // Apply max delay cap
  delay = Math.min(delay, config.maxDelayMs);

  // Add jitter
  if (config.jitterFactor > 0) {
    const jitter = delay * config.jitterFactor * (Math.random() * 2 - 1);
    delay = Math.max(0, delay + jitter);
  }

  return Math.floor(delay);
}

function isRetryable(error: unknown, config: RetryConfig): boolean {
  if (isTradingError(error) && error.isRetryable) {
    return true;
  }

  if (error instanceof Error) {
    // Check for specific retryable error patterns
    const retryablePatterns = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'EPIPE',
      'EHOSTUNREACH',
      'EAI_AGAIN',
      'socket hang up',
      'network',
      'timeout',
      '502',
      '503',
      '504',
    ];

    const message = error.message.toLowerCase();
    if (retryablePatterns.some((p) => message.includes(p.toLowerCase()))) {
      return true;
    }

    // Check configured retryable error names
    if (config.retryableErrors?.includes(error.name)) {
      return true;
    }
  }

  return false;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  customConfig?: Partial<RetryConfig>
): Promise<RetryResult<T>> {
  const config: RetryConfig = { ...DEFAULT_CONFIG, ...customConfig };
  let lastError: Error | undefined;
  let totalDelayMs = 0;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const data = await operation();
      return {
        success: true,
        data,
        attempts: attempt,
        totalDelayMs,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if this is the last attempt or error is not retryable
      if (attempt === config.maxAttempts || !isRetryable(error, config)) {
        logger.error('Retry', `${operationName} failed after ${attempt} attempts`, {
          error: lastError.message,
          attempts: attempt,
          retryable: isRetryable(error, config),
        });

        return {
          success: false,
          error: lastError,
          attempts: attempt,
          totalDelayMs,
        };
      }

      // Calculate delay before next attempt
      const delay = calculateDelay(attempt, config, lastError);
      totalDelayMs += delay;

      logger.warn('Retry', `${operationName} attempt ${attempt} failed, retrying in ${delay}ms`, {
        error: lastError.message,
        nextAttempt: attempt + 1,
        maxAttempts: config.maxAttempts,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should never reach here, but TypeScript needs this
  return {
    success: false,
    error: lastError,
    attempts: config.maxAttempts,
    totalDelayMs,
  };
}

// Decorator-style retry wrapper for class methods
export function retryable(config?: Partial<RetryConfig>) {
  return function (
    target: unknown,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      const result = await withRetry(
        () => originalMethod.apply(this, args),
        `${(target as object).constructor.name}.${propertyKey}`,
        config
      );

      if (!result.success && result.error) {
        throw result.error;
      }

      return result.data;
    };

    return descriptor;
  };
}

// Simple retry for quick operations
export async function retry<T>(
  operation: () => Promise<T>,
  maxAttempts: number = 3
): Promise<T> {
  const result = await withRetry(operation, 'operation', { maxAttempts });
  if (!result.success) {
    throw result.error;
  }
  return result.data!;
}
