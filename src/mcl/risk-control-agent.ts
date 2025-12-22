import Anthropic from '@anthropic-ai/sdk';
import { Database } from '../data/database';
import { PositionTracker } from '../execution/position-tracker';
import {
  AccountState,
  MarketConditions,
  RiskControlAgentOutput,
  RiskParameters,
  Alert,
  Trade,
} from '../types';
import { buildRiskControlAgentPrompt } from './prompts';

// Default risk parameters (from manifesto spec)
export const DEFAULT_RISK_PARAMETERS: RiskParameters = {
  drawdownWarning: -10,
  drawdownCritical: -15,
  drawdownPause: -20,
  dailyLossPause: -15,
  singleTradeLossAlert: -8,
  maxLeverageNormal: 10,
  maxLeverageReduced: 5,
  maxLeverageMinimum: 3,
  maxTotalExposure: 0.8,
  maxSinglePosition: 0.25,
  maxCorrelatedExposure: 0.5,
  positionSizeScalar: 1.0,
  updatedAt: new Date(),
  updatedBy: 'DEFAULT',
};

export class RiskControlAgent {
  private anthropic: Anthropic;
  private db: Database;
  private positionTracker: PositionTracker;
  private currentParameters: RiskParameters;

  constructor(apiKey: string, db: Database, positionTracker: PositionTracker) {
    this.anthropic = new Anthropic({ apiKey });
    this.db = db;
    this.positionTracker = positionTracker;
    this.currentParameters = { ...DEFAULT_RISK_PARAMETERS };
  }

  async evaluate(
    accountState: AccountState,
    marketConditions: MarketConditions,
    systemRiskLevel: 'NORMAL' | 'REDUCED' | 'MINIMUM'
  ): Promise<RiskControlAgentOutput> {
    const startTime = Date.now();

    try {
      // Gather additional context
      const recentTrades = await this.db.getRecentTrades(50);
      const recentAlerts = await this.db.getUnacknowledgedAlerts();
      const volatilityMetrics = await this.calculateVolatilityMetrics();
      const recentLosses = this.calculateRecentLosses(recentTrades);

      // Build prompt
      const prompt = buildRiskControlAgentPrompt(
        accountState,
        marketConditions,
        this.currentParameters,
        recentTrades,
        recentAlerts,
        volatilityMetrics,
        recentLosses,
        systemRiskLevel
      );

      // Call Claude
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const latencyMs = Date.now() - startTime;
      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type');
      }

      // Parse JSON response
      const jsonMatch = content.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to extract JSON from response');
      }

      const output: RiskControlAgentOutput = JSON.parse(jsonMatch[0]);

      // Validate output
      this.validateOutput(output);

      // Apply safety constraints (hard limits that MCL cannot override)
      const constrainedOutput = this.applySafetyConstraints(output);

      console.log(
        `[RiskControlAgent] Risk Score: ${constrainedOutput.current_risk_score}, ` +
        `Stress: ${constrainedOutput.market_stress_level}, ` +
        `Confidence: ${constrainedOutput.confidence.toFixed(2)} (${latencyMs}ms)`
      );

