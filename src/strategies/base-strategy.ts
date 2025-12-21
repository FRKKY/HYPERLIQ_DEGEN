import { Signal, StrategyName, Candle, Position } from '../types';
import { Database } from '../data/database';
import { IndicatorComputer } from '../data/indicator-computer';

export interface StrategyConfig {
  enabled: boolean;
  capitalUtilization: number;
  maxLeverage: number;
}

export abstract class BaseStrategy {
  abstract readonly name: StrategyName;
  abstract readonly config: StrategyConfig;

  protected db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  abstract generateSignal(symbol: string): Promise<Signal | null>;

  abstract shouldExit(position: Position, currentPrice: number): Promise<{ shouldExit: boolean; reason?: string }>;

  protected async getCandles(symbol: string, timeframe: string, limit: number = 100): Promise<Candle[]> {
    return this.db.getCandles(symbol, timeframe, limit);
  }

  protected createSignal(
    symbol: string,
    direction: Signal['direction'],
    strength: number,
    entryPrice?: number,
    stopLoss?: number,
    takeProfit?: number,
    metadata?: Record<string, unknown>
  ): Signal {
    return {
      strategyName: this.name,
      symbol,
      signalTime: new Date(),
      direction,
      strength,
      entryPrice,
      stopLoss,
      takeProfit,
      metadata,
    };
  }

  protected calculateStopLoss(entryPrice: number, atr: number, multiplier: number, isLong: boolean): number {
    return isLong ? entryPrice - atr * multiplier : entryPrice + atr * multiplier;
  }

  protected calculateTakeProfit(entryPrice: number, atr: number, multiplier: number, isLong: boolean): number {
    return isLong ? entryPrice + atr * multiplier : entryPrice - atr * multiplier;
  }
}
