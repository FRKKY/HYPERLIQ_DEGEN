import { describe, it, expect } from 'vitest';
import {
  paginationSchema,
  timeRangeSchema,
  orderRequestSchema,
  signalSchema,
} from '../src/utils/validation';

describe('Validation Schemas', () => {
  describe('paginationSchema', () => {
    it('should accept valid pagination params', () => {
      const result = paginationSchema.safeParse({ limit: 50, offset: 100 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
        expect(result.data.offset).toBe(100);
      }
    });

    it('should use default values when not provided', () => {
      const result = paginationSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
        expect(result.data.offset).toBe(0);
      }
    });

    it('should reject invalid limit', () => {
      const result = paginationSchema.safeParse({ limit: 5000 });

      expect(result.success).toBe(false);
    });

    it('should coerce string numbers', () => {
      const result = paginationSchema.safeParse({ limit: '25', offset: '10' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(25);
        expect(result.data.offset).toBe(10);
      }
    });
  });

  describe('timeRangeSchema', () => {
    it('should accept valid hours', () => {
      const result = timeRangeSchema.safeParse({ hours: 24 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hours).toBe(24);
      }
    });

    it('should use default hours when not provided', () => {
      const result = timeRangeSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hours).toBe(168); // Default is 168 (1 week)
      }
    });

    it('should reject hours exceeding max', () => {
      const result = timeRangeSchema.safeParse({ hours: 10000 }); // Max is 8760

      expect(result.success).toBe(false);
    });
  });

  describe('orderRequestSchema', () => {
    it('should accept valid order request', () => {
      const result = orderRequestSchema.safeParse({
        symbol: 'BTC',
        side: 'BUY',
        size: 0.1,
        price: 50000,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.symbol).toBe('BTC');
        expect(result.data.side).toBe('BUY');
      }
    });

    it('should reject missing required fields', () => {
      const result = orderRequestSchema.safeParse({
        symbol: 'BTC',
      });

      expect(result.success).toBe(false);
    });

    it('should reject negative size', () => {
      const result = orderRequestSchema.safeParse({
        symbol: 'BTC',
        side: 'BUY',
        size: -1,
        price: 50000,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('signalSchema', () => {
    it('should accept valid signal', () => {
      const result = signalSchema.safeParse({
        strategyName: 'momentum_breakout',
        symbol: 'BTC',
        direction: 'LONG',
        strength: 0.8,
      });

      expect(result.success).toBe(true);
    });

    it('should reject invalid direction', () => {
      const result = signalSchema.safeParse({
        strategyName: 'momentum_breakout',
        symbol: 'BTC',
        direction: 'sideways', // invalid
        strength: 0.5,
      });

      expect(result.success).toBe(false);
    });

    it('should reject strength out of range', () => {
      const result = signalSchema.safeParse({
        strategyName: 'momentum_breakout',
        symbol: 'BTC',
        direction: 'LONG',
        strength: 1.5, // invalid
      });

      expect(result.success).toBe(false);
    });
  });
});
