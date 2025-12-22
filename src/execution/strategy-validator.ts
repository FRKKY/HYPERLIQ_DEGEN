import { Database } from '../data/database';
import { StrategyName, BacktestResult } from '../types';

export interface ValidationCriteria {
  minDataDays: number;
  minTrades: number;
  minSharpeRatio: number;
  maxDrawdownPct: number;
  minWinRatePct: number;
  minProfitFactor: number;
  maxConsecutiveLosses: number;
  minReturnPct: number;
  requireFreshBacktestDays: number;
}

export interface ValidationResult {
  valid: boolean;
  strategyName: StrategyName;
  tradingEnabled: boolean;
  lastBacktestDate?: Date;
  validationErrors: string[];
  warnings: string[];
}

// Tightened thresholds for statistical confidence and risk management
const DEFAULT_CRITERIA: ValidationCriteria = {
  minDataDays: 90,            // 3 months minimum for regime coverage
  minTrades: 100,             // Statistical significance
  minSharpeRatio: 1.0,        // Institutional standard
  maxDrawdownPct: -15.0,      // Tight risk control
  minWinRatePct: 40.0,        // Reasonable for trend-following
  minProfitFactor: 1.5,       // Must be clearly profitable
  maxConsecutiveLosses: 7,    // Manifesto requirement
  minReturnPct: 0.0,          // Must be profitable
  requireFreshBacktestDays: 7,
};

/**
 * StrategyValidator enforces backtest validation before live trading.
 *
 * Strategies must pass backtest criteria before they can execute trades.
 * This ensures agents work with collected historical data first.
 */
export class StrategyValidator {
  private db: Database;
  private criteriaCache: Map<string, ValidationCriteria> = new Map();
  private permissionsCache: Map<StrategyName, boolean> = new Map();
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Check if a strategy is validated for live trading
   */
  async isStrategyValidated(strategyName: StrategyName): Promise<boolean> {
    // Check cache first
    if (Date.now() < this.cacheExpiry && this.permissionsCache.has(strategyName)) {
      return this.permissionsCache.get(strategyName)!;
    }

    try {
      const result = await this.db.query<{ trading_enabled: boolean; validation_expires_at: Date | null }>(
        `SELECT trading_enabled, validation_expires_at
         FROM strategy_trading_permissions
         WHERE strategy_name = $1`,
        [strategyName]
      );

      if (result.rows.length === 0) {
        this.permissionsCache.set(strategyName, false);
        return false;
      }

      const permission = result.rows[0];

      // Check if validation has expired
      if (permission.validation_expires_at && new Date(permission.validation_expires_at) < new Date()) {
        this.permissionsCache.set(strategyName, false);
        return false;
      }

      this.permissionsCache.set(strategyName, permission.trading_enabled);
      this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;

      return permission.trading_enabled;
    } catch (error) {
      console.error(`[StrategyValidator] Error checking validation for ${strategyName}:`, error);
      // Fail closed - if we can't verify, don't allow trading
      return false;
    }
  }

  /**
   * Get full validation status for a strategy
   */
  async getValidationStatus(strategyName: StrategyName): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Get permission status
      const permResult = await this.db.query<{
        trading_enabled: boolean;
        last_validated_at: Date | null;
        validation_expires_at: Date | null;
        disabled_reason: string | null;
      }>(
        `SELECT trading_enabled, last_validated_at, validation_expires_at, disabled_reason
         FROM strategy_trading_permissions
         WHERE strategy_name = $1`,
        [strategyName]
      );

      if (permResult.rows.length === 0) {
        errors.push('Strategy not registered in trading permissions');
        return {
          valid: false,
          strategyName,
          tradingEnabled: false,
          validationErrors: errors,
          warnings,
        };
      }

      const permission = permResult.rows[0];

      // Get latest backtest result
      const backtestResult = await this.db.query<{
        backtest_date: Date;
        validation_passed: boolean;
        validation_errors: string[] | null;
        total_trades: number;
        sharpe_ratio: number;
        max_drawdown_pct: number;
        win_rate_pct: number;
      }>(
        `SELECT backtest_date, validation_passed, validation_errors, total_trades,
                sharpe_ratio, max_drawdown_pct, win_rate_pct
         FROM backtest_results
         WHERE strategy_name = $1
         ORDER BY backtest_date DESC
         LIMIT 1`,
        [strategyName]
      );

      if (backtestResult.rows.length === 0) {
        errors.push('No backtest results found - run backtest first');
        return {
          valid: false,
          strategyName,
          tradingEnabled: false,
          validationErrors: errors,
          warnings,
        };
      }

      const backtest = backtestResult.rows[0];
      const criteria = await this.getCriteria(strategyName);

