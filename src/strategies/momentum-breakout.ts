import { BaseStrategy, StrategyConfig } from './base-strategy';
import { Signal, Position, MomentumBreakoutParams, StrategyName } from '../types';
import { Database } from '../data/database';
import { IndicatorComputer } from '../data/indicator-computer';

const DEFAULT_PARAMS: MomentumBreakoutParams = {
  consolidationMaxRange: 0.04, // 4%
  consolidationPeriodHours: 24,
  adxThreshold: 25,
  volumeMultiplier: 2,
  atrMultiplierTrailingSL: 1.5,
  atrMultiplierTP: 5,
  rsiOverbought: 80,
  rsiOversold: 20,
};

export class MomentumBreakoutStrategy extends BaseStrategy {
  readonly name: StrategyName = 'momentum_breakout';
  readonly config: StrategyConfig = {
    enabled: true,
    capitalUtilization: 0.4,
    maxLeverage: 8,
  };

  private params: MomentumBreakoutParams;
  private highestSinceEntry: Map<string, number> = new Map();
  private lowestSinceEntry: Map<string, number> = new Map();

  constructor(db: Database, params?: Partial<MomentumBreakoutParams>) {
    super(db);
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  async generateSignal(symbol: string): Promise<Signal | null> {
    try {
      // Get 1h candles for analysis
      const candles = await this.getCandles(symbol, '1h', 100);
      if (candles.length < 50) return null;

      const currentPrice = candles[0].close;
      const atr = IndicatorComputer.atr(candles, 14);
      const adx = IndicatorComputer.adx(candles, 14);
      const rsi = IndicatorComputer.rsi(candles, 14);
      const volumeRatio = IndicatorComputer.volumeRatio(candles, 20);

      // Check for consolidation
      const periodCandles = candles.slice(0, this.params.consolidationPeriodHours);
      const { rangePct, high, low } = IndicatorComputer.priceRange(periodCandles, this.params.consolidationPeriodHours);

      const isConsolidating = rangePct < this.params.consolidationMaxRange * 100 && adx < this.params.adxThreshold;

      if (!isConsolidating) return null;

      // Check for breakout
      const { isUpBreakout, isDownBreakout } = IndicatorComputer.isBreakout(candles, this.params.consolidationPeriodHours);

      // Volume confirmation
      const hasVolumeConfirmation = volumeRatio >= this.params.volumeMultiplier;

      // LONG breakout
      if (isUpBreakout && hasVolumeConfirmation && rsi > 50) {
        const entryPrice = currentPrice;
        const stopLoss = low; // Stop at breakdown level
        const takeProfit = this.calculateTakeProfit(entryPrice, atr, this.params.atrMultiplierTP, true);

        const strength = Math.min(1, volumeRatio / 3);

        // Initialize tracking for trailing stop
        this.highestSinceEntry.set(symbol, currentPrice);

        return this.createSignal(symbol, 'LONG', strength, entryPrice, stopLoss, takeProfit, {
          breakoutLevel: high,
          volumeRatio,
          adx,
          rsi,
        });
      }

      // SHORT breakout
      if (isDownBreakout && hasVolumeConfirmation && rsi < 50) {
        const entryPrice = currentPrice;
        const stopLoss = high; // Stop at breakout level
        const takeProfit = this.calculateTakeProfit(entryPrice, atr, this.params.atrMultiplierTP, false);

        const strength = Math.min(1, volumeRatio / 3);

        // Initialize tracking for trailing stop
        this.lowestSinceEntry.set(symbol, currentPrice);

        return this.createSignal(symbol, 'SHORT', strength, entryPrice, stopLoss, takeProfit, {
          breakdownLevel: low,
          volumeRatio,
          adx,
          rsi,
        });
      }

      return null;
    } catch (error) {
      console.error(`[MomentumBreakout] Error generating signal for ${symbol}:`, error);
      return null;
    }
  }

  async shouldExit(position: Position, currentPrice: number): Promise<{ shouldExit: boolean; reason?: string }> {
    try {
      const candles = await this.getCandles(position.symbol, '1h', 50);
      if (candles.length < 20) return { shouldExit: false };

      const atr = IndicatorComputer.atr(candles, 14);
      const rsi = IndicatorComputer.rsi(candles, 14);

      if (position.side === 'LONG') {
        // Update highest price
        const highest = this.highestSinceEntry.get(position.symbol) || position.entryPrice;
        if (currentPrice > highest) {
          this.highestSinceEntry.set(position.symbol, currentPrice);
        }

        const trailingStop = (this.highestSinceEntry.get(position.symbol) || highest) - atr * this.params.atrMultiplierTrailingSL;

        // Check trailing stop
        if (currentPrice < trailingStop) {
          this.highestSinceEntry.delete(position.symbol);
          return { shouldExit: true, reason: 'Trailing stop hit' };
        }

        // Check RSI divergence
        if (rsi > this.params.rsiOverbought && IndicatorComputer.hasRsiDivergence(candles)) {
          this.highestSinceEntry.delete(position.symbol);
          return { shouldExit: true, reason: 'RSI divergence' };
        }

        // Check failed breakout (close below breakout level)
        const metadata = position.strategyName === this.name ? (position as any).metadata : null;
        if (metadata?.breakoutLevel && currentPrice < metadata.breakoutLevel) {
          this.highestSinceEntry.delete(position.symbol);
          return { shouldExit: true, reason: 'Failed breakout' };
        }
      } else {
        // SHORT position
        // Update lowest price
        const lowest = this.lowestSinceEntry.get(position.symbol) || position.entryPrice;
        if (currentPrice < lowest) {
          this.lowestSinceEntry.set(position.symbol, currentPrice);
        }

        const trailingStop = (this.lowestSinceEntry.get(position.symbol) || lowest) + atr * this.params.atrMultiplierTrailingSL;

        // Check trailing stop
        if (currentPrice > trailingStop) {
          this.lowestSinceEntry.delete(position.symbol);
          return { shouldExit: true, reason: 'Trailing stop hit' };
        }

        // Check RSI divergence
        if (rsi < this.params.rsiOversold && IndicatorComputer.hasRsiDivergence(candles)) {
          this.lowestSinceEntry.delete(position.symbol);
          return { shouldExit: true, reason: 'RSI divergence' };
        }

        // Check failed breakdown
        const metadata = position.strategyName === this.name ? (position as any).metadata : null;
        if (metadata?.breakdownLevel && currentPrice > metadata.breakdownLevel) {
          this.lowestSinceEntry.delete(position.symbol);
          return { shouldExit: true, reason: 'Failed breakdown' };
        }
      }

      return { shouldExit: false };
    } catch (error) {
      console.error(`[MomentumBreakout] Error checking exit for ${position.symbol}:`, error);
      return { shouldExit: false };
    }
  }

  updateParams(params: Partial<MomentumBreakoutParams>): void {
    this.params = { ...this.params, ...params };
  }
}
