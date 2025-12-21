import { Database } from '../data/database';
import { PositionTracker } from './position-tracker';
import { Signal, RiskCheckResult, Alert } from '../types';

export class RiskManager {
  private db: Database;
  private positionTracker: PositionTracker;

  // Thresholds from spec
  private readonly DRAWDOWN_WARNING = -10;
  private readonly DRAWDOWN_CRITICAL = -15;
  private readonly DRAWDOWN_PAUSE = -20;
  private readonly DAILY_LOSS_PAUSE = -15;
  private readonly SINGLE_TRADE_LOSS_ALERT = -8;
  private readonly MAX_EXPOSURE_RATIO = 0.8;

  constructor(db: Database, positionTracker: PositionTracker) {
    this.db = db;
    this.positionTracker = positionTracker;
  }

  async checkPreTrade(signal: Signal, allocation: number, equity: number): Promise<RiskCheckResult> {
    const checks: string[] = [];

    // 1. Check if trading is enabled
    const systemState = await this.db.getSystemState();
    if (!systemState.tradingEnabled) {
      return { approved: false, reason: 'Trading is paused', maxLeverage: 0 };
    }

    // 2. Check drawdown
    const drawdown = ((equity - systemState.peakEquity) / systemState.peakEquity) * 100;
    if (drawdown <= this.DRAWDOWN_PAUSE) {
      await this.triggerPause('DRAWDOWN', `Drawdown ${drawdown.toFixed(2)}% exceeded -20% threshold`);
      return { approved: false, reason: 'Drawdown pause triggered', maxLeverage: 0 };
    }

    // 3. Check daily loss
    const dailyPnlPct = ((equity - systemState.dailyStartEquity) / systemState.dailyStartEquity) * 100;
    if (dailyPnlPct <= this.DAILY_LOSS_PAUSE) {
      await this.triggerPause('DAILY_LOSS', `Daily loss ${dailyPnlPct.toFixed(2)}% exceeded -15% threshold`);
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

    // 5. Calculate max leverage based on risk level
    let maxLeverage = 10; // Default
    if (drawdown <= this.DRAWDOWN_CRITICAL) {
      maxLeverage = 3;
      checks.push('Leverage capped to 3x due to critical drawdown');
    } else if (drawdown <= this.DRAWDOWN_WARNING) {
      maxLeverage = 5;
      checks.push('Leverage capped to 5x due to drawdown warning');
    }

    // 6. Check total exposure wouldn't exceed safe limits
    const currentMargin = this.positionTracker.getTotalMarginUsed();
    const newPositionMargin = equity * (allocation / 100) * 0.5; // Rough estimate
    if (currentMargin + newPositionMargin > equity * this.MAX_EXPOSURE_RATIO) {
      maxLeverage = Math.min(maxLeverage, 3);
      checks.push('Leverage reduced due to high total exposure');
    }

    return {
      approved: true,
      maxLeverage,
      checks,
    };
  }

  async runContinuousChecks(equity: number): Promise<{
    shouldPause: boolean;
    alerts: Alert[];
    riskLevel: 'NORMAL' | 'REDUCED' | 'MINIMUM';
  }> {
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

    // Check thresholds
    if (drawdown <= this.DRAWDOWN_PAUSE) {
      shouldPause = true;
      riskLevel = 'MINIMUM';
      alerts.push({
        alertTime: new Date(),
        alertType: 'DRAWDOWN_PAUSE',
        severity: 'PAUSE',
        title: 'TRADING PAUSED - Drawdown Limit',
        message: `Drawdown at ${drawdown.toFixed(2)}% exceeded -20% threshold. All positions will be closed.`,
        requiresAction: true,
      });
      await this.triggerPause('DRAWDOWN', `Drawdown ${drawdown.toFixed(2)}% exceeded -20%`);
    } else if (drawdown <= this.DRAWDOWN_CRITICAL) {
      riskLevel = 'MINIMUM';
      alerts.push({
        alertTime: new Date(),
        alertType: 'DRAWDOWN_CRITICAL',
        severity: 'CRITICAL',
        title: 'Critical Drawdown Warning',
        message: `Drawdown at ${drawdown.toFixed(2)}%. System at minimum exposure.`,
        requiresAction: false,
      });
    } else if (drawdown <= this.DRAWDOWN_WARNING) {
      riskLevel = 'REDUCED';
      alerts.push({
        alertTime: new Date(),
        alertType: 'DRAWDOWN_WARNING',
        severity: 'WARNING',
        title: 'Drawdown Warning',
        message: `Drawdown at ${drawdown.toFixed(2)}%. Exposure reduced.`,
        requiresAction: false,
      });
    }

    if (dailyPnlPct <= this.DAILY_LOSS_PAUSE) {
      shouldPause = true;
      riskLevel = 'MINIMUM';
      alerts.push({
        alertTime: new Date(),
        alertType: 'DAILY_LOSS_PAUSE',
        severity: 'PAUSE',
        title: 'TRADING PAUSED - Daily Loss Limit',
        message: `Daily loss ${dailyPnlPct.toFixed(2)}% exceeded -15% threshold.`,
        requiresAction: true,
      });
      await this.triggerPause('DAILY_LOSS', `Daily loss ${dailyPnlPct.toFixed(2)}% exceeded -15%`);
    }

    // Check individual position losses
    const positions = this.positionTracker.getAllPositions();
    for (const pos of positions) {
      const positionPnlPct = (pos.unrealizedPnl / pos.marginUsed) * 100;
      if (positionPnlPct <= this.SINGLE_TRADE_LOSS_ALERT) {
        alerts.push({
          alertTime: new Date(),
          alertType: 'SINGLE_TRADE_LOSS',
          severity: 'WARNING',
          title: 'Large Position Loss',
          message: `${pos.symbol} ${pos.side} position at ${positionPnlPct.toFixed(2)}% loss.`,
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
