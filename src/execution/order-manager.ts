import { HyperliquidRestClient } from '../hyperliquid';
import { Database } from '../data/database';
import { RiskManager } from './risk-manager';
import { PositionTracker } from './position-tracker';
import { Signal, TradeResult, Trade, StrategyAllocation, Environment } from '../types';

const STRATEGY_CONFIGS = {
  funding_signal: { capitalUtilization: 0.5, maxLeverage: 10 },
  momentum_breakout: { capitalUtilization: 0.4, maxLeverage: 8 },
  mean_reversion: { capitalUtilization: 0.3, maxLeverage: 5 },
  trend_follow: { capitalUtilization: 0.5, maxLeverage: 6 },
};

export class OrderManager {
  private client: HyperliquidRestClient;
  private db: Database;
  private riskManager: RiskManager;
  private positionTracker: PositionTracker;

  constructor(
    client: HyperliquidRestClient,
    db: Database,
    riskManager: RiskManager,
    positionTracker: PositionTracker
  ) {
    this.client = client;
    this.db = db;
    this.riskManager = riskManager;
    this.positionTracker = positionTracker;
  }

  async executeSignal(
    signal: Signal,
    allocation: number,
    equity: number,
    environment: Environment = 'mainnet',
    strategyVersionId?: number
  ): Promise<TradeResult> {
    try {
      // 1. Pre-trade risk checks
      const riskCheck = await this.riskManager.checkPreTrade(signal, allocation, equity);
      if (!riskCheck.approved) {
        console.log(`[OrderManager] Trade rejected: ${riskCheck.reason}`);
        return { success: false, reason: riskCheck.reason };
      }

      // 2. Get current price
      const mids = await this.client.getAllMids();
      const currentPrice = parseFloat(mids[signal.symbol]);
      if (!currentPrice) {
        return { success: false, reason: `Unable to get price for ${signal.symbol}` };
      }

      // 3. Calculate position size
      const strategyConfig = STRATEGY_CONFIGS[signal.strategyName];
      const entryPrice = signal.entryPrice || currentPrice;
      const stopLoss = signal.stopLoss || entryPrice * (signal.direction === 'LONG' ? 0.95 : 1.05);

      const positionSize = this.riskManager.calculatePositionSize(
        allocation,
        equity,
        entryPrice,
        stopLoss,
        Math.min(riskCheck.maxLeverage, strategyConfig.maxLeverage),
        strategyConfig.capitalUtilization
      );

      // 4. Set leverage if needed
      try {
        await this.client.updateLeverage(signal.symbol, positionSize.leverage);
      } catch (error) {
        console.error(`[OrderManager] Failed to set leverage:`, error);
        // Continue anyway, leverage might already be set
      }

      // 5. Determine trade direction
      const isBuy = signal.direction === 'LONG' || signal.direction === 'CLOSE';
      const isClose = signal.direction === 'CLOSE';

      // 6. Execute order
      const result = await this.client.placeMarketOrder(signal.symbol, isBuy, positionSize.size, isClose);

      // Log full response for debugging
      console.log(`[OrderManager] Order response:`, JSON.stringify(result, null, 2));

      if (result.status === 'ok') {
        const status = result.response?.data?.statuses?.[0];
        const orderId = status?.resting?.oid || status?.filled?.oid;

        // Check for error in status
        if (status?.error) {
          console.error(`[OrderManager] Order error from exchange:`, status.error);
          return { success: false, reason: status.error };
        }

        // 7. Log trade with environment and version info
        await this.db.query(
          `INSERT INTO trades (trade_id, strategy_name, symbol, side, direction, quantity, price, fee, leverage, executed_at, order_type, pnl, metadata, environment, strategy_version_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            orderId?.toString(),
            signal.strategyName,
            signal.symbol,
            isBuy ? 'BUY' : 'SELL',
            signal.direction === 'LONG' ? 'OPEN_LONG' : signal.direction === 'SHORT' ? 'OPEN_SHORT' : signal.direction === 'CLOSE' ? (isBuy ? 'CLOSE_SHORT' : 'CLOSE_LONG') : 'OPEN_LONG',
            positionSize.size,
            currentPrice,
            undefined,
            positionSize.leverage,
            new Date(),
            'MARKET',
            undefined,
            signal.metadata,
            environment,
            strategyVersionId,
          ]
        );

        // Log signal with environment info
        await this.db.query(
          `INSERT INTO signals (strategy_name, symbol, signal_time, direction, strength, entry_price, stop_loss, take_profit, metadata, environment, strategy_version_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            signal.strategyName,
            signal.symbol,
            signal.signalTime,
            signal.direction,
            signal.strength,
            signal.entryPrice,
            signal.stopLoss,
            signal.takeProfit,
            signal.metadata,
            environment,
            strategyVersionId,
          ]
        );

        // 8. Update position tracker
        this.positionTracker.setPositionStrategy(signal.symbol, signal.strategyName);
        await this.positionTracker.updatePosition(signal.symbol);

        console.log(
          `[OrderManager] Trade executed (${environment}): ${signal.symbol} ${signal.direction} ${positionSize.size.toFixed(4)} @ $${currentPrice.toFixed(2)} (${positionSize.leverage}x)`
        );

        return { success: true, orderId: orderId?.toString() };
      } else {
        const errorMsg = result.response?.data?.statuses?.[0]?.error || 'Unknown error';
        console.error(`[OrderManager] Order failed:`, errorMsg);
        return { success: false, reason: errorMsg };
      }
    } catch (error: unknown) {
      // Extract detailed error info from axios errors
      let errorMsg = 'Unknown error';
      if (error instanceof Error) {
        errorMsg = error.message;
      }
      // Check for axios error with response data
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as { response?: { data?: unknown; status?: number } };
        if (axiosError.response?.data) {
          console.error(`[OrderManager] API response error:`, JSON.stringify(axiosError.response.data, null, 2));
          errorMsg = JSON.stringify(axiosError.response.data);
        }
        if (axiosError.response?.status) {
          console.error(`[OrderManager] HTTP status:`, axiosError.response.status);
        }
      }
      console.error(`[OrderManager] Execution error:`, error);
      return { success: false, reason: errorMsg };
    }
  }

  async closePosition(symbol: string, reason: string): Promise<TradeResult> {
    try {
      const position = this.positionTracker.getPosition(symbol);
      if (!position) {
        return { success: false, reason: 'Position not found' };
      }

      const result = await this.client.closePosition(symbol);

      if (result.status === 'ok') {
        const mids = await this.client.getAllMids();
        const closePrice = parseFloat(mids[symbol]) || position.entryPrice;

        // Calculate P&L
        const pnl = position.side === 'LONG'
          ? (closePrice - position.entryPrice) * position.size
          : (position.entryPrice - closePrice) * position.size;

        // Log trade
        const trade: Trade = {
          strategyName: position.strategyName,
          symbol,
          side: position.side === 'LONG' ? 'SELL' : 'BUY',
          direction: position.side === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
          quantity: position.size,
          price: closePrice,
          leverage: position.leverage,
          executedAt: new Date(),
          orderType: 'MARKET',
          pnl,
          metadata: { closeReason: reason },
        };

        await this.db.insertTrade(trade);

        // Clear position strategy mapping
        this.positionTracker.clearPositionStrategy(symbol);
        await this.positionTracker.updatePosition(symbol);

        console.log(
          `[OrderManager] Position closed: ${symbol} ${position.side} @ $${closePrice.toFixed(2)} P&L: $${pnl.toFixed(2)} (${reason})`
        );

        return { success: true };
      } else {
        return { success: false, reason: 'Close order failed' };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[OrderManager] Close position error:`, error);
      return { success: false, reason: errorMsg };
    }
  }

  async closeAllPositions(reason: string): Promise<TradeResult[]> {
    const positions = this.positionTracker.getAllPositions();
    const results: TradeResult[] = [];

    for (const position of positions) {
      const result = await this.closePosition(position.symbol, reason);
      results.push(result);
    }

    return results;
  }
}