      // Check backtest freshness
      const daysSinceBacktest = (Date.now() - new Date(backtest.backtest_date).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceBacktest > criteria.requireFreshBacktestDays) {
        errors.push(`Backtest is ${daysSinceBacktest.toFixed(0)} days old (max ${criteria.requireFreshBacktestDays} days)`);
      }

      // Check if validation expired
      if (permission.validation_expires_at && new Date(permission.validation_expires_at) < new Date()) {
        errors.push('Validation has expired - re-run backtest');
      }

      // Add previous validation errors
      if (backtest.validation_errors) {
        errors.push(...backtest.validation_errors);
      }

      // Add warning if disabled
      if (!permission.trading_enabled && permission.disabled_reason) {
        warnings.push(`Disabled: ${permission.disabled_reason}`);
      }

      return {
        valid: permission.trading_enabled && errors.length === 0,
        strategyName,
        tradingEnabled: permission.trading_enabled,
        lastBacktestDate: backtest.backtest_date,
        validationErrors: errors,
        warnings,
      };
    } catch (error) {
      console.error(`[StrategyValidator] Error getting validation status:`, error);
      errors.push(`Database error: ${error instanceof Error ? error.message : 'Unknown'}`);
      return {
        valid: false,
        strategyName,
        tradingEnabled: false,
        validationErrors: errors,
        warnings,
      };
    }
  }

  /**
   * Validate backtest results against criteria and update permissions
   */
  async validateAndUpdatePermissions(
    strategyName: StrategyName,
    backtestResult: BacktestResult,
    dataStartDate: Date,
    dataEndDate: Date
  ): Promise<{ passed: boolean; errors: string[] }> {
    const errors: string[] = [];
    const criteria = await this.getCriteria(strategyName);

    // Calculate data days
    const dataDays = (dataEndDate.getTime() - dataStartDate.getTime()) / (1000 * 60 * 60 * 24);

    // Validate against criteria
    if (dataDays < criteria.minDataDays) {
      errors.push(`Insufficient data: ${dataDays.toFixed(0)} days (min ${criteria.minDataDays})`);
    }

    if (backtestResult.totalTrades < criteria.minTrades) {
      errors.push(`Insufficient trades: ${backtestResult.totalTrades} (min ${criteria.minTrades})`);
    }

    if (backtestResult.sharpeRatio < criteria.minSharpeRatio) {
      errors.push(`Sharpe ratio too low: ${backtestResult.sharpeRatio.toFixed(2)} (min ${criteria.minSharpeRatio})`);
    }

    if (backtestResult.maxDrawdownPct < criteria.maxDrawdownPct) {
      errors.push(`Drawdown too high: ${backtestResult.maxDrawdownPct.toFixed(2)}% (max ${criteria.maxDrawdownPct}%)`);
    }

    if (backtestResult.winRate < criteria.minWinRatePct) {
      errors.push(`Win rate too low: ${backtestResult.winRate.toFixed(1)}% (min ${criteria.minWinRatePct}%)`);
    }

    if (backtestResult.profitFactor < criteria.minProfitFactor) {
      errors.push(`Profit factor too low: ${backtestResult.profitFactor.toFixed(2)} (min ${criteria.minProfitFactor})`);
    }

    if (backtestResult.maxConsecutiveLosses > criteria.maxConsecutiveLosses) {
      errors.push(`Max consecutive losses too high: ${backtestResult.maxConsecutiveLosses} (max ${criteria.maxConsecutiveLosses})`);
    }

    if (backtestResult.totalReturnPct < criteria.minReturnPct) {
      errors.push(`Return too low: ${backtestResult.totalReturnPct.toFixed(2)}% (min ${criteria.minReturnPct}%)`);
    }

    const passed = errors.length === 0;

    // Save backtest result
    const winningTrades = Math.round((backtestResult.winRate / 100) * backtestResult.totalTrades);
    const losingTrades = backtestResult.totalTrades - winningTrades;

    const insertResult = await this.db.query<{ id: number }>(
      `INSERT INTO backtest_results
       (strategy_name, data_start_date, data_end_date, initial_capital, final_equity,
        total_return_pct, sharpe_ratio, max_drawdown_pct, win_rate_pct, profit_factor,
        total_trades, winning_trades, losing_trades, max_consecutive_losses,
        candles_used, validation_passed, validation_errors)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id`,
      [
        strategyName,
        dataStartDate,
        dataEndDate,
        100, // Assume initial capital of 100 for percentage calculations
        100 + backtestResult.totalReturnPct,
        backtestResult.totalReturnPct,
        backtestResult.sharpeRatio,
        backtestResult.maxDrawdownPct,
        backtestResult.winRate,
        backtestResult.profitFactor,
        backtestResult.totalTrades,
        winningTrades,
        losingTrades,
        backtestResult.maxConsecutiveLosses,
        backtestResult.equityCurve?.length || 0,
        passed,
        errors.length > 0 ? errors : null,
      ]
    );

    const backtestId = insertResult.rows[0].id;

    // Update trading permissions
    const validationExpiry = new Date(Date.now() + criteria.requireFreshBacktestDays * 24 * 60 * 60 * 1000);

    await this.db.query(
      `INSERT INTO strategy_trading_permissions
       (strategy_name, trading_enabled, last_validated_at, last_backtest_id, validation_expires_at, disabled_reason, updated_at)
       VALUES ($1, $2, NOW(), $3, $4, $5, NOW())
       ON CONFLICT (strategy_name) DO UPDATE SET
         trading_enabled = EXCLUDED.trading_enabled,
         last_validated_at = NOW(),
         last_backtest_id = EXCLUDED.last_backtest_id,
         validation_expires_at = EXCLUDED.validation_expires_at,
         disabled_reason = EXCLUDED.disabled_reason,
         updated_at = NOW()`,
      [
        strategyName,
        passed,
        backtestId,
        passed ? validationExpiry : null,
        passed ? null : `Failed validation: ${errors.join('; ')}`,
      ]
    );

    // Clear cache
    this.permissionsCache.delete(strategyName);

    console.log(`[StrategyValidator] ${strategyName}: ${passed ? 'PASSED' : 'FAILED'} validation`);
    if (!passed) {
      console.log(`[StrategyValidator] Errors: ${errors.join(', ')}`);
    }

    return { passed, errors };
  }

  /**
   * Get validation criteria for a strategy (or default if not set)
   */
  private async getCriteria(strategyName: StrategyName): Promise<ValidationCriteria> {
    const cacheKey = strategyName;
    if (this.criteriaCache.has(cacheKey)) {
      return this.criteriaCache.get(cacheKey)!;
    }

    try {
      // Try strategy-specific criteria first, then fall back to default
      const result = await this.db.query<{
        min_data_days: number;
        min_trades: number;
        min_sharpe_ratio: number;
        max_drawdown_pct: number;
        min_win_rate_pct: number;
        min_profit_factor: number;
        max_consecutive_losses: number;
        min_return_pct: number;
        require_fresh_backtest_days: number;
      }>(
        `SELECT * FROM backtest_validation_criteria
         WHERE strategy_name = $1 OR strategy_name IS NULL
         ORDER BY strategy_name NULLS LAST
         LIMIT 1`,
        [strategyName]
      );

      if (result.rows.length === 0) {
        this.criteriaCache.set(cacheKey, DEFAULT_CRITERIA);
        return DEFAULT_CRITERIA;
      }

      const row = result.rows[0];
      const criteria: ValidationCriteria = {
        minDataDays: row.min_data_days,
        minTrades: row.min_trades,
        minSharpeRatio: Number(row.min_sharpe_ratio),
        maxDrawdownPct: Number(row.max_drawdown_pct),
        minWinRatePct: Number(row.min_win_rate_pct),
        minProfitFactor: Number(row.min_profit_factor),
        maxConsecutiveLosses: row.max_consecutive_losses,
        minReturnPct: Number(row.min_return_pct),
        requireFreshBacktestDays: row.require_fresh_backtest_days,
      };

      this.criteriaCache.set(cacheKey, criteria);
      return criteria;
    } catch (error) {
      console.error(`[StrategyValidator] Error loading criteria:`, error);
      return DEFAULT_CRITERIA;
    }
  }

  /**
   * Get validation mode from system state
   */
  async getValidationMode(): Promise<'strict' | 'warn' | 'disabled'> {
    try {
      const result = await this.db.query<{ value: string }>(
        `SELECT value FROM system_state WHERE key = 'backtest_validation_mode'`
      );

      if (result.rows.length === 0) {
        return 'strict';
      }

      const mode = JSON.parse(result.rows[0].value);
      if (['strict', 'warn', 'disabled'].includes(mode)) {
        return mode;
      }
      return 'strict';
    } catch {
      return 'strict';
    }
  }

  /**
   * Disable trading for a strategy
   */
  async disableStrategy(strategyName: StrategyName, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE strategy_trading_permissions
       SET trading_enabled = FALSE, disabled_reason = $2, updated_at = NOW()
       WHERE strategy_name = $1`,
      [strategyName, reason]
    );
    this.permissionsCache.delete(strategyName);
    console.log(`[StrategyValidator] Disabled ${strategyName}: ${reason}`);
  }

  /**
   * Get all strategies that need revalidation
   */
  async getStrategiesNeedingRevalidation(): Promise<StrategyName[]> {
    try {
      const result = await this.db.query<{ strategy_name: StrategyName }>(
        `SELECT strategy_name FROM strategy_trading_permissions
         WHERE auto_revalidate = TRUE
         AND (validation_expires_at IS NULL OR validation_expires_at < NOW())`
      );
      return result.rows.map(r => r.strategy_name);
    } catch {
      return [];
    }
  }
}
