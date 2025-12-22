import { Database } from '../data/database';
import { HyperliquidRestClient } from '../hyperliquid';
import { PositionTracker } from '../execution/position-tracker';
import { SignalAggregator } from '../execution/signal-aggregator';
import { OrderManager } from '../execution/order-manager';
import { SystemEvaluator } from './system-evaluator';
import { AgentEvaluator } from './agent-evaluator';
import { ConflictArbitrator } from './conflict-arbitrator';
import { RiskControlAgent } from './risk-control-agent';
import { DecisionEngine, MCLDecisionEngineOutput } from './decision-engine';
import { StrategyVersionManager, StrategyPromoter } from '../lifecycle';
import { AccountState, MCLDecision, StrategyAllocation, StrategyName, StrategyVersion, RiskControlAgentOutput, RiskParameters } from '../types';

export class MCLOrchestrator {
  private systemEvaluator: SystemEvaluator;
  private agentEvaluator: AgentEvaluator;
  private conflictArbitrator: ConflictArbitrator;
  private riskControlAgent: RiskControlAgent;
  private decisionEngine: DecisionEngine;
  private versionManager: StrategyVersionManager;
  private strategyPromoter: StrategyPromoter;
  private db: Database;
  private client: HyperliquidRestClient;
  private positionTracker: PositionTracker;
  private signalAggregator: SignalAggregator;
  private orderManager: OrderManager;
  private lastRiskControlOutput: RiskControlAgentOutput | null = null;

  constructor(
    apiKey: string,
    db: Database,
    client: HyperliquidRestClient,
    positionTracker: PositionTracker,
    signalAggregator: SignalAggregator,
    orderManager: OrderManager
  ) {
    this.db = db;
    this.client = client;
    this.positionTracker = positionTracker;
    this.signalAggregator = signalAggregator;
    this.orderManager = orderManager;

    this.systemEvaluator = new SystemEvaluator(apiKey, db);
    this.agentEvaluator = new AgentEvaluator(apiKey, db, positionTracker);
    this.conflictArbitrator = new ConflictArbitrator(apiKey, db, positionTracker);
    this.riskControlAgent = new RiskControlAgent(apiKey, db, positionTracker);
    this.decisionEngine = new DecisionEngine();
    this.versionManager = new StrategyVersionManager(db);
    this.strategyPromoter = new StrategyPromoter(db);
  }

  async runCycle(): Promise<MCLDecisionEngineOutput | null> {
    console.log('[MCL] Starting evaluation cycle...');
    const startTime = Date.now();

    try {
      // 0. Check for strategy promotions/rollbacks
      await this.runLifecycleChecks();

      // 1. Get account state
      const accountState = await this.getAccountState();

      // 2. Get active strategy versions for mainnet
      const activeVersions = await this.versionManager.getAllActiveVersions('mainnet');
      const activeStrategies = new Set(activeVersions.map((v) => v.strategyName));

      // 3. Run System Evaluator
      console.log('[MCL] Running System Evaluator...');
      const systemEvaluation = await this.systemEvaluator.evaluate(accountState);

      // 4. Run Risk Control Agent (NEW - manages dynamic risk parameters)
      console.log('[MCL] Running Risk Control Agent...');
      const marketConditions = await this.agentEvaluator['getMarketConditions']();
      const riskControlOutput = await this.riskControlAgent.evaluate(
        accountState,
        marketConditions,
        systemEvaluation.risk_level
      );
      this.lastRiskControlOutput = riskControlOutput;

      // Apply risk parameters to system
      const updatedRiskParams = this.riskControlAgent.applyOutput(riskControlOutput);
      console.log(`[MCL] Risk Control: Score=${riskControlOutput.current_risk_score}, ` +
        `Stress=${riskControlOutput.market_stress_level}, ` +
        `Actions=${riskControlOutput.immediate_actions.length}`);

      // 5. Run Agent Evaluator
      console.log('[MCL] Running Agent Evaluator...');
      const agentEvaluation = await this.agentEvaluator.evaluate(
        accountState.equity,
        accountState.drawdownPct,
        systemEvaluation.risk_level
      );

      // 6. Extract proposed allocations from agent evaluation (only for active strategies)
      const proposedAllocations: StrategyAllocation = {
        funding_signal: activeStrategies.has('funding_signal')
          ? agentEvaluation.strategy_assessments.funding_signal.recommended_allocation
          : 0,
        momentum_breakout: activeStrategies.has('momentum_breakout')
          ? agentEvaluation.strategy_assessments.momentum_breakout.recommended_allocation
          : 0,
        mean_reversion: activeStrategies.has('mean_reversion')
          ? agentEvaluation.strategy_assessments.mean_reversion.recommended_allocation
          : 0,
        trend_follow: activeStrategies.has('trend_follow')
          ? agentEvaluation.strategy_assessments.trend_follow.recommended_allocation
          : 0,
      };

      // 7. Run Conflict Arbitrator (use dynamic leverage from Risk Control Agent)
      console.log('[MCL] Running Conflict Arbitrator...');
      const maxLeverage = this.getMaxLeverageFromRiskControl(systemEvaluation.risk_level, riskControlOutput);
      const conflictResolution = await this.conflictArbitrator.arbitrate(
        proposedAllocations,
        agentEvaluation.disable_strategies,
        systemEvaluation.risk_level,
        maxLeverage
      );

      // 8. Run Decision Engine (now includes risk control output)
      console.log('[MCL] Running Decision Engine...');
      const decision = this.decisionEngine.run({
        systemEvaluation,
        agentEvaluation,
        conflictResolution,
        currentState: accountState,
        riskControlOutput, // Pass risk control output to decision engine
      });

      // 9. Apply decision
      await this.applyDecision(decision);

      // 10. Execute immediate risk actions if any
      await this.executeImmediateRiskActions(riskControlOutput.immediate_actions);

      // 11. Log decision
      const latencyMs = Date.now() - startTime;
      await this.logDecision(decision, systemEvaluation, agentEvaluation, conflictResolution, latencyMs, riskControlOutput);

      console.log(`[MCL] Cycle complete in ${latencyMs}ms`);
      console.log(`[MCL] Final allocations: ${JSON.stringify(decision.finalAllocations)}`);

      return decision;
    } catch (error) {
      console.error('[MCL] Error in evaluation cycle:', error);
      return null;
    }
  }

