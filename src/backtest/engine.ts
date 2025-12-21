import { Database } from '../data/database';
import { BaseStrategy } from '../strategies/base-strategy';
import { BacktestConfig, BacktestResult, Candle, Signal, StrategyAllocation, StrategyName } from '../types';

interface BacktestPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  entryTime: Date;
  stopLoss?: number;
  takeProfit?: number;
  strategyName: StrategyName;
}

interface BacktestTrade {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  entryTime: Date;
  exitTime: Date;
  pnl: number;
  strategyName: StrategyName;
}

export class BacktestEngine {
  private db: Database;
  private config: BacktestConfig;

  constructor(db: Database, config: BacktestConfig) {
    this.db = db;
    this.config = config;
  }

  async run(strategies: BaseStrategy[], allocations: StrategyAllocation): Promise<BacktestResult> {
    console.log(`[Backtest] Running from ${this.config.startDate.toISOString()} to ${this.config.endDate.toISOString()}`);

    let equity = this.config.initialCapital;
    let peakEquity = equity;
    let maxDrawdown = 0;
    const trades: BacktestTrade[] = [];
    const positions: Map<string, BacktestPosition> = new Map();
    const equityCurve: { date: Date; equity: number }[] = [];

    // Get all symbols
    const symbols = await this.getSymbols();
    console.log(`[Backtest] Processing ${symbols.length} symbols`);

    // Get all candles for the period
    const candlesBySymbol = new Map<string, Candle[]>();
    for (const symbol of symbols) {
      const candles = await this.getCandlesForPeriod(symbol);
      if (candles.length > 0) {
        candlesBySymbol.set(symbol, candles);
      }
    }

    // Simulate day by day
    let currentDate = new Date(this.config.startDate);
    while (currentDate <= this.config.endDate) {
      // Check exits for existing positions
      for (const [symbol, position] of positions) {
        const candles = candlesBySymbol.get(symbol);
        if (!candles) continue;

        const currentCandle = this.getCandleForDate(candles, currentDate);
        if (!currentCandle) continue;

        const currentPrice = currentCandle.close;

        // Check stop loss
        let shouldExit = false;
        let exitReason = '';

        if (position.side === 'LONG') {
          if (position.stopLoss && currentPrice <= position.stopLoss) {
            shouldExit = true;
            exitReason = 'Stop loss';
          } else if (position.takeProfit && currentPrice >= position.takeProfit) {
            shouldExit = true;
            exitReason = 'Take profit';
          }
        } else {
          if (position.stopLoss && currentPrice >= position.stopLoss) {
            shouldExit = true;
            exitReason = 'Stop loss';
          } else if (position.takeProfit && currentPrice <= position.takeProfit) {
            shouldExit = true;
            exitReason = 'Take profit';
          }
        }

        if (shouldExit) {
          const pnl = this.calculatePnl(position, currentPrice);
          trades.push({
            symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice: currentPrice,
            entryTime: position.entryTime,
            exitTime: currentDate,
            pnl: pnl - this.config.commission * position.size * position.entryPrice * 2, // Entry + exit commission
            strategyName: position.strategyName,
          });

          equity += pnl - this.config.commission * position.size * position.entryPrice * 2;
          positions.delete(symbol);
        }
      }

      // Generate new signals
      for (const strategy of strategies) {
        const allocation = allocations[strategy.name];
        if (allocation <= 0) continue;

        for (const symbol of symbols) {
          if (positions.has(symbol)) continue;

          const candles = candlesBySymbol.get(symbol);
          if (!candles) continue;

          // Get historical candles up to current date
          const historicalCandles = candles.filter((c) => c.openTime <= currentDate).slice(0, 100);
          if (historicalCandles.length < 50) continue;

          // Mock the database for the strategy
          const mockDb = this.createMockDb(historicalCandles);

          try {
            // Create a new strategy instance with mock db
            const strategyWithMock = Object.create(strategy);
            strategyWithMock.db = mockDb;

            const signal = await strategyWithMock.generateSignal(symbol);

            if (signal && (signal.direction === 'LONG' || signal.direction === 'SHORT')) {
              const currentPrice = historicalCandles[0].close;
              const positionSize = (equity * (allocation / 100) * 0.3) / currentPrice;

              positions.set(symbol, {
                symbol,
                side: signal.direction,
                size: positionSize,
                entryPrice: currentPrice,
                entryTime: currentDate,
                stopLoss: signal.stopLoss,
                takeProfit: signal.takeProfit,
                strategyName: strategy.name,
              });
            }
          } catch (error) {
            // Skip on error
          }
        }
      }

      // Update equity curve
      let unrealizedPnl = 0;
      for (const [symbol, position] of positions) {
        const candles = candlesBySymbol.get(symbol);
        if (!candles) continue;

        const currentCandle = this.getCandleForDate(candles, currentDate);
        if (!currentCandle) continue;

        unrealizedPnl += this.calculatePnl(position, currentCandle.close);
      }

      const totalEquity = equity + unrealizedPnl;
      equityCurve.push({ date: new Date(currentDate), equity: totalEquity });

      // Update peak and drawdown
      if (totalEquity > peakEquity) {
        peakEquity = totalEquity;
      }
      const currentDrawdown = ((totalEquity - peakEquity) / peakEquity) * 100;
      if (currentDrawdown < maxDrawdown) {
        maxDrawdown = currentDrawdown;
      }

      // Move to next day
      currentDate = new Date(currentDate.getTime() + 24 * 60 * 60 * 1000);
    }

    // Close remaining positions
    for (const [symbol, position] of positions) {
      const candles = candlesBySymbol.get(symbol);
      if (!candles || candles.length === 0) continue;

      const exitPrice = candles[0].close;
      const pnl = this.calculatePnl(position, exitPrice);

      trades.push({
        symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice,
        entryTime: position.entryTime,
        exitTime: this.config.endDate,
        pnl: pnl - this.config.commission * position.size * position.entryPrice * 2,
        strategyName: position.strategyName,
      });

      equity += pnl - this.config.commission * position.size * position.entryPrice * 2;
    }

    // Calculate results
    const winningTrades = trades.filter((t) => t.pnl > 0);
    const losingTrades = trades.filter((t) => t.pnl < 0);

    const totalProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));

    // Calculate Sharpe ratio (simplified)
    const returns = equityCurve.map((e, i) =>
      i === 0 ? 0 : (e.equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity
    );
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdReturn = Math.sqrt(
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    );
    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(365) : 0;

    // Calculate max consecutive losses
    let maxConsecutiveLosses = 0;
    let currentConsecutiveLosses = 0;
    for (const trade of trades) {
      if (trade.pnl < 0) {
        currentConsecutiveLosses++;
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentConsecutiveLosses);
      } else {
        currentConsecutiveLosses = 0;
      }
    }

    return {
      totalReturnPct: ((equity - this.config.initialCapital) / this.config.initialCapital) * 100,
      sharpeRatio,
      maxDrawdownPct: maxDrawdown,
      winRate: trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0,
      profitFactor: totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0,
      totalTrades: trades.length,
      maxConsecutiveLosses,
      equityCurve,
    };
  }

  private async getSymbols(): Promise<string[]> {
    const result = await this.db.query<{ symbol: string }>('SELECT DISTINCT symbol FROM candles');
    return result.rows.map((r) => r.symbol);
  }

  private async getCandlesForPeriod(symbol: string): Promise<Candle[]> {
    const result = await this.db.query<Candle>(
      `SELECT symbol, timeframe, open_time as "openTime", open, high, low, close, volume
       FROM candles
       WHERE symbol = $1 AND timeframe = '1h'
       AND open_time >= $2 AND open_time <= $3
       ORDER BY open_time DESC`,
      [symbol, this.config.startDate, this.config.endDate]
    );

    return result.rows.map((r) => ({
      ...r,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
  }

  private getCandleForDate(candles: Candle[], date: Date): Candle | null {
    const targetTime = date.getTime();
    for (const candle of candles) {
      if (candle.openTime.getTime() <= targetTime) {
        return candle;
      }
    }
    return null;
  }

  private calculatePnl(position: BacktestPosition, exitPrice: number): number {
    if (position.side === 'LONG') {
      return (exitPrice - position.entryPrice) * position.size;
    } else {
      return (position.entryPrice - exitPrice) * position.size;
    }
  }

  private createMockDb(candles: Candle[]): any {
    return {
      getCandles: async () => candles,
      getFundingRates: async () => [],
      getRecentSignals: async () => [],
    };
  }
}
