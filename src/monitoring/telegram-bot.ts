import TelegramBot from 'node-telegram-bot-api';
import { Database } from '../data/database';
import { Alert, DailyReport, PauseAnalysis, Position, StrategyAllocation } from '../types';

interface SystemController {
  getAccountState(): Promise<{
    equity: number;
    availableBalance: number;
    unrealizedPnl: number;
    drawdownPct: number;
  }>;
  getPositions(): Promise<Position[]>;
  resumeTrading(): Promise<void>;
  stopTrading(): Promise<void>;
  generatePauseAnalysis(): Promise<PauseAnalysis>;
}

export class TradingTelegramBot {
  private bot: TelegramBot;
  private chatId: string;
  private db: Database;
  private systemController: SystemController | null = null;

  constructor(token: string, chatId: string, db: Database) {
    this.bot = new TelegramBot(token, { polling: true });
    this.chatId = chatId;
    this.db = db;
    this.setupCommands();
  }

  setSystemController(controller: SystemController): void {
    this.systemController = controller;
  }

  private setupCommands(): void {
    this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
    this.bot.onText(/\/status/, (msg) => this.handleStatus(msg));
    this.bot.onText(/\/positions/, (msg) => this.handlePositions(msg));
    this.bot.onText(/\/report/, (msg) => this.handleReport(msg));
    this.bot.onText(/\/help/, (msg) => this.handleHelp(msg));
    this.bot.onText(/^GO$/i, (msg) => this.handleGo(msg));
    this.bot.onText(/^STOP$/i, (msg) => this.handleStop(msg));

    this.bot.on('error', (error) => {
      console.error('[Telegram] Bot error:', error);
    });
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    await this.bot.sendMessage(
      msg.chat.id,
      `🤖 *Hyperliquid Trading Bot*\n\n` +
        `Commands:\n` +
        `/status - System status\n` +
        `/positions - Open positions\n` +
        `/report - Generate report\n` +
        `/help - Show help\n\n` +
        `Reply *GO* to resume from pause\n` +
        `Reply *STOP* to shutdown`,
      { parse_mode: 'Markdown' }
    );
  }

  private async handleStatus(msg: TelegramBot.Message): Promise<void> {
    try {
      const state = await this.db.getSystemState();

      let accountInfo = { equity: 0, availableBalance: 0, unrealizedPnl: 0, drawdownPct: 0 };
      if (this.systemController) {
        accountInfo = await this.systemController.getAccountState();
      }

      const statusEmoji: Record<string, string> = {
        RUNNING: '✅',
        PAUSED: '⏸️',
        ERROR: '❌',
        STOPPED: '🛑',
      };

      await this.bot.sendMessage(
        msg.chat.id,
        `${statusEmoji[state.systemStatus] || '❓'} *System Status*\n\n` +
          `Status: ${state.systemStatus}\n` +
          `Trading: ${state.tradingEnabled ? 'Enabled' : 'Disabled'}\n` +
          `${state.pauseReason ? `Pause Reason: ${state.pauseReason}\n` : ''}` +
          `\n💰 *Account*\n` +
          `Equity: $${accountInfo.equity.toFixed(2)}\n` +
          `Available: $${accountInfo.availableBalance.toFixed(2)}\n` +
          `Unrealized P&L: $${accountInfo.unrealizedPnl.toFixed(2)}\n` +
          `Drawdown: ${accountInfo.drawdownPct.toFixed(2)}%\n` +
          `\n📊 *Allocations*\n` +
          Object.entries(state.currentAllocations)
            .map(([s, a]) => `${s}: ${a}%`)
            .join('\n'),
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, '❌ Error fetching status');
    }
  }