  private getMaxLeverageFromRiskControl(
    riskLevel: 'NORMAL' | 'REDUCED' | 'MINIMUM',
    riskControlOutput: RiskControlAgentOutput
  ): number {
    switch (riskLevel) {
      case 'MINIMUM':
        return riskControlOutput.leverage_caps.minimum;
      case 'REDUCED':
        return riskControlOutput.leverage_caps.reduced;
      default:
        return riskControlOutput.leverage_caps.normal;
    }
  }

  private async executeImmediateRiskActions(
    actions: RiskControlAgentOutput['immediate_actions']
  ): Promise<void> {
    for (const action of actions) {
      console.log(`[MCL] Executing risk action: ${action.action_type} - ${action.reason}`);

      switch (action.action_type) {
        case 'CLOSE_POSITION':
          if (action.target) {
            await this.orderManager.closePosition(action.target, `Risk Control: ${action.reason}`);
          }
          break;
        case 'PAUSE_STRATEGY':
          if (action.target) {
            this.signalAggregator.disableStrategy(action.target as StrategyName);
          }
          break;
        case 'REDUCE_LEVERAGE':
        case 'TIGHTEN_STOPS':
        case 'REDUCE_POSITION_SIZE':
          // These are handled by the updated risk parameters
          // Log for tracking purposes
          console.log(`[MCL] Risk action applied via parameters: ${action.action_type}`);
          break;
      }
    }
  }

  private async getAccountState(): Promise<AccountState> {
    const hlAccountState = await this.client.getAccountState();
    const systemState = await this.db.getSystemState();
    const positions = this.positionTracker.getAllPositions();

    const equity = parseFloat(hlAccountState.marginSummary.accountValue);
    const totalMarginUsed = parseFloat(hlAccountState.marginSummary.totalMarginUsed);
    const unrealizedPnl = this.positionTracker.getTotalUnrealizedPnl();
    const drawdownPct = ((equity - systemState.peakEquity) / systemState.peakEquity) * 100;

    // Calculate realized P&L from recent trades
    const recentTrades = await this.db.getRecentTrades(50);
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const realizedPnl24h = recentTrades
      .filter((t) => t.executedAt.getTime() > oneDayAgo && t.pnl !== undefined)
      .reduce((sum, t) => sum + (t.pnl || 0), 0);

    return {
      equity,
      availableBalance: equity - totalMarginUsed,
      totalMarginUsed,
      unrealizedPnl,
      realizedPnl24h,
      peakEquity: systemState.peakEquity,
      drawdownPct,
      positions,
    };
  }

  private async applyDecision(decision: MCLDecisionEngineOutput): Promise<void> {
    // 1. Handle pause
    if (decision.shouldPause) {
      await this.db.updateSystemState('trading_enabled', false);
      await this.db.updateSystemState('system_status', 'PAUSED');
      await this.db.updateSystemState('pause_reason', decision.pauseReason || 'MCL triggered pause');

      // Close all positions
      await this.orderManager.closeAllPositions('MCL pause');
      return;
    }

    // 2. Close positions that need to be closed
    for (const symbol of decision.positionsToClose) {
      await this.orderManager.closePosition(symbol, 'MCL decision');
    }

    // 3. Update allocations
    await this.db.updateAllocations(decision.finalAllocations, decision.reasoning);

    // 4. Enable/disable strategies
    for (const strategy of decision.strategiesToDisable) {
      this.signalAggregator.disableStrategy(strategy);
    }
    for (const strategy of decision.strategiesToEnable) {
      this.signalAggregator.enableStrategy(strategy);
    }

    // 5. Update last MCL run time
    await this.db.updateSystemState('last_mcl_run', new Date().toISOString());
  }

