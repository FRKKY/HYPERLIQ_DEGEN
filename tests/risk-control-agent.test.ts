import { describe, it, expect, beforeEach } from 'vitest';
import { RiskControlAgentOutput, RiskParameters } from '../src/types';
import { DEFAULT_RISK_PARAMETERS } from '../src/mcl/risk-control-agent';

// ============================================================================
// Test Helpers - Mock validation and constraint functions extracted from agent
// ============================================================================

function validateOutput(output: RiskControlAgentOutput): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate risk thresholds
  if (!output.risk_thresholds) {
    errors.push('Missing risk_thresholds');
    return { valid: false, errors };
  }

  const { risk_thresholds } = output;
  if (risk_thresholds.drawdown_warning >= 0 || risk_thresholds.drawdown_warning < -50) {
    errors.push(`Invalid drawdown_warning: ${risk_thresholds.drawdown_warning}`);
  }
  if (risk_thresholds.drawdown_critical >= risk_thresholds.drawdown_warning) {
    errors.push('drawdown_critical must be lower than drawdown_warning');
  }
  if (risk_thresholds.drawdown_pause >= risk_thresholds.drawdown_critical) {
    errors.push('drawdown_pause must be lower than drawdown_critical');
  }

  // Validate leverage caps
  if (!output.leverage_caps) {
    errors.push('Missing leverage_caps');
    return { valid: false, errors };
  }
  if (output.leverage_caps.normal < 1 || output.leverage_caps.normal > 20) {
    errors.push(`Invalid leverage_caps.normal: ${output.leverage_caps.normal}`);
  }
  if (output.leverage_caps.reduced >= output.leverage_caps.normal) {
    errors.push('leverage_caps.reduced must be less than normal');
  }
  if (output.leverage_caps.minimum >= output.leverage_caps.reduced) {
    errors.push('leverage_caps.minimum must be less than reduced');
  }

  // Validate exposure limits
  if (!output.exposure_limits) {
    errors.push('Missing exposure_limits');
    return { valid: false, errors };
  }
  if (output.exposure_limits.max_total_exposure < 0.1 || output.exposure_limits.max_total_exposure > 1.0) {
    errors.push(`Invalid max_total_exposure: ${output.exposure_limits.max_total_exposure}`);
  }

  // Validate confidence
  if (output.confidence < 0 || output.confidence > 1) {
    errors.push(`Invalid confidence: ${output.confidence}`);
  }

  // Validate risk score
  if (output.current_risk_score < 0 || output.current_risk_score > 100) {
    errors.push(`Invalid current_risk_score: ${output.current_risk_score}`);
  }

  return { valid: errors.length === 0, errors };
}

function applySafetyConstraints(output: RiskControlAgentOutput): RiskControlAgentOutput {
  const constrained = { ...output };

  // Hard limits that MCL cannot override
  constrained.risk_thresholds = {
    ...output.risk_thresholds,
    drawdown_pause: Math.min(output.risk_thresholds.drawdown_pause, -15),
    drawdown_critical: Math.min(output.risk_thresholds.drawdown_critical, -10),
    drawdown_warning: Math.min(output.risk_thresholds.drawdown_warning, -5),
  };

  // Ensure ordering is maintained
  if (constrained.risk_thresholds.drawdown_critical >= constrained.risk_thresholds.drawdown_warning) {
    constrained.risk_thresholds.drawdown_critical = constrained.risk_thresholds.drawdown_warning - 5;
  }
  if (constrained.risk_thresholds.drawdown_pause >= constrained.risk_thresholds.drawdown_critical) {
    constrained.risk_thresholds.drawdown_pause = constrained.risk_thresholds.drawdown_critical - 5;
  }

  // Max leverage cannot exceed 15x
  constrained.leverage_caps = {
    normal: Math.min(output.leverage_caps.normal, 15),
    reduced: Math.min(output.leverage_caps.reduced, 8),
    minimum: Math.min(output.leverage_caps.minimum, 4),
  };

  // Max exposure cannot exceed 90%
  constrained.exposure_limits = {
    ...output.exposure_limits,
    max_total_exposure: Math.min(output.exposure_limits.max_total_exposure, 0.9),
  };

  // Position size scalar must be reasonable
  constrained.volatility_adjustments = {
    ...output.volatility_adjustments,
    position_size_scalar: Math.max(0.3, Math.min(1.5, output.volatility_adjustments.position_size_scalar)),
  };

  return constrained;
}

