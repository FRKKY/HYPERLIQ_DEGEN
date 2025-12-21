import { BaseStrategy, StrategyConfig } from './base-strategy';
import { Signal, Position, MeanReversionParams, StrategyName } from '../types';
import { Database } from '../data/database';
import { IndicatorComputer } from '../data/indicator-computer';

const DEFAULT_PARAMS: MeanReversionParams = {
  entryMoveThreshold: 0.03, // 3%
  rsiEntryLong: 25,
  rsiEntryShort: 75,
  rsiExitLong: 50,
  rsiExitShort: 50,
  bbPeriod: 20,
  bbStdDev: 2,
  atrMultiplierSL: 1.5,
  maxHoldHours: 4,
  trendFilterEnabled: true,
};

export class MeanReversionStrategy extends BaseStrategy {
  readonly name: StrategyName = 'mean_reversion';
  readonly config: StrategyConfig = {
    enabled: true,
    capitalUtilization: 0.3,
    maxLeverage: 5,
  };

  private params: MeanReversionParams;

  constructor(db: Database, params?: Partial<MeanReversionParams>) {
    super(db);
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  async generateSignal(symbol: string): Promise<Signal | null> {
    try {
      // Get 1h candles for analysis
      const candles1h = await this.getCandles(symbol, '1h', 50);
      if (candles1h.length < 20) return null;

      // Get 4h candles for trend filter
      const candles4h = await this.getCandles(symbol, '4h', 100);

      const currentCandle = candles1h[0];
      const currentPrice = currentCandle.close;
      const candleMove = (currentCandle.close - currentCandle.open) / currentCandle.open;

      const rsi = IndicatorComputer.rsi(candles1h, 14);
      const bb = IndicatorComputer.bollingerBands(candles1h, this.params.bbPeriod, this.params.bbStdDev);
      const atr = IndicatorComputer.atr(candles1h, 14);
      const ema20 = IndicatorComputer.emaFromCandles(candles1h, 20);

      // Trend filter using 4h EMA
      let inUptrend = true;
      let inDowntrend = true;
      if (this.params.trendFilterEnabled && candles4h.length >= 200) {
        const ema50_4h = IndicatorComputer.emaFromCandles(candles4h, 50);
        const ema200_4h = IndicatorComputer.emaFromCandles(candles4h, 200);
        inUptrend = ema50_4h > ema200_4h;
        inDowntrend = ema50_4h < ema200_4h;
      }

      // LONG entry (fade dump)
      if (
        candleMove < -this.params.entryMoveThreshold &&
        rsi < this.params.rsiEntryLong &&
        currentPrice <= bb.lower &&
        !inDowntrend // Not in strong downtrend
      ) {
        const entryPrice = currentPrice;
        const stopLoss = this.calculateStopLoss(entryPrice, atr, this.params.atrMultiplierSL, true);
        const takeProfit = ema20; // Target the mean

        const strength = Math.min(1, Math.abs(candleMove) / 0.05 + (25 - rsi) / 25);

        return this.createSignal(symbol, 'LONG', strength, entryPrice, stopLoss, takeProfit, {
          candleMove,
          rsi,
          bbLower: bb.lower,
          targetEma: ema20,
        });
      }

      // SHORT entry (fade pump)
      if (
        candleMove > this.params.entryMoveThreshold &&
        rsi > this.params.rsiEntryShort &&
        currentPrice >= bb.upper &&
        !inUptrend // Not in strong uptrend
      ) {
        const entryPrice = currentPrice;
        const stopLoss = this.calculateStopLoss(entryPrice, atr, this.params.atrMultiplierSL, false);
        const takeProfit = ema20; // Target the mean

        const strength = Math.min(1, candleMove / 0.05 + (rsi - 75) / 25);

        return this.createSignal(symbol, 'SHORT', strength, entryPrice, stopLoss, takeProfit, {
          candleMove,
          rsi,
          bbUpper: bb.upper,
          targetEma: ema20,
        });
      }

      return null;
    } catch (error) {
      console.error(`[MeanReversion] Error generating signal for ${symbol}:`, error);
      return null;
    }
  }

  async shouldExit(position: Position, currentPrice: number): Promise<{ shouldExit: boolean; reason?: string }> {
    try {
      const candles = await this.getCandles(position.symbol, '1h', 30);
      if (candles.length < 20) return { shouldExit: false };

      const rsi = IndicatorComputer.rsi(candles, 14);
      const ema20 = IndicatorComputer.emaFromCandles(candles, 20);

      if (position.side === 'LONG') {
        // Exit when price reaches mean (EMA20)
        if (currentPrice >= ema20) {
          return { shouldExit: true, reason: 'Price reached mean' };
        }

        // Exit when RSI normalizes
        if (rsi > this.params.rsiExitLong) {
          return { shouldExit: true, reason: 'RSI normalized' };
        }
      } else {
        // SHORT position
        // Exit when price reaches mean (EMA20)
        if (currentPrice <= ema20) {
          return { shouldExit: true, reason: 'Price reached mean' };
        }

        // Exit when RSI normalizes
        if (rsi < this.params.rsiExitShort) {
          return { shouldExit: true, reason: 'RSI normalized' };
        }
      }

      // Check max hold time
      const holdTimeHours = (Date.now() - position.openedAt.getTime()) / (60 * 60 * 1000);
      if (holdTimeHours >= this.params.maxHoldHours) {
        return { shouldExit: true, reason: 'Max hold time exceeded' };
      }

      return { shouldExit: false };
    } catch (error) {
      console.error(`[MeanReversion] Error checking exit for ${position.symbol}:`, error);
      return { shouldExit: false };
    }
  }

  updateParams(params: Partial<MeanReversionParams>): void {
    this.params = { ...this.params, ...params };
  }
}