  private async logDecision(
    decision: MCLDecisionEngineOutput,
    systemEval: { overall_health: string; risk_level: string; confidence: number },
    agentEval: { confidence: number; allocation_rationale: string },
    conflictRes: { confidence: number },
    latencyMs: number,
    riskControlOutput?: RiskControlAgentOutput
  ): Promise<void> {
    const mclDecision: MCLDecision & { llmModel?: string; tokensUsed?: number; latencyMs?: number } = {
      decisionTime: new Date(),
      decisionType: decision.shouldPause ? 'STRATEGY_DISABLE' : 'ALLOCATION',
      inputs: {
        accountState: await this.getAccountState(),
        strategyPerformances: [],
        recentSignals: [],
        marketConditions: {
          btcTrend: 'NEUTRAL',
          volatility: 'MEDIUM',
          dominantRegime: 'UNCLEAR',
          avgFundingRate: 0,
        },
        systemHealth: [],
      },
      outputs: {
        allocations: decision.finalAllocations,
        disabledStrategies: decision.strategiesToDisable,
        enabledStrategies: decision.strategiesToEnable,
        leverageCap: decision.leverageCap,
        riskLevel: decision.riskLevel,
      },
      reasoning: decision.reasoning,
      confidence: (systemEval.confidence + agentEval.confidence + conflictRes.confidence) / 3,
      llmModel: 'claude-sonnet-4-20250514',
      latencyMs,
    };

    await this.db.insertMCLDecision(mclDecision);
  }

  private async runLifecycleChecks(): Promise<void> {
    console.log('[MCL] Running strategy lifecycle checks...');

    try {
      // 1. Check for promotions (testnet -> mainnet)
      const autoPromotionEnabled = await this.db.query<{ value: boolean }>(
        `SELECT value FROM system_state WHERE key = 'auto_promotion_enabled'`
      );

      if (autoPromotionEnabled.rows.length > 0 && autoPromotionEnabled.rows[0].value) {
        const evaluations = await this.strategyPromoter.runPromotionCycle();
        for (const evaluation of evaluations) {
          if (evaluation.passed) {
            console.log(
              `[MCL] Strategy promoted: ${evaluation.strategyName} v${evaluation.version} -> ${evaluation.targetState}`
            );
          }
        }
      }

      // 2. Check for rollbacks (underperforming mainnet strategies)
      const activeVersions = await this.versionManager.getAllActiveVersions('mainnet');
      for (const version of activeVersions) {
        if (version.deploymentState === 'mainnet_active') {
          const rolledBack = await this.strategyPromoter.checkForRollback(version);
          if (rolledBack) {
            console.log(`[MCL] Strategy rolled back: ${version.strategyName} v${version.version}`);
          }
        }
      }

      // 3. Reload strategy versions in signal aggregator
      await this.signalAggregator.loadStrategyVersions();
    } catch (error) {
      console.error('[MCL] Error in lifecycle checks:', error);
    }
  }

  async getActiveStrategyVersions(): Promise<StrategyVersion[]> {
    return this.versionManager.getAllActiveVersions(this.signalAggregator.getEnvironment());
  }

  async manuallyPromoteStrategy(strategyName: StrategyName, version: string): Promise<boolean> {
    const strategyVersion = await this.versionManager.getVersion(strategyName, version);
    if (!strategyVersion) {
      console.error(`[MCL] Version not found: ${strategyName} v${version}`);
      return false;
    }

    const evaluation = await this.strategyPromoter.evaluateForPromotion(strategyVersion);
    if (evaluation.passed) {
      await this.strategyPromoter.promote(strategyVersion, evaluation.targetState);
      console.log(`[MCL] Manually promoted ${strategyName} v${version} to ${evaluation.targetState}`);
      return true;
    }

    console.log(`[MCL] Cannot promote ${strategyName} v${version}: ${evaluation.failedCriteria.join(', ')}`);
    return false;
  }

  async manuallyRollbackStrategy(strategyName: StrategyName, reason: string): Promise<boolean> {
    const version = await this.versionManager.getActiveVersion(strategyName, 'mainnet');
    if (!version) {
      console.error(`[MCL] No active mainnet version for: ${strategyName}`);
      return false;
    }

    await this.strategyPromoter.rollback(version, reason, false);
    console.log(`[MCL] Manually rolled back ${strategyName} v${version.version}: ${reason}`);
    return true;
  }

  // Risk Control Agent accessors
  getCurrentRiskParameters(): RiskParameters {
    return this.riskControlAgent.getCurrentParameters();
  }

  getLastRiskControlOutput(): RiskControlAgentOutput | null {
    return this.lastRiskControlOutput;
  }

  getRiskControlAgent(): RiskControlAgent {
    return this.riskControlAgent;
  }

  resetRiskParametersToDefaults(): RiskParameters {
    return this.riskControlAgent.resetToDefaults();
  }
}

export { SystemEvaluator } from './system-evaluator';
export { AgentEvaluator } from './agent-evaluator';
export { ConflictArbitrator } from './conflict-arbitrator';
export { RiskControlAgent, DEFAULT_RISK_PARAMETERS } from './risk-control-agent';
export { DecisionEngine } from './decision-engine';
export { AnomalyDetector, checkForAnomalies } from './anomaly-detector';
