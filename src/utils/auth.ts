import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { logger } from './logger';
import { AuthenticationError } from './errors';

// Generate a secure API key
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Hash API key for storage
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

// Validate API key
export function validateApiKey(provided: string, storedHash: string): boolean {
  const providedHash = hashApiKey(provided);
  return crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(storedHash));
}

// Middleware factory for API key authentication
export function apiKeyAuth(apiKeyHash: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Check multiple sources for API key
    const apiKey =
      req.headers['x-api-key'] as string ||
      req.headers['authorization']?.replace('Bearer ', '') ||
      req.query.apiKey as string;

    if (!apiKey) {
      logger.warn('Auth', 'Missing API key', {
        ip: req.ip,
        path: req.path,
        method: req.method,
      });
      res.status(401).json({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    try {
      if (!validateApiKey(apiKey, apiKeyHash)) {
        logger.warn('Auth', 'Invalid API key', {
          ip: req.ip,
          path: req.path,
          method: req.method,
        });
        res.status(403).json({
          error: 'Invalid API key',
          code: 'INVALID_API_KEY',
        });
        return;
      }

      // Log successful authentication
      logger.debug('Auth', 'Authenticated request', {
        ip: req.ip,
        path: req.path,
        method: req.method,
      });

      next();
    } catch (error) {
      logger.error('Auth', 'Authentication error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        ip: req.ip,
        path: req.path,
      });
      res.status(500).json({
        error: 'Authentication error',
        code: 'AUTH_ERROR',
      });
    }
  };
}

// Rate limiting middleware per IP
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const ipRateLimits: Map<string, RateLimitEntry> = new Map();

export function ipRateLimit(maxRequests: number, windowMs: number) {
  // Cleanup old entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of ipRateLimits.entries()) {
      if (entry.resetTime < now) {
        ipRateLimits.delete(ip);
      }
    }
  }, 60000);

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    let entry = ipRateLimits.get(ip);

    if (!entry || entry.resetTime < now) {
      entry = { count: 0, resetTime: now + windowMs };
      ipRateLimits.set(ip, entry);
    }

    entry.count++;

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000));

    if (entry.count > maxRequests) {
      logger.warn('Auth', 'Rate limit exceeded', {
        ip,
        count: entry.count,
        limit: maxRequests,
      });
      res.status(429).json({
        error: 'Too many requests',
        code: 'RATE_LIMITED',
        retryAfter: Math.ceil((entry.resetTime - now) / 1000),
      });
      return;
    }

    next();
  };
}

// CORS configuration
export interface CorsConfig {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  maxAge: number;
}

export const defaultCorsConfig: CorsConfig = {
  allowedOrigins: [], // Will be populated from env
  allowedMethods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
  maxAge: 86400, // 24 hours
};

export function corsMiddleware(config: CorsConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;

    // Check if origin is allowed
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (config.allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Methods', config.allowedMethods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', config.allowedHeaders.join(', '));
    res.setHeader('Access-Control-Max-Age', config.maxAge.toString());

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
