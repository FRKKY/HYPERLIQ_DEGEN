import { Database } from '../data/database';
import { StrategyVersionManager } from './strategy-version-manager';
import {
  StrategyName,
  StrategyVersion,
  StrategyDeploymentState,
  PromotionCriteria,
  PromotionEvaluation,
  StrategyPerformanceMetrics,
  RollbackEvent,
  Environment,
} from '../types';

interface PromotionCriteriaRow {
  strategy_name: string | null;
  min_testnet_runtime_hours: number;
  min_trades: number;
  min_sharpe_ratio: number;
  max_drawdown_pct: number;
  min_win_rate_pct: number;
  min_profit_factor: number;
  max_consecutive_losses: number;
  min_shadow_mode_hours: number;
}

export class StrategyPromoter {
  private versionManager: StrategyVersionManager;

  constructor(private db: Database) {
    this.versionManager = new StrategyVersionManager(db);
  }

  async getPromotionCriteria(strategyName?: StrategyName): Promise<PromotionCriteria> {
    // First try strategy-specific criteria, then fall back to default
    const result = await this.db.query<PromotionCriteriaRow>(
      `SELECT * FROM promotion_criteria
       WHERE strategy_name = $1 OR strategy_name IS NULL
       ORDER BY strategy_name NULLS LAST
       LIMIT 1`,
      [strategyName || null]
    );

    if (result.rows.length === 0) {
      // Return hardcoded defaults if no DB criteria exists
      return {
        minTestnetRuntimeHours: 48,
        minTrades: 20,
        minSharpeRatio: 0.5,
        maxDrawdownPct: -20,
        minWinRatePct: 40,
        minProfitFactor: 1.2,
        maxConsecutiveLosses: 5,
        minShadowModeHours: 24,
      };
    }

    const row = result.rows[0];
    return {
      minTestnetRuntimeHours: row.min_testnet_runtime_hours,
      minTrades: row.min_trades,
      minSharpeRatio: Number(row.min_sharpe_ratio),
      maxDrawdownPct: Number(row.max_drawdown_pct),
      minWinRatePct: Number(row.min_win_rate_pct),
      minProfitFactor: Number(row.min_profit_factor),
      maxConsecutiveLosses: row.max_consecutive_losses,
      minShadowModeHours: row.min_shadow_mode_hours,
    };
  }

