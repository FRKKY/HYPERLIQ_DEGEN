export enum ErrorCode {
  // Network errors (1xxx)
  NETWORK_ERROR = 1001,
  API_TIMEOUT = 1002,
  RATE_LIMITED = 1003,
  CONNECTION_FAILED = 1004,

  // Authentication errors (2xxx)
  AUTH_REQUIRED = 2001,
  INVALID_API_KEY = 2002,
  INSUFFICIENT_PERMISSIONS = 2003,

  // Validation errors (3xxx)
  VALIDATION_ERROR = 3001,
  INVALID_SYMBOL = 3002,
  INVALID_ORDER_SIZE = 3003,
  INVALID_PRICE = 3004,

  // Trading errors (4xxx)
  INSUFFICIENT_BALANCE = 4001,
  POSITION_NOT_FOUND = 4002,
  ORDER_REJECTED = 4003,
  MAX_POSITIONS_REACHED = 4004,
  TRADING_DISABLED = 4005,

  // Database errors (5xxx)
  DB_CONNECTION_ERROR = 5001,
  DB_QUERY_ERROR = 5002,
  DB_TRANSACTION_ERROR = 5003,

  // System errors (6xxx)
  SYSTEM_ERROR = 6001,
  CONFIG_ERROR = 6002,
  INITIALIZATION_ERROR = 6003,
}

export class TradingError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly isRetryable: boolean;
  public readonly timestamp: Date;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    isRetryable: boolean = false
  ) {
    super(message);
    this.name = 'TradingError';
    this.code = code;
    this.details = details;
    this.isRetryable = isRetryable;
    this.timestamp = new Date();

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TradingError);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      isRetryable: this.isRetryable,
      timestamp: this.timestamp.toISOString(),
    };
  }
}

export class NetworkError extends TradingError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.NETWORK_ERROR, message, details, true);
    this.name = 'NetworkError';
  }
}

export class RateLimitError extends TradingError {
  public readonly retryAfter: number;

  constructor(retryAfter: number, details?: Record<string, unknown>) {
    super(ErrorCode.RATE_LIMITED, `Rate limited. Retry after ${retryAfter}ms`, details, true);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class AuthenticationError extends TradingError {
  constructor(message: string = 'Authentication required', details?: Record<string, unknown>) {
    super(ErrorCode.AUTH_REQUIRED, message, details, false);
    this.name = 'AuthenticationError';
  }
}

export class ValidationError extends TradingError {
  public readonly field?: string;

  constructor(message: string, field?: string, details?: Record<string, unknown>) {
    super(ErrorCode.VALIDATION_ERROR, message, { ...details, field }, false);
    this.name = 'ValidationError';
    this.field = field;
  }
}

export class InsufficientBalanceError extends TradingError {
  constructor(required: number, available: number, details?: Record<string, unknown>) {
    super(
      ErrorCode.INSUFFICIENT_BALANCE,
      `Insufficient balance. Required: ${required}, Available: ${available}`,
      { ...details, required, available },
      false
    );
    this.name = 'InsufficientBalanceError';
  }
}

export class DatabaseError extends TradingError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.DB_CONNECTION_ERROR, message, details, true);
    this.name = 'DatabaseError';
  }
}

// Error handler helper
export function handleError(error: unknown): TradingError {
  if (error instanceof TradingError) {
    return error;
  }

  if (error instanceof Error) {
    // Check for common error patterns
    if (error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT')) {
      return new NetworkError(error.message);
    }
    if (error.message.includes('rate limit') || error.message.includes('429')) {
      return new RateLimitError(60000);
    }

    return new TradingError(ErrorCode.SYSTEM_ERROR, error.message, { originalError: error.name });
  }

  return new TradingError(ErrorCode.SYSTEM_ERROR, 'Unknown error occurred', { error: String(error) });
}

// Type guard
export function isTradingError(error: unknown): error is TradingError {
  return error instanceof TradingError;
}