  private async handlePositions(msg: TelegramBot.Message): Promise<void> {
    try {
      if (!this.systemController) {
        await this.bot.sendMessage(msg.chat.id, '❌ System controller not available');
        return;
      }

      const positions = await this.systemController.getPositions();

      if (positions.length === 0) {
        await this.bot.sendMessage(msg.chat.id, '📭 No open positions');
        return;
      }

      const positionText = positions
        .map(
          (p) =>
            `*${p.symbol}* ${p.side}\n` +
            `  Size: ${p.size.toFixed(4)}\n` +
            `  Entry: $${p.entryPrice.toFixed(2)}\n` +
            `  P&L: $${p.unrealizedPnl.toFixed(2)} (${((p.unrealizedPnl / p.marginUsed) * 100).toFixed(2)}%)\n` +
            `  Strategy: ${p.strategyName}`
        )
        .join('\n\n');

      await this.bot.sendMessage(msg.chat.id, `📊 *Open Positions*\n\n${positionText}`, {
        parse_mode: 'Markdown',
      });
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, '❌ Error fetching positions');
    }
  }

  private async handleReport(msg: TelegramBot.Message): Promise<void> {
    await this.bot.sendMessage(msg.chat.id, '📊 Generating report...');
    // Would generate and send report
    await this.bot.sendMessage(msg.chat.id, 'Report generation not yet implemented');
  }

  private async handleHelp(msg: TelegramBot.Message): Promise<void> {
    await this.bot.sendMessage(
      msg.chat.id,
      `🤖 *Hyperliquid Trading Bot Help*\n\n` +
        `*Commands:*\n` +
        `/start - Initialize bot\n` +
        `/status - Current system status\n` +
        `/positions - View open positions\n` +
        `/report - Generate daily report\n` +
        `/help - This help message\n\n` +
        `*Actions:*\n` +
        `Reply *GO* - Resume trading after pause\n` +
        `Reply *STOP* - Stop all trading and close positions\n\n` +
        `*Alerts:*\n` +
        `ℹ️ Info - General updates\n` +
        `⚠️ Warning - Attention needed\n` +
        `🚨 Critical - Immediate action may be needed\n` +
        `🛑 Pause - Human decision required`,
      { parse_mode: 'Markdown' }
    );
  }

  private async handleGo(msg: TelegramBot.Message): Promise<void> {
    try {
      const state = await this.db.getSystemState();

      if (state.systemStatus !== 'PAUSED') {
        await this.bot.sendMessage(msg.chat.id, '⚠️ System is not paused');
        return;
      }

      if (!state.awaitingGoConfirm) {
        // First GO - show analysis
        if (this.systemController) {
          const analysis = await this.systemController.generatePauseAnalysis();

          await this.bot.sendMessage(
            msg.chat.id,
            `📋 *Analysis Report*\n\n` +
              `Pause Reason: ${state.pauseReason}\n\n` +
              `*What Happened:*\n${analysis.whatHappened}\n\n` +
              `*Root Cause:*\n${analysis.rootCause}\n\n` +
              `*MCL Assessment:*\n${analysis.mclAssessment}\n\n` +
              `Confirm resume? Reply GO again to confirm.`,
            { parse_mode: 'Markdown' }
          );

          await this.db.updateSystemState('awaiting_go_confirm', true);
        }
      } else {
        // Confirmed GO - resume trading
        if (this.systemController) {
          await this.systemController.resumeTrading();
          await this.db.updateSystemState('awaiting_go_confirm', false);
          await this.bot.sendMessage(msg.chat.id, '✅ Trading resumed');
        }
      }
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, '❌ Error processing GO command');
    }
  }

  private async handleStop(msg: TelegramBot.Message): Promise<void> {
    try {
      const state = await this.db.getSystemState();

      if (!state.awaitingStopConfirm) {
        await this.bot.sendMessage(
          msg.chat.id,
          `⚠️ *Shutdown Requested*\n\n` +
            `This will:\n` +
            `• Close all open positions\n` +
            `• Stop all trading\n` +
            `• Require manual restart\n\n` +
            `Reply STOP again to confirm.`,
          { parse_mode: 'Markdown' }
        );

        await this.db.updateSystemState('awaiting_stop_confirm', true);
      } else {
        // Confirmed STOP
        if (this.systemController) {
          await this.systemController.stopTrading();
          await this.db.updateSystemState('awaiting_stop_confirm', false);
          await this.bot.sendMessage(msg.chat.id, '🛑 System stopped. All positions closed.');
        }
      }
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, '❌ Error processing STOP command');
    }
  }

  // === Alert Methods ===

  async sendAlert(alert: Alert): Promise<void> {
    const severityEmoji: Record<string, string> = {
      INFO: 'ℹ️',
      WARNING: '⚠️',
      CRITICAL: '🚨',
      PAUSE: '🛑',
    };

    await this.bot.sendMessage(
      this.chatId,
      `${severityEmoji[alert.severity] || '❓'} *${alert.title}*\n\n${alert.message}`,
      { parse_mode: 'Markdown' }
    );
  }

  async sendPauseAlert(reason: string, details: string, analysis: PauseAnalysis): Promise<void> {
    await this.bot.sendMessage(
      this.chatId,
      `🛑 *TRADING PAUSED - HUMAN DECISION REQUIRED*\n\n` +
        `*Reason:* ${reason}\n` +
        `*Details:* ${details}\n\n` +
        `*What Happened:*\n${analysis.whatHappened}\n\n` +
        `*Root Cause Analysis:*\n${analysis.rootCause}\n\n` +
        `*MCL Assessment:*\n${analysis.mclAssessment}\n\n` +
        `Reply:\n` +
        `  *GO* - Resume trading\n` +
        `  *STOP* - Shutdown system\n` +
        `  *STATUS* - Get current state`,
      { parse_mode: 'Markdown' }
    );
  }

  async sendDailyReport(report: DailyReport): Promise<void> {
    const pnlEmoji = report.pnlChange >= 0 ? '📈' : '📉';

    await this.bot.sendMessage(
      this.chatId,
      `📊 *DAILY REPORT - ${report.date}*\n\n` +
        `💰 *EQUITY*\n` +
        `  Start: $${report.startEquity.toFixed(2)}\n` +
        `  End: $${report.endEquity.toFixed(2)}\n` +
        `  Change: ${pnlEmoji} $${report.pnlChange.toFixed(2)} (${report.pnlChangePct.toFixed(2)}%)\n` +
        `  Peak: $${report.peakEquity.toFixed(2)}\n` +
        `  Drawdown: ${report.drawdownPct.toFixed(2)}%\n\n` +
        `📈 *STRATEGY PERFORMANCE (24h)*\n` +
        report.strategyPerformances
          .map(
            (s) =>
              `  ${s.name}: ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)} (${s.trades} trades, ${s.wins}W/${s.losses}L)`
          )
          .join('\n') +
        `\n\n` +
        `⚙️ *MCL DECISIONS*\n` +
        report.mclDecisions.map((d) => `  • ${d}`).join('\n') +
        `\n\n` +
        `📊 *CURRENT STATE*\n` +
        `  Open positions: ${report.openPositions}\n` +
        `  Allocations: ${Object.entries(report.allocations)
          .map(([k, v]) => `[${k} ${v}%]`)
          .join(' ')}\n` +
        `  System health: ${report.systemHealth}`,
      { parse_mode: 'Markdown' }
    );
  }

  stop(): void {
    this.bot.stopPolling();
  }
}