  async updatePromotionCriteria(
    criteria: Partial<PromotionCriteria>,
    strategyName?: StrategyName
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO promotion_criteria (strategy_name, min_testnet_runtime_hours, min_trades,
         min_sharpe_ratio, max_drawdown_pct, min_win_rate_pct, min_profit_factor,
         max_consecutive_losses, min_shadow_mode_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (strategy_name)
       DO UPDATE SET
         min_testnet_runtime_hours = COALESCE(EXCLUDED.min_testnet_runtime_hours, promotion_criteria.min_testnet_runtime_hours),
         min_trades = COALESCE(EXCLUDED.min_trades, promotion_criteria.min_trades),
         min_sharpe_ratio = COALESCE(EXCLUDED.min_sharpe_ratio, promotion_criteria.min_sharpe_ratio),
         max_drawdown_pct = COALESCE(EXCLUDED.max_drawdown_pct, promotion_criteria.max_drawdown_pct),
         min_win_rate_pct = COALESCE(EXCLUDED.min_win_rate_pct, promotion_criteria.min_win_rate_pct),
         min_profit_factor = COALESCE(EXCLUDED.min_profit_factor, promotion_criteria.min_profit_factor),
         max_consecutive_losses = COALESCE(EXCLUDED.max_consecutive_losses, promotion_criteria.max_consecutive_losses),
         min_shadow_mode_hours = COALESCE(EXCLUDED.min_shadow_mode_hours, promotion_criteria.min_shadow_mode_hours),
         updated_at = NOW()`,
      [
        strategyName || null,
        criteria.minTestnetRuntimeHours,
        criteria.minTrades,
        criteria.minSharpeRatio,
        criteria.maxDrawdownPct,
        criteria.minWinRatePct,
        criteria.minProfitFactor,
        criteria.maxConsecutiveLosses,
        criteria.minShadowModeHours,
      ]
    );
  }

  async evaluateForPromotion(version: StrategyVersion): Promise<PromotionEvaluation> {
    const criteria = await this.getPromotionCriteria(version.strategyName);
    const targetState = this.getNextState(version.deploymentState);

    if (!targetState) {
      return {
        strategyName: version.strategyName,
        version: version.version,
        currentState: version.deploymentState,
        targetState: version.deploymentState,
        criteria,
        metrics: this.getEmptyMetrics(),
        passed: false,
        failedCriteria: ['No valid promotion target from current state'],
        evaluatedAt: new Date(),
      };
    }

    const environment = this.getEnvironmentForState(version.deploymentState);
    const metrics = await this.getVersionMetrics(version.id, environment);
    const runtimeHours = await this.versionManager.getRuntimeHours(version.id, environment);

    const failedCriteria: string[] = [];

    // Check runtime requirements
    if (version.deploymentState === 'testnet_active') {
      if (runtimeHours < criteria.minTestnetRuntimeHours) {
        failedCriteria.push(`Runtime ${runtimeHours.toFixed(1)}h < required ${criteria.minTestnetRuntimeHours}h`);
      }
    } else if (version.deploymentState === 'mainnet_shadow') {
      if (runtimeHours < criteria.minShadowModeHours) {
        failedCriteria.push(`Shadow mode ${runtimeHours.toFixed(1)}h < required ${criteria.minShadowModeHours}h`);
      }
    }

    // Check trade count
    if (metrics.totalTrades < criteria.minTrades) {
      failedCriteria.push(`Trades ${metrics.totalTrades} < required ${criteria.minTrades}`);
    }

    // Check performance metrics (only if sufficient trades)
    if (metrics.totalTrades >= criteria.minTrades) {
      if (metrics.sharpeRatio < criteria.minSharpeRatio) {
        failedCriteria.push(`Sharpe ${metrics.sharpeRatio.toFixed(2)} < required ${criteria.minSharpeRatio}`);
      }

      if (metrics.maxDrawdown < criteria.maxDrawdownPct) {
        failedCriteria.push(`Drawdown ${metrics.maxDrawdown.toFixed(1)}% < allowed ${criteria.maxDrawdownPct}%`);
      }

      if (metrics.winRate < criteria.minWinRatePct) {
        failedCriteria.push(`Win rate ${metrics.winRate.toFixed(1)}% < required ${criteria.minWinRatePct}%`);
      }

      if (metrics.profitFactor < criteria.minProfitFactor) {
        failedCriteria.push(`Profit factor ${metrics.profitFactor.toFixed(2)} < required ${criteria.minProfitFactor}`);
      }

      if (metrics.consecutiveLosses > criteria.maxConsecutiveLosses) {
        failedCriteria.push(`Consecutive losses ${metrics.consecutiveLosses} > allowed ${criteria.maxConsecutiveLosses}`);
      }
    }

    const passed = failedCriteria.length === 0;

    const evaluation: PromotionEvaluation = {
      strategyName: version.strategyName,
      version: version.version,
      currentState: version.deploymentState,
      targetState,
      criteria,
      metrics,
      passed,
      failedCriteria,
      evaluatedAt: new Date(),
    };

    // Log evaluation to database
    await this.logEvaluation(version.id, evaluation);

    return evaluation;
  }

  async runPromotionCycle(): Promise<PromotionEvaluation[]> {
    console.log('[StrategyPromoter] Running promotion evaluation cycle...');

    const versionsToCheck = await this.versionManager.getVersionsAwaitingPromotion();
    const evaluations: PromotionEvaluation[] = [];

    for (const version of versionsToCheck) {
      const evaluation = await this.evaluateForPromotion(version);
      evaluations.push(evaluation);

      if (evaluation.passed) {
        await this.promote(version, evaluation.targetState);
        console.log(`[StrategyPromoter] Promoted ${version.strategyName} v${version.version} to ${evaluation.targetState}`);
      } else {
        console.log(
          `[StrategyPromoter] ${version.strategyName} v${version.version} not ready for promotion: ${evaluation.failedCriteria.join(', ')}`
        );
      }
    }

    return evaluations;
  }

  async promote(version: StrategyVersion, targetState: StrategyDeploymentState): Promise<void> {
    switch (targetState) {
      case 'testnet_validated':
        await this.versionManager.validateTestnet(version.id);
        break;
      case 'mainnet_shadow':
        await this.versionManager.promoteToMainnetShadow(version.id);
        break;
      case 'mainnet_active':
        await this.versionManager.activateOnMainnet(version.id);
        break;
      default:
        throw new Error(`Cannot promote to state: ${targetState}`);
    }
  }

  async checkForRollback(version: StrategyVersion): Promise<boolean> {
    // Only check mainnet_active versions
    if (version.deploymentState !== 'mainnet_active') {
      return false;
    }

    const criteria = await this.getPromotionCriteria(version.strategyName);
    const metrics = await this.getVersionMetrics(version.id, 'mainnet');

    // Use stricter criteria for rollback (half the normal thresholds)
    const shouldRollback =
      metrics.totalTrades >= 10 && (
        metrics.maxDrawdown < criteria.maxDrawdownPct * 1.5 || // 1.5x worse drawdown
        metrics.consecutiveLosses > criteria.maxConsecutiveLosses * 1.5 ||
        (metrics.winRate < criteria.minWinRatePct * 0.7 && metrics.totalTrades >= 20) // 70% of min win rate
      );

    if (shouldRollback) {
      await this.rollback(version, 'Performance degradation detected');
      return true;
    }

    return false;
  }

  async rollback(
    version: StrategyVersion,
    reason: string,
    automatic: boolean = true
  ): Promise<void> {
    // Find previous stable version
    const previousVersion = await this.findPreviousStableVersion(version.strategyName, version.version);

    if (previousVersion) {
      // Pause current version
      await this.versionManager.pauseOnMainnet(version.id);

      // Reactivate previous version
      await this.versionManager.activateOnMainnet(previousVersion.id);

      console.log(
        `[StrategyPromoter] Rolled back ${version.strategyName} from v${version.version} to v${previousVersion.version}: ${reason}`
      );
    } else {
      // No previous version, just pause
      await this.versionManager.pauseOnMainnet(version.id);
      console.log(`[StrategyPromoter] Paused ${version.strategyName} v${version.version}: ${reason} (no previous version to rollback to)`);
    }

    // Log rollback event
    await this.logRollback(version.strategyName, version.version, previousVersion?.version || 'none', reason, automatic);
  }

  private async findPreviousStableVersion(
    strategyName: StrategyName,
    currentVersion: string
  ): Promise<StrategyVersion | null> {
    const result = await this.db.query<{
      id: number;
      strategy_name: string;
      version: string;
      deployment_state: string;
      code_hash: string;
      parameters: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
      promoted_at: Date | null;
    }>(
      `SELECT id, strategy_name, version, deployment_state, code_hash, parameters, created_at, updated_at, promoted_at
       FROM strategy_versions
       WHERE strategy_name = $1 AND version != $2
         AND deployment_state IN ('mainnet_paused', 'deprecated')
         AND promoted_at IS NOT NULL
       ORDER BY promoted_at DESC
       LIMIT 1`,
      [strategyName, currentVersion]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      strategyName: row.strategy_name as StrategyName,
      version: row.version,
      deploymentState: row.deployment_state as StrategyDeploymentState,
      codeHash: row.code_hash,
      parameters: row.parameters,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      promotedAt: row.promoted_at || undefined,
    };
  }

  private async getVersionMetrics(versionId: number, environment: Environment): Promise<StrategyPerformanceMetrics> {
    // Get metrics from deployment record
    const deployment = await this.versionManager.getDeployment(versionId, environment);
    if (deployment?.performanceMetrics) {
      return deployment.performanceMetrics;
    }

    // Calculate from trades if no cached metrics
    const result = await this.db.query<{
      total_trades: string;
      winning_trades: string;
      total_pnl: string;
    }>(
      `SELECT
         COUNT(*) as total_trades,
         SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
         SUM(COALESCE(pnl, 0)) as total_pnl
       FROM trades
       WHERE strategy_version_id = $1 AND environment = $2`,
      [versionId, environment]
    );

    if (result.rows.length === 0 || parseInt(result.rows[0].total_trades) === 0) {
      return this.getEmptyMetrics();
    }

    const row = result.rows[0];
    const totalTrades = parseInt(row.total_trades);
    const winningTrades = parseInt(row.winning_trades);
    const losingTrades = totalTrades - winningTrades;

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      totalPnl: parseFloat(row.total_pnl),
      sharpeRatio: 0, // Would need more data to calculate
      maxDrawdown: 0, // Would need equity curve to calculate
      profitFactor: losingTrades > 0 ? winningTrades / losingTrades : winningTrades,
      winRate: (winningTrades / totalTrades) * 100,
      consecutiveLosses: 0, // Would need to track this separately
      runtimeHours: 0, // Calculated separately
    };
  }

  private getEmptyMetrics(): StrategyPerformanceMetrics {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalPnl: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      profitFactor: 0,
      winRate: 0,
      consecutiveLosses: 0,
      runtimeHours: 0,
    };
  }

  private getNextState(currentState: StrategyDeploymentState): StrategyDeploymentState | null {
    const transitions: Partial<Record<StrategyDeploymentState, StrategyDeploymentState>> = {
      testnet_active: 'testnet_validated',
      testnet_validated: 'mainnet_shadow',
      mainnet_shadow: 'mainnet_active',
    };
    return transitions[currentState] || null;
  }

  private getEnvironmentForState(state: StrategyDeploymentState): Environment {
    const testnetStates: StrategyDeploymentState[] = ['development', 'testnet_pending', 'testnet_active', 'testnet_validated'];
    return testnetStates.includes(state) ? 'testnet' : 'mainnet';
  }

  private async logEvaluation(versionId: number, evaluation: PromotionEvaluation): Promise<void> {
    await this.db.query(
      `INSERT INTO promotion_evaluations
         (strategy_version_id, current_state, target_state, metrics, criteria_used, passed, failed_criteria, reasoning)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        versionId,
        evaluation.currentState,
        evaluation.targetState,
        evaluation.metrics,
        evaluation.criteria,
        evaluation.passed,
        evaluation.failedCriteria,
        evaluation.failedCriteria.length > 0 ? evaluation.failedCriteria.join('; ') : 'All criteria passed',
      ]
    );
  }

  private async logRollback(
    strategyName: StrategyName,
    fromVersion: string,
    toVersion: string,
    reason: string,
    automatic: boolean
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO rollback_events (strategy_name, from_version, to_version, reason, automatic)
       VALUES ($1, $2, $3, $4, $5)`,
      [strategyName, fromVersion, toVersion, reason, automatic]
    );
  }

  async getRecentRollbacks(limit: number = 10): Promise<RollbackEvent[]> {
    const result = await this.db.query<{
      id: number;
      strategy_name: string;
      from_version: string;
      to_version: string;
      reason: string;
      triggered_at: Date;
      automatic: boolean;
    }>(
      `SELECT id, strategy_name, from_version, to_version, reason, triggered_at, automatic
       FROM rollback_events ORDER BY triggered_at DESC LIMIT $1`,
      [limit]
    );

    return result.rows.map((row) => ({
      id: row.id,
      strategyName: row.strategy_name as StrategyName,
      fromVersion: row.from_version,
      toVersion: row.to_version,
      reason: row.reason,
      triggeredAt: row.triggered_at,
      automatic: row.automatic,
    }));
  }
}
