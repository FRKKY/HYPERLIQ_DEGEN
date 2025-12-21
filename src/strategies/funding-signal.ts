import { BaseStrategy, StrategyConfig } from './base-strategy';
import { Signal, Position, FundingSignalParams, StrategyName } from '../types';
import { Database } from '../data/database';
import { IndicatorComputer } from '../data/indicator-computer';

const DEFAULT_PARAMS: FundingSignalParams = {
  entryThresholdLong: -0.0001, // -0.01%
  entryThresholdShort: 0.0003, // 0.03%
  exitThresholdLong: 0,
  exitThresholdShort: 0.0001,
  atrMultiplierSL: 2,
  atrMultiplierTP: 3,
  maxHoldHours: 8,
  useEmaFilter: true,
  emaPeriod: 20,
};

export class FundingSignalStrategy extends BaseStrategy {
  readonly name: StrategyName = 'funding_signal';
  readonly config: StrategyConfig = {
    enabled: true,
    capitalUtilization: 0.5,
    maxLeverage: 10,
  };

  private params: FundingSignalParams;

  constructor(db: Database, params?: Partial<FundingSignalParams>) {
    super(db);
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  async generateSignal(symbol: string): Promise<Signal | null> {
    try {
      // Get funding rates
      const fundingRates = await this.db.getFundingRates(symbol, 24);
      if (fundingRates.length === 0) return null;

      const currentFundingRate = fundingRates[0].fundingRate;

      // Calculate 4h average funding rate
      const fourHourAgoTime = Date.now() - 4 * 60 * 60 * 1000;
      const recentRates = fundingRates.filter((r) => r.fundingTime.getTime() > fourHourAgoTime);
      const avgFundingRate =
        recentRates.length > 0 ? recentRates.reduce((sum, r) => sum + r.fundingRate, 0) / recentRates.length : currentFundingRate;

      // Get candles for EMA filter and ATR
      const candles = await this.getCandles(symbol, '1h', 50);
      if (candles.length < 20) return null;

      const currentPrice = candles[0].close;
      const ema20 = IndicatorComputer.emaFromCandles(candles, this.params.emaPeriod);
      const atr = IndicatorComputer.atr(candles, 14);

      // Check LONG entry conditions
      if (
        currentFundingRate < this.params.entryThresholdLong &&
        avgFundingRate < this.params.entryThresholdLong * 0.8
      ) {
        // EMA filter: price should be above EMA for longs
        if (this.params.useEmaFilter && currentPrice < ema20) {
          return null;
        }

        const entryPrice = currentPrice;
        const stopLoss = this.calculateStopLoss(entryPrice, atr, this.params.atrMultiplierSL, true);
        const takeProfit = this.calculateTakeProfit(entryPrice, atr, this.params.atrMultiplierTP, true);

        const strength = Math.min(1, Math.abs(currentFundingRate) / 0.0005);

        return this.createSignal(symbol, 'LONG', strength, entryPrice, stopLoss, takeProfit, {
          currentFundingRate,
          avgFundingRate,
          ema20,
        });
      }

      // Check SHORT entry conditions
      if (
        currentFundingRate > this.params.entryThresholdShort &&
        avgFundingRate > this.params.entryThresholdShort * 0.67
      ) {
        // EMA filter: price should be below EMA for shorts
        if (this.params.useEmaFilter && currentPrice > ema20) {
          return null;
        }

        const entryPrice = currentPrice;
        const stopLoss = this.calculateStopLoss(entryPrice, atr, this.params.atrMultiplierSL, false);
        const takeProfit = this.calculateTakeProfit(entryPrice, atr, this.params.atrMultiplierTP, false);

        const strength = Math.min(1, currentFundingRate / 0.001);

        return this.createSignal(symbol, 'SHORT', strength, entryPrice, stopLoss, takeProfit, {
          currentFundingRate,
          avgFundingRate,
          ema20,
        });
      }

      return null;
    } catch (error) {
      console.error(`[FundingSignal] Error generating signal for ${symbol}:`, error);
      return null;
    }
  }

  async shouldExit(position: Position, currentPrice: number): Promise<{ shouldExit: boolean; reason?: string }> {
    try {
      // Get current funding rate
      const fundingRates = await this.db.getFundingRates(position.symbol, 4);
      if (fundingRates.length === 0) return { shouldExit: false };

      const currentFundingRate = fundingRates[0].fundingRate;

      // Check funding rate normalization
      if (position.side === 'LONG' && currentFundingRate > this.params.exitThresholdLong) {
        return { shouldExit: true, reason: 'Funding rate normalized' };
      }

      if (position.side === 'SHORT' && currentFundingRate < this.params.exitThresholdShort) {
        return { shouldExit: true, reason: 'Funding rate normalized' };
      }

      // Check max hold time
      const holdTimeHours = (Date.now() - position.openedAt.getTime()) / (60 * 60 * 1000);
      if (holdTimeHours >= this.params.maxHoldHours) {
        return { shouldExit: true, reason: 'Max hold time exceeded' };
      }

      return { shouldExit: false };
    } catch (error) {
      console.error(`[FundingSignal] Error checking exit for ${position.symbol}:`, error);
      return { shouldExit: false };
    }
  }

  updateParams(params: Partial<FundingSignalParams>): void {
    this.params = { ...this.params, ...params };
  }
}
