import { describe, it, expect } from 'vitest';

/**
 * Tests for Hyperliquid price/size formatting
 * These test the float_to_wire equivalent formatting that matches the Python SDK
 */

// Replicate the formatPrice/formatSize logic for testing
function floatToWire(value: number): string {
  // Handle zero and negative zero
  if (value === 0 || Object.is(value, -0)) return '0';

  // Format to 8 decimal places (SDK: f"{x:.8f}")
  let str = value.toFixed(8);

  // Handle "-0.00000000" case
  if (str === '-0.00000000') return '0';

  // Remove trailing zeros after decimal (matching Decimal.normalize())
  if (str.includes('.')) {
    str = str.replace(/\.?0+$/, '');
  }

  return str;
}

function roundToSigFigs(x: number, sigFigs: number): number {
  if (x === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(x)));
  const scale = Math.pow(10, sigFigs - magnitude - 1);
  return Math.round(x * scale) / scale;
}

function slippagePrice(isBuy: boolean, slippage: number, px: number): number {
  const adjustedPx = isBuy ? px * (1 + slippage) : px * (1 - slippage);
  return roundToSigFigs(adjustedPx, 5);
}

describe('Hyperliquid formatting', () => {
  describe('floatToWire (price/size formatting)', () => {
    it('should handle zero', () => {
      expect(floatToWire(0)).toBe('0');
    });

    it('should handle negative zero', () => {
      expect(floatToWire(-0)).toBe('0');
    });

    it('should format simple decimals', () => {
      expect(floatToWire(1.5)).toBe('1.5');
      expect(floatToWire(3.4845)).toBe('3.4845');
      expect(floatToWire(100.25)).toBe('100.25');
    });

    it('should remove trailing zeros', () => {
      expect(floatToWire(1.50000000)).toBe('1.5');
      expect(floatToWire(100.00000000)).toBe('100');
      expect(floatToWire(0.12300000)).toBe('0.123');
    });

    it('should handle small numbers', () => {
      expect(floatToWire(0.00001234)).toBe('0.00001234');
      expect(floatToWire(0.01)).toBe('0.01');
    });

    it('should handle large numbers', () => {
      expect(floatToWire(100000)).toBe('100000');
      expect(floatToWire(12345.6789)).toBe('12345.6789');
    });

    it('should truncate to 8 decimal places', () => {
      // 0.123456789 rounds to 0.12345679 (8 decimals)
      expect(floatToWire(0.123456789)).toBe('0.12345679');
    });
  });

  describe('roundToSigFigs', () => {
    it('should round to 5 significant figures', () => {
      expect(roundToSigFigs(12345.6789, 5)).toBe(12346);
      expect(roundToSigFigs(0.0012345678, 5)).toBe(0.0012346);
      expect(roundToSigFigs(100000.123, 5)).toBe(100000);
    });

    it('should handle zero', () => {
      expect(roundToSigFigs(0, 5)).toBe(0);
    });

    it('should handle exact values', () => {
      expect(roundToSigFigs(1.5, 5)).toBe(1.5);
      expect(roundToSigFigs(100, 5)).toBe(100);
    });
  });

  describe('slippagePrice', () => {
    it('should add slippage for buy orders', () => {
      // 100 * 1.01 = 101, rounded to 5 sig figs = 101
      expect(slippagePrice(true, 0.01, 100)).toBe(101);
    });

    it('should subtract slippage for sell orders', () => {
      // 100 * 0.99 = 99, rounded to 5 sig figs = 99
      expect(slippagePrice(false, 0.01, 100)).toBe(99);
    });

    it('should round result to 5 significant figures', () => {
      // 12345.6789 * 1.01 = 12469.135689, rounded to 5 sig figs = 12469
      expect(slippagePrice(true, 0.01, 12345.6789)).toBe(12469);
    });

    it('should handle small prices', () => {
      // 0.01234 * 1.01 = 0.0124634, rounded to 5 sig figs = 0.012463
      expect(slippagePrice(true, 0.01, 0.01234)).toBeCloseTo(0.012463, 5);
    });
  });
});
