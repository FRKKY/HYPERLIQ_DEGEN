import { Database } from '../data/database';
import { PositionTracker } from './position-tracker';
import { Signal, RiskCheckResult, Alert, RiskParameters } from '../types';

// Default risk parameters (from manifesto spec)
const DEFAULT_RISK_PARAMS: RiskParameters = {
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

export class RiskManager {
  private db: Database;
  private positionTracker: PositionTracker;
  private riskParams: RiskParameters;

  constructor(db: Database, positionTracker: PositionTracker) {
    this.db = db;
    this.positionTracker = positionTracker;
    this.riskParams = { ...DEFAULT_RISK_PARAMS };
  }

  // Update risk parameters from MCL Risk Control Agent
  updateRiskParameters(params: RiskParameters): void {
    this.riskParams = { ...params };
    console.log(`[RiskManager] Risk parameters updated by ${params.updatedBy} at ${params.updatedAt.toISOString()}`);
    console.log(`[RiskManager] Drawdown thresholds: Warning=${params.drawdownWarning}%, Critical=${params.drawdownCritical}%, Pause=${params.drawdownPause}%`);
    console.log(`[RiskManager] Leverage caps: Normal=${params.maxLeverageNormal}x, Reduced=${params.maxLeverageReduced}x, Minimum=${params.maxLeverageMinimum}x`);
  }

  getCurrentRiskParameters(): RiskParameters {
    return { ...this.riskParams };
  }

  resetToDefaults(): void {
    this.riskParams = { ...DEFAULT_RISK_PARAMS };
    console.log('[RiskManager] Risk parameters reset to defaults');
  }

  async checkPreTrade(signal: Signal, allocation: number, equity: number): Promise<RiskCheckResult> {
    const checks: string[] = [];
    const params = this.riskParams;

    // Guard against invalid equity values
    if (isNaN(equity) || equity <= 0) {
      return { approved: false, reason: 'Invalid equity value', maxLeverage: 0 };
    }

    // 1. Check if trading is enabled
    const systemState = await this.db.getSystemState();
    if (!systemState.tradingEnabled) {
      return { approved: false, reason: 'Trading is paused', maxLeverage: 0 };
    }

    // Guard against uninitialized system state
    if (!systemState.peakEquity || systemState.peakEquity <= 0 ||
        !systemState.dailyStartEquity || systemState.dailyStartEquity <= 0) {
      // Initialize with current equity if not set
      if (!systemState.peakEquity || systemState.peakEquity <= 0) {
        await this.db.updateSystemState('peak_equity', equity);
        systemState.peakEquity = equity;
      }
      if (!systemState.dailyStartEquity || systemState.dailyStartEquity <= 0) {
        await this.db.updateSystemState('daily_start_equity', equity);
        systemState.dailyStartEquity = equity;
      }
    }

    // 2. Check drawdown (using dynamic MCL parameters)
    const drawdown = ((equity - systemState.peakEquity) / systemState.peakEquity) * 100;
    if (drawdown <= params.drawdownPause) {
      await this.triggerPause('DRAWDOWN', `Drawdown ${drawdown.toFixed(2)}% exceeded ${params.drawdownPause}% threshold`);
      return { approved: false, reason: 'Drawdown pause triggered', maxLeverage: 0 };
    }

    // 3. Check daily loss (using dynamic MCL parameters)
    const dailyPnlPct = ((equity - systemState.dailyStartEquity) / systemState.dailyStartEquity) * 100;
    if (dailyPnlPct <= params.dailyLossPause) {
      await this.triggerPause('DAILY_LOSS', `Daily loss ${dailyPnlPct.toFixed(2)}% exceeded ${params.dailyLossPause}% threshold`);
      return { approved: false, reason: 'Daily loss pause triggered', maxLeverage: 0 };
    }

    // 4. Check existing position conflict
    const existingPosition = this.positionTracker.getPosition(signal.symbol);
    if (existingPosition) {
      // Can't open opposite direction without closing first
      if (
        (existingPosition.side === 'LONG' && signal.direction === 'SHORT') ||
        (existingPosition.side === 'SHORT' && signal.direction === 'LONG')
      ) {
        return { approved: false, reason: 'Conflicting position exists', maxLeverage: 0 };
      }
    }

    // 5. Calculate max leverage based on risk level (using dynamic MCL parameters)
    let maxLeverage = params.maxLeverageNormal;
    if (drawdown <= params.drawdownCritical) {
      maxLeverage = params.maxLeverageMinimum;
      checks.push(`Leverage capped to ${params.maxLeverageMinimum}x due to critical drawdown`);
    } else if (drawdown <= params.drawdownWarning) {
      maxLeverage = params.maxLeverageReduced;
      checks.push(`Leverage capped to ${params.maxLeverageReduced}x due to drawdown warning`);
    }

    // 6. Check total exposure wouldn't exceed safe limits (using dynamic MCL parameters)
    const currentMargin = this.positionTracker.getTotalMarginUsed();
    const newPositionMargin = equity * (allocation / 100) * 0.5; // Rough estimate
    if (currentMargin + newPositionMargin > equity * params.maxTotalExposure) {
      maxLeverage = Math.min(maxLeverage, params.maxLeverageMinimum);
      checks.push(`Leverage reduced due to high total exposure (>${(params.maxTotalExposure * 100).toFixed(0)}%)`);
    }

    // 7. Check single position size limit (using dynamic MCL parameters)
    const positionSizeRatio = (allocation / 100);
    if (positionSizeRatio > params.maxSinglePosition) {
      checks.push(`Position size reduced to ${(params.maxSinglePosition * 100).toFixed(0)}% max`);
    }

    // 8. Apply position size scalar from MCL
    if (params.positionSizeScalar !== 1.0) {
      checks.push(`Position size scaled by ${params.positionSizeScalar.toFixed(2)}x (volatility adjustment)`);
    }

    return {
      approved: true,
      maxLeverage,
      checks,
    };
  }

  // Get position size scalar from MCL (for use by order manager)
  getPositionSizeScalar(): number {
    return this.riskParams.positionSizeScalar;
  }

  // Get max single position size from MCL
  getMaxSinglePositionSize(): number {
    return this.riskParams.maxSinglePosition;
  }

  async runContinuousChecks(equity: number): Promise<{
    shouldPause: boolean;
    alerts: Alert[];
    riskLevel: 'NORMAL' | 'REDUCED' | 'MINIMUM';
  }> {
    const params = this.riskParams;

    // Guard against invalid equity values
    if (isNaN(equity) || equity <= 0) {
      console.log('[RiskManager] Skipping risk check - invalid equity value:', equity);
      return { shouldPause: false, alerts: [], riskLevel: 'NORMAL' };
    }

    const systemState = await this.db.getSystemState();
    const alerts: Alert[] = [];
    let riskLevel: 'NORMAL' | 'REDUCED' | 'MINIMUM' = 'NORMAL';
    let shouldPause = false;

    // Guard against uninitialized system state
    if (!systemState.peakEquity || systemState.peakEquity <= 0) {
      console.log('[RiskManager] Initializing peak equity to:', equity);
      await this.db.updateSystemState('peak_equity', equity);
      systemState.peakEquity = equity;
    }
    if (!systemState.dailyStartEquity || systemState.dailyStartEquity <= 0) {
      console.log('[RiskManager] Initializing daily start equity to:', equity);
      await this.db.updateSystemState('daily_start_equity', equity);
      systemState.dailyStartEquity = equity;
    }

    // Update peak equity
    if (equity > systemState.peakEquity) {
      await this.db.updateSystemState('peak_equity', equity);
    }

    const drawdown = ((equity - systemState.peakEquity) / systemState.peakEquity) * 100;
    const dailyPnlPct = ((equity - systemState.dailyStartEquity) / systemState.dailyStartEquity) * 100;

    // Check thresholds (using dynamic MCL parameters)
    if (drawdown <= params.drawdownPause) {
      shouldPause = true;
      riskLevel = 'MINIMUM';
      alerts.push({
        alertTime: new Date(),
        alertType: 'DRAWDOWN_PAUSE',
        severity: 'PAUSE',
        title: 'TRADING PAUSED - Drawdown Limit',
        message: `Drawdown at ${drawdown.toFixed(2)}% exceeded ${params.drawdownPause}% threshold. All positions will be closed.`,
        requiresAction: true,
      });
      await this.triggerPause('DRAWDOWN', `Drawdown ${drawdown.toFixed(2)}% exceeded ${params.drawdownPause}%`);
    } else if (drawdown <= params.drawdownCritical) {
      riskLevel = 'MINIMUM';
      alerts.push({
        alertTime: new Date(),
        alertType: 'DRAWDOWN_CRITICAL',
        severity: 'CRITICAL',
        title: 'Critical Drawdown Warning',
        message: `Drawdown at ${drawdown.toFixed(2)}%. System at minimum exposure (threshold: ${params.drawdownCritical}%).`,
        requiresAction: false,
      });
    } else if (drawdown <= params.drawdownWarning) {
      riskLevel = 'REDUCED';
      alerts.push({
        alertTime: new Date(),
        alertType: 'DRAWDOWN_WARNING',
        severity: 'WARNING',
        title: 'Drawdown Warning',
        message: `Drawdown at ${drawdown.toFixed(2)}%. Exposure reduced (threshold: ${params.drawdownWarning}%).`,
        requiresAction: false,
      });
    }

    if (dailyPnlPct <= params.dailyLossPause) {
      shouldPause = true;
      riskLevel = 'MINIMUM';
      alerts.push({
        alertTime: new Date(),
        alertType: 'DAILY_LOSS_PAUSE',
        severity: 'PAUSE',
        title: 'TRADING PAUSED - Daily Loss Limit',
        message: `Daily loss ${dailyPnlPct.toFixed(2)}% exceeded ${params.dailyLossPause}% threshold.`,
        requiresAction: true,
      });
      await this.triggerPause('DAILY_LOSS', `Daily loss ${dailyPnlPct.toFixed(2)}% exceeded ${params.dailyLossPause}%`);
    }

    // Check individual position losses (using dynamic MCL parameters)
    const positions = this.positionTracker.getAllPositions();
    for (const pos of positions) {
      const positionPnlPct = (pos.unrealizedPnl / pos.marginUsed) * 100;
      if (positionPnlPct <= params.singleTradeLossAlert) {
        alerts.push({
          alertTime: new Date(),
          alertType: 'SINGLE_TRADE_LOSS',
          severity: 'WARNING',
          title: 'Large Position Loss',
          message: `${pos.symbol} ${pos.side} position at ${positionPnlPct.toFixed(2)}% loss (alert threshold: ${params.singleTradeLossAlert}%).`,
          requiresAction: false,
        });
      }
    }

    // Store alerts in database
    for (const alert of alerts) {
      await this.db.insertAlert(alert);
    }

    return { shouldPause, alerts, riskLevel };
  }

  async triggerPause(reason: string, details: string): Promise<void> {
    // 1. Update system state
    await this.db.updateSystemState('trading_enabled', false);
    await this.db.updateSystemState('system_status', 'PAUSED');
    await this.db.updateSystemState('pause_reason', details);

    console.log(`[RiskManager] Trading PAUSED: ${reason} - ${details}`);
  }

  async resumeTrading(): Promise<void> {
    await this.db.updateSystemState('trading_enabled', true);
    await this.db.updateSystemState('system_status', 'RUNNING');
    await this.db.updateSystemState('pause_reason', null);

    console.log('[RiskManager] Trading RESUMED');
  }

  async resetDailyMetrics(equity: number): Promise<void> {
    await this.db.updateSystemState('daily_start_equity', equity);
    await this.db.updateSystemState('daily_pnl', 0);

    console.log(`[RiskManager] Daily metrics reset. Start equity: $${equity.toFixed(2)}`);
  }

  calculatePositionSize(
    allocation: number,
    equity: number,
    entryPrice: number,
    stopLoss: number,
    maxLeverage: number,
    capitalUtilization: number
  ): { size: number; leverage: number; marginRequired: number } {
    const allocatedCapital = equity * (allocation / 100);
    const baseSize = allocatedCapital * capitalUtilization;

    // Calculate leverage based on stop loss distance
    let leverage = maxLeverage;
    const slDistance = Math.abs(entryPrice - stopLoss) / entryPrice;
    if (slDistance > 0) {
      // Max loss per trade = 8% of equity
      const maxLossPerTrade = equity * 0.08;
      const requiredMargin = maxLossPerTrade / slDistance;
      leverage = Math.min(maxLeverage, Math.floor(baseSize / requiredMargin));
    }

    leverage = Math.max(1, leverage);
    const positionValue = baseSize * leverage;
    const size = positionValue / entryPrice;

    return {
      size,
      leverage,
      marginRequired: baseSize,
    };
  }
}
