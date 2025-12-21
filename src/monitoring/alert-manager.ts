import { Database } from '../data/database';
import { Alert, PauseAnalysis } from '../types';

export class AlertManager {
  private db: Database;
  private telegramBot: any | null = null; // Will be set after initialization

  constructor(db: Database) {
    this.db = db;
  }

  setTelegramBot(bot: any): void {
    this.telegramBot = bot;
  }

  async send(alert: Alert): Promise<void> {
    // Store in database
    await this.db.insertAlert(alert);

    // Send via Telegram if available
    if (this.telegramBot) {
      await this.telegramBot.sendAlert(alert);
    }

    console.log(`[Alert] [${alert.severity}] ${alert.title}: ${alert.message}`);
  }

  async sendPauseAlert(reason: string, details: string): Promise<void> {
    const alert: Alert = {
      alertTime: new Date(),
      alertType: 'SYSTEM_PAUSE',
      severity: 'PAUSE',
      title: 'TRADING PAUSED - Human Decision Required',
      message: `Reason: ${reason}\nDetails: ${details}`,
      requiresAction: true,
    };

    await this.send(alert);
  }

  async sendTradeAlert(
    symbol: string,
    side: string,
    size: number,
    price: number,
    strategy: string,
    pnl?: number
  ): Promise<void> {
    const isOpen = side === 'BUY' || side === 'SELL';
    const alert: Alert = {
      alertTime: new Date(),
      alertType: isOpen ? 'TRADE_OPEN' : 'TRADE_CLOSE',
      severity: 'INFO',
      title: `${isOpen ? 'Opened' : 'Closed'} ${symbol} ${side}`,
      message: `Strategy: ${strategy}\nSize: ${size.toFixed(4)}\nPrice: $${price.toFixed(2)}${pnl !== undefined ? `\nP&L: $${pnl.toFixed(2)}` : ''}`,
      requiresAction: false,
    };

    await this.send(alert);
  }

  async sendDrawdownAlert(drawdownPct: number, level: 'WARNING' | 'CRITICAL'): Promise<void> {
    const alert: Alert = {
      alertTime: new Date(),
      alertType: `DRAWDOWN_${level}`,
      severity: level,
      title: `${level === 'CRITICAL' ? 'Critical ' : ''}Drawdown Alert`,
      message: `Current drawdown: ${drawdownPct.toFixed(2)}%`,
      requiresAction: level === 'CRITICAL',
    };

    await this.send(alert);
  }

  async sendMCLAlert(decision: string, allocations: Record<string, number>): Promise<void> {
    const alert: Alert = {
      alertTime: new Date(),
      alertType: 'MCL_DECISION',
      severity: 'INFO',
      title: 'MCL Decision Made',
      message: `Decision: ${decision}\nNew allocations: ${Object.entries(allocations).map(([k, v]) => `${k}: ${v}%`).join(', ')}`,
      requiresAction: false,
    };

    await this.send(alert);
  }
}