function getSafeDefaults(riskLevel: 'NORMAL' | 'REDUCED' | 'MINIMUM'): RiskControlAgentOutput {
  const baseThresholds = {
    drawdown_warning: -8,
    drawdown_critical: -12,
    drawdown_pause: -18,
    daily_loss_pause: -12,
    single_trade_loss_alert: -6,
  };

  const baseLeverageCaps = riskLevel === 'MINIMUM'
    ? { normal: 3, reduced: 2, minimum: 1 }
    : riskLevel === 'REDUCED'
      ? { normal: 5, reduced: 3, minimum: 2 }
      : { normal: 8, reduced: 5, minimum: 3 };

  return {
    risk_thresholds: baseThresholds,
    leverage_caps: baseLeverageCaps,
    exposure_limits: {
      max_total_exposure: riskLevel === 'MINIMUM' ? 0.3 : riskLevel === 'REDUCED' ? 0.5 : 0.7,
      max_single_position: 0.2,
      max_correlated_exposure: 0.4,
    },
    volatility_adjustments: {
      position_size_scalar: riskLevel === 'MINIMUM' ? 0.5 : riskLevel === 'REDUCED' ? 0.7 : 1.0,
      hold_time_reduction: riskLevel !== 'NORMAL',
      tighten_stops: riskLevel !== 'NORMAL',
    },
    immediate_actions: [],
    current_risk_score: riskLevel === 'MINIMUM' ? 80 : riskLevel === 'REDUCED' ? 60 : 40,
    risk_trend: 'STABLE',
    market_stress_level: riskLevel === 'MINIMUM' ? 'HIGH' : riskLevel === 'REDUCED' ? 'MODERATE' : 'LOW',
    reasoning: `Using safe defaults due to evaluation error. Risk level: ${riskLevel}`,
    confidence: 0.3,
  };
}

function applyOutput(output: RiskControlAgentOutput): RiskParameters {
  return {
    drawdownWarning: output.risk_thresholds.drawdown_warning,
    drawdownCritical: output.risk_thresholds.drawdown_critical,
    drawdownPause: output.risk_thresholds.drawdown_pause,
    dailyLossPause: output.risk_thresholds.daily_loss_pause,
    singleTradeLossAlert: output.risk_thresholds.single_trade_loss_alert,
    maxLeverageNormal: output.leverage_caps.normal,
    maxLeverageReduced: output.leverage_caps.reduced,
    maxLeverageMinimum: output.leverage_caps.minimum,
    maxTotalExposure: output.exposure_limits.max_total_exposure,
    maxSinglePosition: output.exposure_limits.max_single_position,
    maxCorrelatedExposure: output.exposure_limits.max_correlated_exposure,
    positionSizeScalar: output.volatility_adjustments.position_size_scalar,
    updatedAt: new Date(),
    updatedBy: 'MCL',
  };
}

interface Trade {
  pnl?: number;
  executedAt: Date;
}

function calculateRecentLosses(trades: Trade[]): {
  consecutiveLosses: number;
  last24hLosses: number;
  last24hWins: number;
  largestLoss: number;
} {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = trades.filter(t => t.executedAt.getTime() > oneDayAgo);

  let consecutiveLosses = 0;
  for (const trade of trades) {
    if (trade.pnl !== undefined && trade.pnl < 0) {
      consecutiveLosses++;
    } else {
      break;
    }
  }

  const recentWithPnl = recent.filter(t => t.pnl !== undefined);
  const last24hLosses = recentWithPnl.filter(t => t.pnl! < 0).length;
  const last24hWins = recentWithPnl.filter(t => t.pnl! > 0).length;
  const largestLoss = Math.min(0, ...recentWithPnl.map(t => t.pnl!));

  return {
    consecutiveLosses,
    last24hLosses,
    last24hWins,
    largestLoss,
  };
}

