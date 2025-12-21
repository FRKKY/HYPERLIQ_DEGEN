import { BaseStrategy, StrategyConfig } from './base-strategy';
import { Signal, Position, TrendFollowParams, StrategyName, Timeframe } from '../types';
import { Database } from '../data/database';
import { IndicatorComputer } from '../data/indicator-computer';

const DEFAULT_PARAMS: TrendFollowParams = {
  fastEmaPeriod: 20,
  slowEmaPeriod: 50,
  adxEntryThreshold: 25,
  adxExitThreshold: 20,
  atrMultiplierTrailingSL: 2.5,
  timeframe: '4h',
  consecutiveClosesForExit: 2,
};

export class TrendFollowStrategy extends BaseStrategy {
  readonly name: StrategyName = 'trend_follow';
  readonly config: StrategyConfig = {
    enabled: true,
    capitalUtilization: 0.5,
    maxLeverage: 6,
  };

  private params: TrendFollowParams;
  private highestSinceEntry: Map<string, number> = new Map();
  private lowestSinceEntry: Map<string, number> = new Map();
  private closesAboveSlowEma: Map<string, number> = new Map();
  private closesBelowSlowEma: Map<string, number> = new Map();

  constructor(db: Database, params?: Partial<TrendFollowParams>) {
    super(db);
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  async generateSignal(symbol: string): Promise<Signal | null> {
    try {
      // Get candles for the configured timeframe
      const candles = await this.getCandles(symbol, this.params.timeframe, 100);
      if (candles.length < this.params.slowEmaPeriod + 10) return null;

      const currentPrice = candles[0].close;
      const fastEma = IndicatorComputer.emaFromCandles(candles, this.params.fastEmaPeriod);
      const slowEma = IndicatorComputer.emaFromCandles(candles, this.params.slowEmaPeriod);
      const adx = IndicatorComputer.adx(candles, 14);
      const macd = IndicatorComputer.macd(candles);
      const atr = IndicatorComputer.atr(candles, 14);

      // Check for EMA crossover
      const { isBullishCross, isBearishCross } = IndicatorComputer.emaCrossover(
        candles,
        this.params.fastEmaPeriod,
        this.params.slowEmaPeriod
      );

      // LONG entry
      if (
        isBullishCross &&
        adx > this.params.adxEntryThreshold &&
        currentPrice > fastEma &&
        macd.histogram > 0
      ) {
        const entryPrice = currentPrice;
        const stopLoss = this.calculateStopLoss(entryPrice, atr, this.params.atrMultiplierTrailingSL, true);

        const strength = Math.min(1, adx / 40 + macd.histogram / Math.abs(macd.macd || 1));

        // Initialize tracking
        this.highestSinceEntry.set(symbol, currentPrice);
        this.closesBelowSlowEma.set(symbol, 0);

        return this.createSignal(symbol, 'LONG', strength, entryPrice, stopLoss, undefined, {
          fastEma,
          slowEma,
          adx,
          macdHistogram: macd.histogram,
        });
      }

      // SHORT entry
      if (
        isBearishCross &&
        adx > this.params.adxEntryThreshold &&
        currentPrice < fastEma &&
        macd.histogram < 0
      ) {
        const entryPrice = currentPrice;
        const stopLoss = this.calculateStopLoss(entryPrice, atr, this.params.atrMultiplierTrailingSL, false);

        const strength = Math.min(1, adx / 40 + Math.abs(macd.histogram) / Math.abs(macd.macd || 1));

        // Initialize tracking
        this.lowestSinceEntry.set(symbol, currentPrice);
        this.closesAboveSlowEma.set(symbol, 0);

        return this.createSignal(symbol, 'SHORT', strength, entryPrice, stopLoss, undefined, {
          fastEma,
          slowEma,
          adx,
          macdHistogram: macd.histogram,
        });
      }

      return null;
    } catch (error) {
      console.error(`[TrendFollow] Error generating signal for ${symbol}:`, error);
      return null;
    }
  }

  async shouldExit(position: Position, currentPrice: number): Promise<{ shouldExit: boolean; reason?: string }> {
    try {
      const candles = await this.getCandles(position.symbol, this.params.timeframe, 60);
      if (candles.length < this.params.slowEmaPeriod) return { shouldExit: false };

      const fastEma = IndicatorComputer.emaFromCandles(candles, this.params.fastEmaPeriod);
      const slowEma = IndicatorComputer.emaFromCandles(candles, this.params.slowEmaPeriod);
      const adx = IndicatorComputer.adx(candles, 14);
      const atr = IndicatorComputer.atr(candles, 14);

      const { isBullishCross, isBearishCross } = IndicatorComputer.emaCrossover(
        candles,
        this.params.fastEmaPeriod,
        this.params.slowEmaPeriod
      );

      if (position.side === 'LONG') {
        // Check for bearish EMA crossover
        if (isBearishCross) {
          this.cleanup(position.symbol);
          return { shouldExit: true, reason: 'EMA bearish crossover' };
        }

        // Check ADX exhaustion
        if (adx < this.params.adxExitThreshold) {
          this.cleanup(position.symbol);
          return { shouldExit: true, reason: 'Trend exhaustion (ADX)' };
        }

        // Update highest price for trailing stop
        const highest = this.highestSinceEntry.get(position.symbol) || position.entryPrice;
        if (currentPrice > highest) {
          this.highestSinceEntry.set(position.symbol, currentPrice);
        }

        const trailingStop =
          (this.highestSinceEntry.get(position.symbol) || highest) - atr * this.params.atrMultiplierTrailingSL;
        if (currentPrice < trailingStop) {
          this.cleanup(position.symbol);
          return { shouldExit: true, reason: 'Trailing stop hit' };
        }

        // Check consecutive closes below slow EMA
        if (currentPrice < slowEma) {
          const count = (this.closesBelowSlowEma.get(position.symbol) || 0) + 1;
          this.closesBelowSlowEma.set(position.symbol, count);

          if (count >= this.params.consecutiveClosesForExit) {
            this.cleanup(position.symbol);
            return { shouldExit: true, reason: 'Consecutive closes below slow EMA' };
          }
        } else {
          this.closesBelowSlowEma.set(position.symbol, 0);
        }
      } else {
        // SHORT position
        // Check for bullish EMA crossover
        if (isBullishCross) {
          this.cleanup(position.symbol);
          return { shouldExit: true, reason: 'EMA bullish crossover' };
        }

        // Check ADX exhaustion
        if (adx < this.params.adxExitThreshold) {
          this.cleanup(position.symbol);
          return { shouldExit: true, reason: 'Trend exhaustion (ADX)' };
        }

        // Update lowest price for trailing stop
        const lowest = this.lowestSinceEntry.get(position.symbol) || position.entryPrice;
        if (currentPrice < lowest) {
          this.lowestSinceEntry.set(position.symbol, currentPrice);
        }

        const trailingStop =
          (this.lowestSinceEntry.get(position.symbol) || lowest) + atr * this.params.atrMultiplierTrailingSL;
        if (currentPrice > trailingStop) {
          this.cleanup(position.symbol);
          return { shouldExit: true, reason: 'Trailing stop hit' };
        }

        // Check consecutive closes above slow EMA
        if (currentPrice > slowEma) {
          const count = (this.closesAboveSlowEma.get(position.symbol) || 0) + 1;
          this.closesAboveSlowEma.set(position.symbol, count);

          if (count >= this.params.consecutiveClosesForExit) {
            this.cleanup(position.symbol);
            return { shouldExit: true, reason: 'Consecutive closes above slow EMA' };
          }
        } else {
          this.closesAboveSlowEma.set(position.symbol, 0);
        }
      }

      return { shouldExit: false };
    } catch (error) {
      console.error(`[TrendFollow] Error checking exit for ${position.symbol}:`, error);
      return { shouldExit: false };
    }
  }

  private cleanup(symbol: string): void {
    this.highestSinceEntry.delete(symbol);
    this.lowestSinceEntry.delete(symbol);
    this.closesAboveSlowEma.delete(symbol);
    this.closesBelowSlowEma.delete(symbol);
  }

  updateParams(params: Partial<TrendFollowParams>): void {
    this.params = { ...this.params, ...params };
  }
}