      return constrainedOutput;
    } catch (error) {
      console.error('[RiskControlAgent] Error:', error);

      // Return safe defaults on error
      return this.getSafeDefaults(systemRiskLevel);
    }
  }

  private async calculateVolatilityMetrics(): Promise<{
    btc24hVol: number;
    btc7dVol: number;
    avgAssetVol: number;
    volTrend: 'INCREASING' | 'STABLE' | 'DECREASING';
  }> {
    try {
      // Get BTC candles for volatility calculation
      const btcCandles4h = await this.db.getCandles('BTC', '4h', 42); // ~7 days
      const btcCandles1h = await this.db.getCandles('BTC', '1h', 24); // 24 hours

      if (btcCandles4h.length < 6 || btcCandles1h.length < 6) {
        return {
          btc24hVol: 0.02, // Default 2%
          btc7dVol: 0.05,  // Default 5%
          avgAssetVol: 0.03,
          volTrend: 'STABLE',
        };
      }

      // Calculate 24h volatility (standard deviation of returns)
      const returns24h = btcCandles1h.slice(0, -1).map((c, i) =>
        (btcCandles1h[i + 1].close - c.close) / c.close
      );
      const btc24hVol = this.standardDeviation(returns24h);

      // Calculate 7d volatility
      const returns7d = btcCandles4h.slice(0, -1).map((c, i) =>
        (btcCandles4h[i + 1].close - c.close) / c.close
      );
      const btc7dVol = this.standardDeviation(returns7d);

      // Determine trend (compare recent vs older volatility)
      const recentVol = this.standardDeviation(returns24h.slice(0, 12));
      const olderVol = this.standardDeviation(returns24h.slice(12));

      let volTrend: 'INCREASING' | 'STABLE' | 'DECREASING' = 'STABLE';
      if (recentVol > olderVol * 1.3) volTrend = 'INCREASING';
      else if (recentVol < olderVol * 0.7) volTrend = 'DECREASING';

      return {
        btc24hVol,
        btc7dVol,
        avgAssetVol: btc24hVol * 1.2, // Assume altcoins are ~20% more volatile
        volTrend,
      };
    } catch {
      return {
        btc24hVol: 0.02,
        btc7dVol: 0.05,
        avgAssetVol: 0.03,
        volTrend: 'STABLE',
      };
    }
  }

  private standardDeviation(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
  }

  private calculateRecentLosses(trades: Trade[]): {
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

  private validateOutput(output: RiskControlAgentOutput): void {
    // Validate risk thresholds
    if (!output.risk_thresholds) {
      throw new Error('Missing risk_thresholds');
    }

    const { risk_thresholds } = output;
    if (risk_thresholds.drawdown_warning >= 0 || risk_thresholds.drawdown_warning < -50) {
      throw new Error(`Invalid drawdown_warning: ${risk_thresholds.drawdown_warning}`);
    }
    if (risk_thresholds.drawdown_critical >= risk_thresholds.drawdown_warning) {
      throw new Error('drawdown_critical must be lower than drawdown_warning');
    }
    if (risk_thresholds.drawdown_pause >= risk_thresholds.drawdown_critical) {
      throw new Error('drawdown_pause must be lower than drawdown_critical');
    }

    // Validate leverage caps
    if (!output.leverage_caps) {
      throw new Error('Missing leverage_caps');
    }
    if (output.leverage_caps.normal < 1 || output.leverage_caps.normal > 20) {
      throw new Error(`Invalid leverage_caps.normal: ${output.leverage_caps.normal}`);
    }
    if (output.leverage_caps.reduced >= output.leverage_caps.normal) {
      throw new Error('leverage_caps.reduced must be less than normal');
    }
    if (output.leverage_caps.minimum >= output.leverage_caps.reduced) {
      throw new Error('leverage_caps.minimum must be less than reduced');
    }

    // Validate exposure limits
    if (!output.exposure_limits) {
      throw new Error('Missing exposure_limits');
    }
    if (output.exposure_limits.max_total_exposure < 0.1 || output.exposure_limits.max_total_exposure > 1.0) {
      throw new Error(`Invalid max_total_exposure: ${output.exposure_limits.max_total_exposure}`);
    }

    // Validate confidence
    if (output.confidence < 0 || output.confidence > 1) {
      throw new Error(`Invalid confidence: ${output.confidence}`);
    }

    // Validate risk score
    if (output.current_risk_score < 0 || output.current_risk_score > 100) {
      throw new Error(`Invalid current_risk_score: ${output.current_risk_score}`);
    }
  }

  private applySafetyConstraints(output: RiskControlAgentOutput): RiskControlAgentOutput {
    // Hard limits that MCL cannot override (safety constraints from manifesto)
    const constrained = { ...output };

    // Drawdown pause cannot be higher than -15% (always at least some protection)
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

    // Max leverage cannot exceed 15x (safety cap)
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

  private getSafeDefaults(riskLevel: 'NORMAL' | 'REDUCED' | 'MINIMUM'): RiskControlAgentOutput {
    // Return conservative defaults based on current risk level
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

  // Convert MCL output to internal RiskParameters format
  applyOutput(output: RiskControlAgentOutput): RiskParameters {
    this.currentParameters = {
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

    return this.currentParameters;
  }

  getCurrentParameters(): RiskParameters {
    return { ...this.currentParameters };
  }

  // Reset to default parameters (useful for recovery)
  resetToDefaults(): RiskParameters {
    this.currentParameters = { ...DEFAULT_RISK_PARAMETERS };
    return this.currentParameters;
  }
}
