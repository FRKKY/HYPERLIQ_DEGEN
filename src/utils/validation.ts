import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';

// Query parameter schemas
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const timeRangeSchema = z.object({
  hours: z.coerce.number().int().min(1).max(8760).default(168), // Max 1 year
});

export const tradesQuerySchema = paginationSchema.extend({
  strategy: z.enum(['funding_signal', 'momentum_breakout', 'mean_reversion', 'trend_follow']).optional(),
  symbol: z.string().min(1).max(20).optional(),
});

// Order schemas
export const orderRequestSchema = z.object({
  symbol: z.string().min(1).max(20),
  side: z.enum(['BUY', 'SELL']),
  size: z.number().positive(),
  price: z.number().positive().optional(),
  leverage: z.number().int().min(1).max(50).optional(),
  reduceOnly: z.boolean().optional(),
});

// Signal schemas
export const signalSchema = z.object({
  strategyName: z.enum(['funding_signal', 'momentum_breakout', 'mean_reversion', 'trend_follow']),
  symbol: z.string().min(1).max(20),
  direction: z.enum(['LONG', 'SHORT', 'CLOSE', 'NONE']),
  strength: z.number().min(0).max(1),
  entryPrice: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
});

// Strategy allocation schema
export const allocationSchema = z.object({
  funding_signal: z.number().min(0).max(100),
  momentum_breakout: z.number().min(0).max(100),
  mean_reversion: z.number().min(0).max(100),
  trend_follow: z.number().min(0).max(100),
}).refine(
  (data) => {
    const total = data.funding_signal + data.momentum_breakout + data.mean_reversion + data.trend_follow;
    return total <= 100;
  },
  { message: 'Total allocation cannot exceed 100%' }
);

// Promotion criteria schema
export const promotionCriteriaSchema = z.object({
  minTestnetRuntimeHours: z.number().int().min(1).optional(),
  minTrades: z.number().int().min(1).optional(),
  minSharpeRatio: z.number().optional(),
  maxDrawdownPct: z.number().max(0).optional(),
  minWinRatePct: z.number().min(0).max(100).optional(),
  minProfitFactor: z.number().positive().optional(),
  maxConsecutiveLosses: z.number().int().min(1).optional(),
  minShadowModeHours: z.number().int().min(0).optional(),
});

// Validation middleware factory
export function validateQuery<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = schema.safeParse(req.query);
      if (!result.success) {
        const errors = result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        }));

        logger.warn('Validation', 'Query validation failed', {
          path: req.path,
          errors,
        });

        res.status(400).json({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: errors,
        });
        return;
      }

      // Attach validated data to request
      (req as any).validatedQuery = result.data;
      next();
    } catch (error) {
      logger.error('Validation', 'Validation error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
      });
    }
  };
}

export function validateBody<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = schema.safeParse(req.body);
      if (!result.success) {
        const errors = result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        }));

        logger.warn('Validation', 'Body validation failed', {
          path: req.path,
          errors,
        });

        res.status(400).json({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: errors,
        });
        return;
      }

      (req as any).validatedBody = result.data;
      next();
    } catch (error) {
      logger.error('Validation', 'Validation error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
      });
    }
  };
}

// Type helpers
export type PaginationQuery = z.infer<typeof paginationSchema>;
export type TimeRangeQuery = z.infer<typeof timeRangeSchema>;
export type TradesQuery = z.infer<typeof tradesQuerySchema>;
export type OrderRequest = z.infer<typeof orderRequestSchema>;
export type SignalInput = z.infer<typeof signalSchema>;
export type AllocationInput = z.infer<typeof allocationSchema>;
