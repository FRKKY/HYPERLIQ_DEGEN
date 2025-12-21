import { Pool, PoolClient, PoolConfig } from 'pg';
import {
  Candle,
  FundingRate,
  Signal,
  Trade,
  Position,
  StrategyPerformance,
  SystemState,
  StrategyAllocation,
  MCLDecision,
  Alert,
  SystemHealthCheck,
  StrategyName,
} from '../types';
import { logger, healthChecker, createDatabaseHealthCheck, DatabaseError } from '../utils';

export class Database {
  private pool: Pool;

  constructor(connectionString: string) {
    const poolConfig: PoolConfig = {
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // Pool configuration
      max: parseInt(process.env.DB_POOL_MAX || '20', 10),
      min: parseInt(process.env.DB_POOL_MIN || '5', 10),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '5000', 10),
      // Keep connections alive
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    };

    this.pool = new Pool(poolConfig);

    // Handle pool errors
    this.pool.on('error', (err) => {
      logger.error('Database', 'Unexpected pool error', { error: err.message });
    });

    this.pool.on('connect', () => {
      logger.debug('Database', 'New client connected to pool');
    });

    this.pool.on('remove', () => {
      logger.debug('Database', 'Client removed from pool');
    });

    // Register health check
    healthChecker.registerCheck('database', createDatabaseHealthCheck(this.pool));
  }

  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1'); // Verify connection works
      client.release();
      logger.info('Database', 'Connected to PostgreSQL', {
        poolSize: this.pool.totalCount,
        idleCount: this.pool.idleCount,
      });
    } catch (error) {
      logger.error('Database', 'Failed to connect to PostgreSQL', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new DatabaseError('Failed to connect to database');
    }
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
    logger.info('Database', 'Disconnected from PostgreSQL');
  }

  getPoolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows as T[] };
  }

  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  // ===== CANDLES =====

  async insertCandle(candle: Candle): Promise<void> {
    await this.pool.query(
      `INSERT INTO candles (symbol, timeframe, open_time, open, high, low, close, volume)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
       close = EXCLUDED.close, volume = EXCLUDED.volume`,
      [candle.symbol, candle.timeframe, candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
    );
  }

  async insertCandles(candles: Candle[]): Promise<void> {
    if (candles.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const candle of candles) {
        await client.query(
          `INSERT INTO candles (symbol, timeframe, open_time, open, high, low, close, volume)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET
           open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
           close = EXCLUDED.close, volume = EXCLUDED.volume`,
          [candle.symbol, candle.timeframe, candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getCandles(symbol: string, timeframe: string, limit: number = 500): Promise<Candle[]> {
    const result = await this.pool.query<Candle>(
      `SELECT symbol, timeframe, open_time as "openTime", open, high, low, close, volume
       FROM candles WHERE symbol = $1 AND timeframe = $2
       ORDER BY open_time DESC LIMIT $3`,
      [symbol, timeframe, limit]
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

  // ===== FUNDING RATES =====

  async insertFundingRate(rate: FundingRate): Promise<void> {
    await this.pool.query(
      `INSERT INTO funding_rates (symbol, funding_time, funding_rate, mark_price)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (symbol, funding_time) DO NOTHING`,
      [rate.symbol, rate.fundingTime, rate.fundingRate, rate.markPrice]
    );
  }

  async insertFundingRates(rates: FundingRate[]): Promise<void> {
    if (rates.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const rate of rates) {
        await client.query(
          `INSERT INTO funding_rates (symbol, funding_time, funding_rate, mark_price)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (symbol, funding_time) DO NOTHING`,
          [rate.symbol, rate.fundingTime, rate.fundingRate, rate.markPrice]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getFundingRates(symbol: string, hours: number = 24): Promise<FundingRate[]> {
    const result = await this.pool.query<FundingRate>(
      `SELECT symbol, funding_time as "fundingTime", funding_rate as "fundingRate", mark_price as "markPrice"
       FROM funding_rates WHERE symbol = $1 AND funding_time > NOW() - INTERVAL '${hours} hours'
       ORDER BY funding_time DESC`,
      [symbol]
    );
    return result.rows.map((r) => ({
      ...r,
      fundingRate: Number(r.fundingRate),
      markPrice: Number(r.markPrice),
    }));
  }

  // ===== SIGNALS =====

  async insertSignal(signal: Signal): Promise<void> {
    await this.pool.query(
      `INSERT INTO signals (strategy_name, symbol, signal_time, direction, strength, entry_price, stop_loss, take_profit, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [signal.strategyName, signal.symbol, signal.signalTime, signal.direction, signal.strength, signal.entryPrice, signal.stopLoss, signal.takeProfit, signal.metadata]
    );
  }

  async getRecentSignals(strategyName?: string, limit: number = 50): Promise<Signal[]> {
    const sql = strategyName
      ? `SELECT strategy_name as "strategyName", symbol, signal_time as "signalTime", direction, strength, entry_price as "entryPrice", stop_loss as "stopLoss", take_profit as "takeProfit", metadata
         FROM signals WHERE strategy_name = $1 ORDER BY signal_time DESC LIMIT $2`
      : `SELECT strategy_name as "strategyName", symbol, signal_time as "signalTime", direction, strength, entry_price as "entryPrice", stop_loss as "stopLoss", take_profit as "takeProfit", metadata
         FROM signals ORDER BY signal_time DESC LIMIT $1`;

    const params = strategyName ? [strategyName, limit] : [limit];
    const result = await this.pool.query<Signal>(sql, params);
    return result.rows.map((r) => ({
      ...r,
      strategyName: r.strategyName as StrategyName,
      strength: Number(r.strength),
      entryPrice: r.entryPrice ? Number(r.entryPrice) : undefined,
      stopLoss: r.stopLoss ? Number(r.stopLoss) : undefined,
      takeProfit: r.takeProfit ? Number(r.takeProfit) : undefined,
    }));
  }

  // ===== TRADES =====

  async insertTrade(trade: Trade): Promise<void> {
    await this.pool.query(
      `INSERT INTO trades (trade_id, strategy_name, symbol, side, direction, quantity, price, fee, leverage, executed_at, order_type, pnl, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [trade.tradeId, trade.strategyName, trade.symbol, trade.side, trade.direction, trade.quantity, trade.price, trade.fee, trade.leverage, trade.executedAt, trade.orderType, trade.pnl, trade.metadata]
    );
  }

  async getRecentTrades(limit: number = 50): Promise<Trade[]> {
    const result = await this.pool.query<Trade>(
      `SELECT trade_id as "tradeId", strategy_name as "strategyName", symbol, side, direction, quantity, price, fee, leverage, executed_at as "executedAt", order_type as "orderType", pnl, metadata
       FROM trades ORDER BY executed_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map((r) => ({
      ...r,
      strategyName: r.strategyName as StrategyName,
      quantity: Number(r.quantity),
      price: Number(r.price),
      fee: r.fee ? Number(r.fee) : undefined,
      pnl: r.pnl ? Number(r.pnl) : undefined,
    }));
  }

  // ===== POSITIONS =====

  async syncPositions(positions: Position[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM positions');
      for (const pos of positions) {
        await client.query(
          `INSERT INTO positions (symbol, side, size, entry_price, leverage, liquidation_price, unrealized_pnl, margin_used, strategy_name, opened_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [pos.symbol, pos.side, pos.size, pos.entryPrice, pos.leverage, pos.liquidationPrice, pos.unrealizedPnl, pos.marginUsed, pos.strategyName, pos.openedAt]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPositions(): Promise<Position[]> {
    const result = await this.pool.query<Position>(
      `SELECT symbol, side, size, entry_price as "entryPrice", leverage, liquidation_price as "liquidationPrice", unrealized_pnl as "unrealizedPnl", margin_used as "marginUsed", strategy_name as "strategyName", opened_at as "openedAt"
       FROM positions`
    );
    return result.rows.map((r) => ({
      ...r,
      strategyName: r.strategyName as StrategyName,
      size: Number(r.size),
      entryPrice: Number(r.entryPrice),
      liquidationPrice: r.liquidationPrice ? Number(r.liquidationPrice) : undefined,
      unrealizedPnl: Number(r.unrealizedPnl),
      marginUsed: Number(r.marginUsed),
    }));
  }

  // ===== ACCOUNT SNAPSHOTS =====

  async insertAccountSnapshot(
    equity: number,
    availableBalance: number,
    totalMarginUsed: number,
    unrealizedPnl: number,
    realizedPnl24h: number,
    peakEquity: number,
    drawdownPct: number
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO account_snapshots (snapshot_time, equity, available_balance, total_margin_used, unrealized_pnl, realized_pnl_24h, peak_equity, drawdown_pct)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7)`,
      [equity, availableBalance, totalMarginUsed, unrealizedPnl, realizedPnl24h, peakEquity, drawdownPct]
    );
  }

  async getEquityHistory(hours: number = 168): Promise<{ snapshotTime: Date; equity: number }[]> {
    const result = await this.pool.query(
      `SELECT snapshot_time as "snapshotTime", equity FROM account_snapshots
       WHERE snapshot_time > NOW() - INTERVAL '${hours} hours'
       ORDER BY snapshot_time ASC`
    );
    return result.rows.map((r) => ({
      snapshotTime: r.snapshotTime,
      equity: Number(r.equity),
    }));
  }

  // ===== STRATEGY PERFORMANCE =====

  async getStrategyPerformances(periodHours: number = 24): Promise<StrategyPerformance[]> {
    const result = await this.pool.query<StrategyPerformance>(
      `SELECT strategy_name as "strategyName", period_start as "periodStart", period_end as "periodEnd",
              total_trades as "totalTrades", winning_trades as "winningTrades", losing_trades as "losingTrades",
              total_pnl as "totalPnl", max_drawdown as "maxDrawdown", sharpe_ratio as "sharpeRatio",
              profit_factor as "profitFactor", avg_win as "avgWin", avg_loss as "avgLoss", consecutive_losses as "consecutiveLosses"
       FROM strategy_performance
       WHERE period_end > NOW() - INTERVAL '${periodHours} hours'
       ORDER BY period_end DESC`
    );
    return result.rows.map((r) => ({
      ...r,
      strategyName: r.strategyName as StrategyName,
      totalPnl: Number(r.totalPnl),
      maxDrawdown: Number(r.maxDrawdown),
      sharpeRatio: Number(r.sharpeRatio),
      profitFactor: Number(r.profitFactor),
      avgWin: Number(r.avgWin),
      avgLoss: Number(r.avgLoss),
    }));
  }

  async updateStrategyPerformance(perf: StrategyPerformance): Promise<void> {
    await this.pool.query(
      `INSERT INTO strategy_performance (strategy_name, period_start, period_end, total_trades, winning_trades, losing_trades, total_pnl, max_drawdown, sharpe_ratio, profit_factor, avg_win, avg_loss, consecutive_losses)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [perf.strategyName, perf.periodStart, perf.periodEnd, perf.totalTrades, perf.winningTrades, perf.losingTrades, perf.totalPnl, perf.maxDrawdown, perf.sharpeRatio, perf.profitFactor, perf.avgWin, perf.avgLoss, perf.consecutiveLosses]
    );
  }

  // ===== MCL DECISIONS =====

  async insertMCLDecision(decision: MCLDecision & { llmModel?: string; tokensUsed?: number; latencyMs?: number }): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO mcl_decisions (decision_time, decision_type, inputs, outputs, reasoning, confidence, llm_model, tokens_used, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [decision.decisionTime, decision.decisionType, decision.inputs, decision.outputs, decision.reasoning, decision.confidence, decision.llmModel, decision.tokensUsed, decision.latencyMs]
    );
    return result.rows[0].id;
  }

  async getRecentMCLDecisions(limit: number = 24): Promise<MCLDecision[]> {
    const result = await this.pool.query(
      `SELECT decision_time as "decisionTime", decision_type as "decisionType", inputs, outputs, reasoning, confidence
       FROM mcl_decisions ORDER BY decision_time DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map((r) => ({
      ...r,
      confidence: Number(r.confidence),
    }));
  }

  // ===== STRATEGY ALLOCATIONS =====

  async updateAllocations(allocations: StrategyAllocation, reasoning: string, mclDecisionId?: number): Promise<void> {
    // End previous allocation
    await this.pool.query(
      `UPDATE strategy_allocations SET effective_until = NOW() WHERE effective_until IS NULL`
    );

    // Insert new allocation
    await this.pool.query(
      `INSERT INTO strategy_allocations (effective_from, allocations, reasoning, mcl_decision_id)
       VALUES (NOW(), $1, $2, $3)`,
      [allocations, reasoning, mclDecisionId]
    );

    // Update system state
    await this.updateSystemState('current_allocations', allocations);
  }

  async getCurrentAllocations(): Promise<StrategyAllocation> {
    const result = await this.pool.query(
      `SELECT allocations FROM strategy_allocations WHERE effective_until IS NULL ORDER BY effective_from DESC LIMIT 1`
    );
    if (result.rows.length === 0) {
      return { funding_signal: 25, momentum_breakout: 25, mean_reversion: 25, trend_follow: 25 };
    }
    return result.rows[0].allocations;
  }

  // ===== ALERTS =====

  async insertAlert(alert: Alert): Promise<void> {
    await this.pool.query(
      `INSERT INTO alerts (alert_time, alert_type, severity, title, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [alert.alertTime, alert.alertType, alert.severity, alert.title, alert.message]
    );
  }

  async getUnacknowledgedAlerts(): Promise<Alert[]> {
    const result = await this.pool.query<Alert>(
      `SELECT alert_time as "alertTime", alert_type as "alertType", severity, title, message
       FROM alerts WHERE acknowledged = FALSE ORDER BY alert_time DESC`
    );
    return result.rows;
  }

  async acknowledgeAlert(alertId: number, action?: string): Promise<void> {
    await this.pool.query(
      `UPDATE alerts SET acknowledged = TRUE, acknowledged_at = NOW(), action_taken = $2 WHERE id = $1`,
      [alertId, action]
    );
  }

  // ===== SYSTEM HEALTH =====

  async insertHealthCheck(check: SystemHealthCheck): Promise<void> {
    await this.pool.query(
      `INSERT INTO system_health (check_time, component, status, details) VALUES (NOW(), $1, $2, $3)`,
      [check.component, check.status, check.details]
    );
  }

  async getRecentHealthChecks(): Promise<SystemHealthCheck[]> {
    const result = await this.pool.query<SystemHealthCheck>(
      `SELECT DISTINCT ON (component) component, status, details
       FROM system_health ORDER BY component, check_time DESC`
    );
    return result.rows;
  }

  // ===== SYSTEM STATE =====

  async getSystemState(): Promise<SystemState> {
    const result = await this.pool.query(`SELECT key, value FROM system_state`);
    const state: Record<string, unknown> = {};
    for (const row of result.rows) {
      state[row.key] = row.value;
    }

    return {
      tradingEnabled: state['trading_enabled'] as boolean,
      systemStatus: (state['system_status'] as string).replace(/"/g, '') as SystemState['systemStatus'],
      pauseReason: state['pause_reason'] === 'null' ? null : state['pause_reason'] as string,
      lastMclRun: state['last_mcl_run'] === 'null' ? null : new Date(state['last_mcl_run'] as string),
      currentAllocations: state['current_allocations'] as StrategyAllocation,
      peakEquity: state['peak_equity'] as number,
      dailyStartEquity: state['daily_start_equity'] as number,
      dailyPnl: state['daily_pnl'] as number,
      awaitingGoConfirm: state['awaiting_go_confirm'] as boolean,
      awaitingStopConfirm: state['awaiting_stop_confirm'] as boolean,
    };
  }

  async updateSystemState(key: string, value: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE system_state SET value = $2, updated_at = NOW() WHERE key = $1`,
      [key, JSON.stringify(value)]
    );
  }

  // ===== INDICATORS =====

  async getIndicator(symbol: string, timeframe: string, indicatorName: string, params?: Record<string, unknown>): Promise<number | null> {
    const result = await this.pool.query(
      `SELECT indicator_value FROM indicators
       WHERE symbol = $1 AND timeframe = $2 AND indicator_name = $3 AND parameters = $4
       ORDER BY computed_at DESC LIMIT 1`,
      [symbol, timeframe, indicatorName, params || {}]
    );
    return result.rows.length > 0 ? Number(result.rows[0].indicator_value) : null;
  }

  async setIndicator(symbol: string, timeframe: string, indicatorName: string, value: number, params?: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO indicators (symbol, timeframe, computed_at, indicator_name, indicator_value, parameters)
       VALUES ($1, $2, NOW(), $3, $4, $5)
       ON CONFLICT (symbol, timeframe, computed_at, indicator_name, parameters) DO UPDATE SET indicator_value = EXCLUDED.indicator_value`,
      [symbol, timeframe, indicatorName, value, params || {}]
    );
  }
}