// ============================================================================
// Test Suites
// ============================================================================

describe('Risk Control Agent', () => {
  // ==========================================================================
  // 1. Initialization Tests
  // ==========================================================================
  describe('Initialization', () => {
    it('should have correct default values from manifesto', () => {
      expect(DEFAULT_RISK_PARAMETERS.drawdownWarning).toBe(-10);
      expect(DEFAULT_RISK_PARAMETERS.drawdownCritical).toBe(-15);
      expect(DEFAULT_RISK_PARAMETERS.drawdownPause).toBe(-20);
      expect(DEFAULT_RISK_PARAMETERS.dailyLossPause).toBe(-15);
      expect(DEFAULT_RISK_PARAMETERS.singleTradeLossAlert).toBe(-8);
    });

    it('should have correct default leverage values', () => {
      expect(DEFAULT_RISK_PARAMETERS.maxLeverageNormal).toBe(10);
      expect(DEFAULT_RISK_PARAMETERS.maxLeverageReduced).toBe(5);
      expect(DEFAULT_RISK_PARAMETERS.maxLeverageMinimum).toBe(3);
    });

    it('should have correct default exposure values', () => {
      expect(DEFAULT_RISK_PARAMETERS.maxTotalExposure).toBe(0.8);
      expect(DEFAULT_RISK_PARAMETERS.maxSinglePosition).toBe(0.25);
      expect(DEFAULT_RISK_PARAMETERS.maxCorrelatedExposure).toBe(0.5);
    });

    it('should have position size scalar of 1.0 by default', () => {
      expect(DEFAULT_RISK_PARAMETERS.positionSizeScalar).toBe(1.0);
    });

    it('should have updatedBy set to DEFAULT', () => {
      expect(DEFAULT_RISK_PARAMETERS.updatedBy).toBe('DEFAULT');
    });
  });

  // ==========================================================================
  // 2. Output Validation Tests
  // ==========================================================================
  describe('Output Validation', () => {
    let validOutput: RiskControlAgentOutput;

    beforeEach(() => {
      validOutput = {
        risk_thresholds: {
          drawdown_warning: -10,
          drawdown_critical: -15,
          drawdown_pause: -20,
          daily_loss_pause: -15,
          single_trade_loss_alert: -8,
        },
        leverage_caps: {
          normal: 10,
          reduced: 5,
          minimum: 3,
        },
        exposure_limits: {
          max_total_exposure: 0.8,
          max_single_position: 0.25,
          max_correlated_exposure: 0.5,
        },
        volatility_adjustments: {
          position_size_scalar: 1.0,
          hold_time_reduction: false,
          tighten_stops: false,
        },
        immediate_actions: [],
        current_risk_score: 40,
        risk_trend: 'STABLE',
        market_stress_level: 'LOW',
        reasoning: 'Test output',
        confidence: 0.8,
      };
    });

    it('should accept valid output', () => {
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject drawdown_warning >= 0', () => {
      validOutput.risk_thresholds.drawdown_warning = 0;
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('drawdown_warning'))).toBe(true);
    });

    it('should reject drawdown_warning < -50', () => {
      validOutput.risk_thresholds.drawdown_warning = -51;
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('drawdown_warning'))).toBe(true);
    });

    it('should reject drawdown_critical >= drawdown_warning', () => {
      validOutput.risk_thresholds.drawdown_critical = -10; // Same as warning
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('drawdown_critical must be lower'))).toBe(true);
    });

    it('should reject drawdown_pause >= drawdown_critical', () => {
      validOutput.risk_thresholds.drawdown_pause = -15; // Same as critical
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('drawdown_pause must be lower'))).toBe(true);
    });

    it('should reject leverage_caps.normal < 1', () => {
      validOutput.leverage_caps.normal = 0;
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('leverage_caps.normal'))).toBe(true);
    });

    it('should reject leverage_caps.normal > 20', () => {
      validOutput.leverage_caps.normal = 25;
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('leverage_caps.normal'))).toBe(true);
    });

    it('should reject leverage_caps.reduced >= normal', () => {
      validOutput.leverage_caps.reduced = 10; // Same as normal
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('leverage_caps.reduced must be less'))).toBe(true);
    });

    it('should reject leverage_caps.minimum >= reduced', () => {
      validOutput.leverage_caps.minimum = 5; // Same as reduced
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('leverage_caps.minimum must be less'))).toBe(true);
    });

    it('should reject max_total_exposure < 0.1', () => {
      validOutput.exposure_limits.max_total_exposure = 0.05;
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('max_total_exposure'))).toBe(true);
    });

    it('should reject max_total_exposure > 1.0', () => {
      validOutput.exposure_limits.max_total_exposure = 1.5;
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('max_total_exposure'))).toBe(true);
    });

    it('should reject confidence < 0', () => {
      validOutput.confidence = -0.1;
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('confidence'))).toBe(true);
    });

    it('should reject confidence > 1', () => {
      validOutput.confidence = 1.5;
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('confidence'))).toBe(true);
    });

    it('should reject risk_score < 0', () => {
      validOutput.current_risk_score = -10;
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('current_risk_score'))).toBe(true);
    });

    it('should reject risk_score > 100', () => {
      validOutput.current_risk_score = 150;
      const result = validateOutput(validOutput);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('current_risk_score'))).toBe(true);
    });
  });

  // ==========================================================================
  // 3. Safety Constraint Tests
  // ==========================================================================
  describe('Safety Constraints', () => {
    let output: RiskControlAgentOutput;

    beforeEach(() => {
      output = {
        risk_thresholds: {
          drawdown_warning: -10,
          drawdown_critical: -15,
          drawdown_pause: -20,
          daily_loss_pause: -15,
          single_trade_loss_alert: -8,
        },
        leverage_caps: {
          normal: 10,
          reduced: 5,
          minimum: 3,
        },
        exposure_limits: {
          max_total_exposure: 0.8,
          max_single_position: 0.25,
          max_correlated_exposure: 0.5,
        },
        volatility_adjustments: {
          position_size_scalar: 1.0,
          hold_time_reduction: false,
          tighten_stops: false,
        },
        immediate_actions: [],
        current_risk_score: 40,
        risk_trend: 'STABLE',
        market_stress_level: 'LOW',
        reasoning: 'Test',
        confidence: 0.8,
      };
    });

    it('should cap drawdown_pause at minimum -15%', () => {
      output.risk_thresholds.drawdown_pause = -10; // Too lenient
      const constrained = applySafetyConstraints(output);
      expect(constrained.risk_thresholds.drawdown_pause).toBeLessThanOrEqual(-15);
    });

    it('should cap drawdown_critical at minimum -10%', () => {
      output.risk_thresholds.drawdown_critical = -5; // Too lenient
      const constrained = applySafetyConstraints(output);
      expect(constrained.risk_thresholds.drawdown_critical).toBeLessThanOrEqual(-10);
    });

    it('should cap drawdown_warning at minimum -5%', () => {
      output.risk_thresholds.drawdown_warning = -2; // Too lenient
      const constrained = applySafetyConstraints(output);
      expect(constrained.risk_thresholds.drawdown_warning).toBeLessThanOrEqual(-5);
    });

    it('should maintain threshold ordering after constraints', () => {
      output.risk_thresholds = {
        ...output.risk_thresholds,
        drawdown_warning: -3,  // Will be capped to -5
        drawdown_critical: -4, // Will be capped to -10
        drawdown_pause: -5,    // Will be capped to -15
      };
      const constrained = applySafetyConstraints(output);

      // Verify ordering: warning > critical > pause
      expect(constrained.risk_thresholds.drawdown_warning).toBeGreaterThan(constrained.risk_thresholds.drawdown_critical);
      expect(constrained.risk_thresholds.drawdown_critical).toBeGreaterThan(constrained.risk_thresholds.drawdown_pause);
    });

    it('should cap max leverage at 15x for normal', () => {
      output.leverage_caps.normal = 20;
      const constrained = applySafetyConstraints(output);
      expect(constrained.leverage_caps.normal).toBeLessThanOrEqual(15);
    });

    it('should cap max leverage at 8x for reduced', () => {
      output.leverage_caps.reduced = 12;
      const constrained = applySafetyConstraints(output);
      expect(constrained.leverage_caps.reduced).toBeLessThanOrEqual(8);
    });

    it('should cap max leverage at 4x for minimum', () => {
      output.leverage_caps.minimum = 6;
      const constrained = applySafetyConstraints(output);
      expect(constrained.leverage_caps.minimum).toBeLessThanOrEqual(4);
    });

    it('should cap max exposure at 90%', () => {
      output.exposure_limits.max_total_exposure = 0.95;
      const constrained = applySafetyConstraints(output);
      expect(constrained.exposure_limits.max_total_exposure).toBeLessThanOrEqual(0.9);
    });

    it('should bound position_size_scalar minimum at 0.3', () => {
      output.volatility_adjustments.position_size_scalar = 0.1;
      const constrained = applySafetyConstraints(output);
      expect(constrained.volatility_adjustments.position_size_scalar).toBeGreaterThanOrEqual(0.3);
    });

    it('should bound position_size_scalar maximum at 1.5', () => {
      output.volatility_adjustments.position_size_scalar = 2.0;
      const constrained = applySafetyConstraints(output);
      expect(constrained.volatility_adjustments.position_size_scalar).toBeLessThanOrEqual(1.5);
    });

    it('should not modify values already within constraints', () => {
      const constrained = applySafetyConstraints(output);
      expect(constrained.risk_thresholds.drawdown_warning).toBe(-10);
      expect(constrained.risk_thresholds.drawdown_critical).toBe(-15);
      expect(constrained.risk_thresholds.drawdown_pause).toBe(-20);
      expect(constrained.leverage_caps.normal).toBe(10);
      expect(constrained.exposure_limits.max_total_exposure).toBe(0.8);
    });
  });

  // ==========================================================================
  // 4. Safe Defaults Tests
  // ==========================================================================
  describe('Safe Defaults', () => {
    it('should return conservative defaults for NORMAL risk level', () => {
      const defaults = getSafeDefaults('NORMAL');

      expect(defaults.leverage_caps.normal).toBe(8);
      expect(defaults.leverage_caps.reduced).toBe(5);
      expect(defaults.leverage_caps.minimum).toBe(3);
      expect(defaults.exposure_limits.max_total_exposure).toBe(0.7);
      expect(defaults.volatility_adjustments.position_size_scalar).toBe(1.0);
      expect(defaults.volatility_adjustments.hold_time_reduction).toBe(false);
      expect(defaults.volatility_adjustments.tighten_stops).toBe(false);
      expect(defaults.current_risk_score).toBe(40);
      expect(defaults.market_stress_level).toBe('LOW');
    });

    it('should return more conservative defaults for REDUCED risk level', () => {
      const defaults = getSafeDefaults('REDUCED');

      expect(defaults.leverage_caps.normal).toBe(5);
      expect(defaults.leverage_caps.reduced).toBe(3);
      expect(defaults.leverage_caps.minimum).toBe(2);
      expect(defaults.exposure_limits.max_total_exposure).toBe(0.5);
      expect(defaults.volatility_adjustments.position_size_scalar).toBe(0.7);
      expect(defaults.volatility_adjustments.hold_time_reduction).toBe(true);
      expect(defaults.volatility_adjustments.tighten_stops).toBe(true);
      expect(defaults.current_risk_score).toBe(60);
      expect(defaults.market_stress_level).toBe('MODERATE');
    });

    it('should return most conservative defaults for MINIMUM risk level', () => {
      const defaults = getSafeDefaults('MINIMUM');

      expect(defaults.leverage_caps.normal).toBe(3);
      expect(defaults.leverage_caps.reduced).toBe(2);
      expect(defaults.leverage_caps.minimum).toBe(1);
      expect(defaults.exposure_limits.max_total_exposure).toBe(0.3);
      expect(defaults.volatility_adjustments.position_size_scalar).toBe(0.5);
      expect(defaults.volatility_adjustments.hold_time_reduction).toBe(true);
      expect(defaults.volatility_adjustments.tighten_stops).toBe(true);
      expect(defaults.current_risk_score).toBe(80);
      expect(defaults.market_stress_level).toBe('HIGH');
    });

    it('should always return low confidence (0.3) for safe defaults', () => {
      expect(getSafeDefaults('NORMAL').confidence).toBe(0.3);
      expect(getSafeDefaults('REDUCED').confidence).toBe(0.3);
      expect(getSafeDefaults('MINIMUM').confidence).toBe(0.3);
    });

    it('should always return STABLE risk trend for safe defaults', () => {
      expect(getSafeDefaults('NORMAL').risk_trend).toBe('STABLE');
      expect(getSafeDefaults('REDUCED').risk_trend).toBe('STABLE');
      expect(getSafeDefaults('MINIMUM').risk_trend).toBe('STABLE');
    });

    it('should return empty immediate_actions for safe defaults', () => {
      expect(getSafeDefaults('NORMAL').immediate_actions).toHaveLength(0);
      expect(getSafeDefaults('REDUCED').immediate_actions).toHaveLength(0);
      expect(getSafeDefaults('MINIMUM').immediate_actions).toHaveLength(0);
    });

    it('should include risk level in reasoning', () => {
      expect(getSafeDefaults('NORMAL').reasoning).toContain('NORMAL');
      expect(getSafeDefaults('REDUCED').reasoning).toContain('REDUCED');
      expect(getSafeDefaults('MINIMUM').reasoning).toContain('MINIMUM');
    });
  });

  // ==========================================================================
  // 5. Parameter Management Tests
  // ==========================================================================
  describe('Parameter Management', () => {
    it('applyOutput should convert MCL output to RiskParameters', () => {
      const output: RiskControlAgentOutput = {
        risk_thresholds: {
          drawdown_warning: -8,
          drawdown_critical: -12,
          drawdown_pause: -18,
          daily_loss_pause: -10,
          single_trade_loss_alert: -5,
        },
        leverage_caps: {
          normal: 8,
          reduced: 4,
          minimum: 2,
        },
        exposure_limits: {
          max_total_exposure: 0.7,
          max_single_position: 0.2,
          max_correlated_exposure: 0.4,
        },
        volatility_adjustments: {
          position_size_scalar: 0.8,
          hold_time_reduction: true,
          tighten_stops: true,
        },
        immediate_actions: [],
        current_risk_score: 50,
        risk_trend: 'INCREASING',
        market_stress_level: 'MODERATE',
        reasoning: 'Test',
        confidence: 0.7,
      };

      const params = applyOutput(output);

      expect(params.drawdownWarning).toBe(-8);
      expect(params.drawdownCritical).toBe(-12);
      expect(params.drawdownPause).toBe(-18);
      expect(params.dailyLossPause).toBe(-10);
      expect(params.singleTradeLossAlert).toBe(-5);
      expect(params.maxLeverageNormal).toBe(8);
      expect(params.maxLeverageReduced).toBe(4);
      expect(params.maxLeverageMinimum).toBe(2);
      expect(params.maxTotalExposure).toBe(0.7);
      expect(params.maxSinglePosition).toBe(0.2);
      expect(params.maxCorrelatedExposure).toBe(0.4);
      expect(params.positionSizeScalar).toBe(0.8);
      expect(params.updatedBy).toBe('MCL');
    });

    it('applyOutput should set updatedAt to current time', () => {
      const output = getSafeDefaults('NORMAL');
      const before = Date.now();
      const params = applyOutput(output);
      const after = Date.now();

      expect(params.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(params.updatedAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('should map all exposure limits correctly', () => {
      const output = getSafeDefaults('REDUCED');
      const params = applyOutput(output);

      expect(params.maxTotalExposure).toBe(output.exposure_limits.max_total_exposure);
      expect(params.maxSinglePosition).toBe(output.exposure_limits.max_single_position);
      expect(params.maxCorrelatedExposure).toBe(output.exposure_limits.max_correlated_exposure);
    });
  });

  // ==========================================================================
  // 6. Helper Method Tests
  // ==========================================================================
  describe('Helper Methods', () => {
    describe('calculateRecentLosses', () => {
      it('should count consecutive losses correctly', () => {
        const now = Date.now();
        const trades: Trade[] = [
          { pnl: -10, executedAt: new Date(now - 1000) },
          { pnl: -5, executedAt: new Date(now - 2000) },
          { pnl: -8, executedAt: new Date(now - 3000) },
          { pnl: 15, executedAt: new Date(now - 4000) }, // Breaks streak
          { pnl: -3, executedAt: new Date(now - 5000) },
        ];

        const result = calculateRecentLosses(trades);
        expect(result.consecutiveLosses).toBe(3);
      });

      it('should return 0 consecutive losses when first trade is a win', () => {
        const now = Date.now();
        const trades: Trade[] = [
          { pnl: 10, executedAt: new Date(now - 1000) },
          { pnl: -5, executedAt: new Date(now - 2000) },
        ];

        const result = calculateRecentLosses(trades);
        expect(result.consecutiveLosses).toBe(0);
      });

      it('should handle empty trade array', () => {
        const result = calculateRecentLosses([]);
        expect(result.consecutiveLosses).toBe(0);
        expect(result.last24hLosses).toBe(0);
        expect(result.last24hWins).toBe(0);
        expect(result.largestLoss).toBe(0);
      });

      it('should calculate 24h win/loss correctly', () => {
        const now = Date.now();
        const oneHourAgo = now - 60 * 60 * 1000;
        const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

        const trades: Trade[] = [
          { pnl: 10, executedAt: new Date(oneHourAgo) },     // Within 24h - win
          { pnl: -5, executedAt: new Date(oneHourAgo) },     // Within 24h - loss
          { pnl: -8, executedAt: new Date(oneHourAgo) },     // Within 24h - loss
          { pnl: 20, executedAt: new Date(twoDaysAgo) },     // Outside 24h
          { pnl: -15, executedAt: new Date(twoDaysAgo) },    // Outside 24h
        ];

        const result = calculateRecentLosses(trades);
        expect(result.last24hWins).toBe(1);
        expect(result.last24hLosses).toBe(2);
      });

      it('should find largest loss in 24h window', () => {
        const now = Date.now();
        const oneHourAgo = now - 60 * 60 * 1000;

        const trades: Trade[] = [
          { pnl: -10, executedAt: new Date(oneHourAgo) },
          { pnl: -25, executedAt: new Date(oneHourAgo) },  // Largest loss
          { pnl: -5, executedAt: new Date(oneHourAgo) },
          { pnl: 15, executedAt: new Date(oneHourAgo) },
        ];

        const result = calculateRecentLosses(trades);
        expect(result.largestLoss).toBe(-25);
      });

      it('should return 0 for largestLoss when no losses', () => {
        const now = Date.now();
        const trades: Trade[] = [
          { pnl: 10, executedAt: new Date(now - 1000) },
          { pnl: 20, executedAt: new Date(now - 2000) },
        ];

        const result = calculateRecentLosses(trades);
        expect(result.largestLoss).toBe(0);
      });

      it('should handle trades without pnl', () => {
        const now = Date.now();
        const trades: Trade[] = [
          { pnl: undefined, executedAt: new Date(now - 1000) },
          { pnl: -10, executedAt: new Date(now - 2000) },
          { pnl: undefined, executedAt: new Date(now - 3000) },
        ];

        const result = calculateRecentLosses(trades);
        // First trade has undefined pnl, so consecutive check stops
        expect(result.consecutiveLosses).toBe(0);
        expect(result.last24hLosses).toBe(1);
      });

      it('should count all consecutive losses when all trades are losses', () => {
        const now = Date.now();
        const trades: Trade[] = [
          { pnl: -5, executedAt: new Date(now - 1000) },
          { pnl: -10, executedAt: new Date(now - 2000) },
          { pnl: -15, executedAt: new Date(now - 3000) },
          { pnl: -20, executedAt: new Date(now - 4000) },
        ];

        const result = calculateRecentLosses(trades);
        expect(result.consecutiveLosses).toBe(4);
      });
    });
  });
});
