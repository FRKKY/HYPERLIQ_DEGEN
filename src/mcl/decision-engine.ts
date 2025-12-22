import {
  StrategyAllocation,
  StrategyName,
  SystemEvaluatorOutput,
  AgentEvaluatorOutput,
  ConflictArbitratorOutput,
  RiskControlAgentOutput,
  AccountState,
} from '../types';

export interface MCLDecisionEngineInput {
  systemEvaluation: SystemEvaluatorOutput;
  agentEvaluation: AgentEvaluatorOutput;
  conflictResolution: ConflictArbitratorOutput;
  currentState: AccountState;
  riskControlOutput?: RiskControlAgentOutput;
}

export interface MCLDecisionEngineOutput {
  finalAllocations: StrategyAllocation;
  strategiesToDisable: StrategyName[];
  strategiesToEnable: StrategyName[];
  positionsToClose: string[];
  leverageCap: number;
  riskLevel: 'NORMAL' | 'REDUCED' | 'MINIMUM';
  shouldPause: boolean;
  pauseReason?: string;
  reasoning: string;
  // Risk control outputs
  riskScore?: number;
  riskTrend?: 'INCREASING' | 'STABLE' | 'DECREASING';
  marketStressLevel?: 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';
  positionSizeScalar?: number;
  maxTotalExposure?: number;
}

export class DecisionEngine {
  run(input: MCLDecisionEngineInput): MCLDecisionEngineOutput {
    const { systemEvaluation, agentEvaluation, conflictResolution, currentState, riskControlOutput } = input;

    // HARD CONSTRAINTS (override MCL)

    // 1. Pause on critical conditions
    if (systemEvaluation.should_pause) {
      return {
        finalAllocations: { funding_signal: 0, momentum_breakout: 0, mean_reversion: 0, trend_follow: 0 },
        strategiesToDisable: ['funding_signal', 'momentum_breakout', 'mean_reversion', 'trend_follow'],
        strategiesToEnable: [],
        positionsToClose: currentState.positions.map((p) => p.symbol),
        leverageCap: 0,
        riskLevel: 'MINIMUM',
        shouldPause: true,
        pauseReason: systemEvaluation.pause_reason || 'System evaluation triggered pause',
        reasoning: `System pause triggered: ${systemEvaluation.pause_reason}`,
      };
    }

    // 2. Get allocations and validate sum to 100%
    let allocations = { ...conflictResolution.resolved_allocations };
    const sum = Object.values(allocations).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > 0.01) {
      // Normalize
      allocations = {
        funding_signal: (allocations.funding_signal / sum) * 100,
        momentum_breakout: (allocations.momentum_breakout / sum) * 100,
        mean_reversion: (allocations.mean_reversion / sum) * 100,
        trend_follow: (allocations.trend_follow / sum) * 100,
      };
    }

    // 3. Cap individual allocations at 50%
    const strategies: StrategyName[] = ['funding_signal', 'momentum_breakout', 'mean_reversion', 'trend_follow'];
    for (const strategy of strategies) {
      allocations[strategy] = Math.min(allocations[strategy], 50);
    }

    // Re-normalize after capping
    const cappedSum = Object.values(allocations).reduce((a, b) => a + b, 0);
    if (cappedSum < 100 && cappedSum > 0) {
      const factor = 100 / cappedSum;
      for (const strategy of strategies) {
        allocations[strategy] = allocations[strategy] * factor;
      }
    }

    // 4. Apply risk level constraints
    let leverageCap = conflictResolution.leverage_cap || 10;
    const riskLevel = systemEvaluation.risk_level;

    if (riskLevel === 'REDUCED') {
      leverageCap = Math.min(leverageCap, 5);
      // Reduce all allocations by 30%
      for (const strategy of strategies) {
        allocations[strategy] = allocations[strategy] * 0.7;
      }
    } else if (riskLevel === 'MINIMUM') {
      leverageCap = Math.min(leverageCap, 3);
      // Only keep top strategy at 30%
      const sortedStrategies = strategies.sort((a, b) => allocations[b] - allocations[a]);
      const topStrategy = sortedStrategies[0];
      allocations = {
        funding_signal: 0,
        momentum_breakout: 0,
        mean_reversion: 0,
        trend_follow: 0,
        [topStrategy]: 30,
      } as StrategyAllocation;
    }

    // 5. Handle strategy disabling
    const strategiesToDisable = agentEvaluation.disable_strategies || [];

    // 6. Positions to close (from disabled strategies)
    const positionsToClose =
      conflictResolution.position_actions?.filter((p) => p.action === 'CLOSE').map((p) => p.symbol) || [];

    // Build reasoning summary
    const reasoning = this.buildReasoningSummary(systemEvaluation, agentEvaluation, conflictResolution, riskControlOutput);

    return {
      finalAllocations: allocations,
      strategiesToDisable,
      strategiesToEnable: [], // requires human approval
      positionsToClose,
      leverageCap,
      riskLevel,
      shouldPause: false,
      reasoning,
      // Risk control outputs (from Risk Control Agent)
      riskScore: riskControlOutput?.current_risk_score,
      riskTrend: riskControlOutput?.risk_trend,
      marketStressLevel: riskControlOutput?.market_stress_level,
      positionSizeScalar: riskControlOutput?.volatility_adjustments.position_size_scalar,
      maxTotalExposure: riskControlOutput?.exposure_limits.max_total_exposure,
    };
  }

  private buildReasoningSummary(
    systemEval: SystemEvaluatorOutput,
    agentEval: AgentEvaluatorOutput,
    conflictRes: ConflictArbitratorOutput,
    riskControl?: RiskControlAgentOutput
  ): string {
    const parts: string[] = [];

    parts.push(`System Health: ${systemEval.overall_health} (Risk: ${systemEval.risk_level})`);

    if (systemEval.anomalies_detected.length > 0) {
      parts.push(`Anomalies: ${systemEval.anomalies_detected.join(', ')}`);
    }

    parts.push(`Market: ${agentEval.market_regime_assessment}`);
    parts.push(`Allocation Rationale: ${agentEval.allocation_rationale}`);

    if (conflictRes.adjustments_made.length > 0) {
      parts.push(`Adjustments: ${conflictRes.adjustments_made.join(', ')}`);
    }

    // Add risk control summary
    if (riskControl) {
      parts.push(`Risk Score: ${riskControl.current_risk_score}/100 (${riskControl.risk_trend})`);
      parts.push(`Market Stress: ${riskControl.market_stress_level}`);
      if (riskControl.immediate_actions.length > 0) {
        parts.push(`Risk Actions: ${riskControl.immediate_actions.length}`);
      }
    }

    const confidences = [systemEval.confidence, agentEval.confidence, conflictRes.confidence];
    if (riskControl) confidences.push(riskControl.confidence);
    const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    parts.push(`Avg Confidence: ${avgConfidence.toFixed(2)}`);

    return parts.join(' | ');
  }
}
