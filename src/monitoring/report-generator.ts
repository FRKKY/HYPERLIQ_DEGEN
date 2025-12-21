import { Database } from '../data/database';
import { DailyReport, StrategyPerformance, MCLDecision, Position, SystemState } from '../types';

export class ReportGenerator {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async generateDailyReport(
    equity: number,
    positions: Position[]
  ): Promise<DailyReport> {
    const systemState = await this.db.getSystemState();
    const performances = await this.db.getStrategyPerformances(24);
    const mclDecisions = await this.db.getRecentMCLDecisions(24);

    return {
      date: new Date().toISOString().split('T')[0],
      startEquity: systemState.dailyStartEquity,
      endEquity: equity,
      pnlChange: equity - systemState.dailyStartEquity,
      pnlChangePct: ((equity - systemState.dailyStartEquity) / systemState.dailyStartEquity) * 100,
      peakEquity: systemState.peakEquity,
      drawdownPct: ((equity - systemState.peakEquity) / systemState.peakEquity) * 100,
      strategyPerformances: performances.map((p) => ({
        name: p.strategyName,
        pnl: p.totalPnl,
        trades: p.totalTrades,
        wins: p.winningTrades,
        losses: p.losingTrades,
      })),
      mclDecisions: mclDecisions.map((d) => d.reasoning.substring(0, 50)),
      openPositions: positions.length,
      allocations: systemState.currentAllocations,
      systemHealth: systemState.systemStatus,
      dashboardUrl: `http://localhost:${process.env.PORT || 3000}`,
    };
  }

  async generateWeeklyReport(
    equity: number,
    positions: Position[]
  ): Promise<{
    weekStart: string;
    weekEnd: string;
    startEquity: number;
    endEquity: number;
    pnlChange: number;
    pnlChangePct: number;
    totalTrades: number;
    winRate: number;
    bestStrategy: string;
    worstStrategy: string;
    maxDrawdown: number;
  }> {
    const performances = await this.db.getStrategyPerformances(168); // 7 days
    const systemState = await this.db.getSystemState();

    const totalTrades = performances.reduce((sum, p) => sum + p.totalTrades, 0);
    const totalWins = performances.reduce((sum, p) => sum + p.winningTrades, 0);

    const sortedByPnl = [...performances].sort((a, b) => b.totalPnl - a.totalPnl);
    const bestStrategy = sortedByPnl[0]?.strategyName || 'N/A';
    const worstStrategy = sortedByPnl[sortedByPnl.length - 1]?.strategyName || 'N/A';

    const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekEnd = new Date().toISOString().split('T')[0];

    // Estimate start equity (rough approximation)
    const weeklyPnl = performances.reduce((sum, p) => sum + p.totalPnl, 0);
    const estimatedStartEquity = equity - weeklyPnl;

    return {
      weekStart,
      weekEnd,
      startEquity: estimatedStartEquity,
      endEquity: equity,
      pnlChange: weeklyPnl,
      pnlChangePct: estimatedStartEquity > 0 ? (weeklyPnl / estimatedStartEquity) * 100 : 0,
      totalTrades,
      winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
      bestStrategy,
      worstStrategy,
      maxDrawdown: Math.min(...performances.map((p) => p.maxDrawdown)),
    };
  }

  async generateStrategyReport(
    strategyName: string,
    periodHours: number = 24
  ): Promise<{
    strategyName: string;
    periodHours: number;
    totalTrades: number;
    winRate: number;
    totalPnl: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    sharpeRatio: number;
    maxDrawdown: number;
    consecutiveLosses: number;
  } | null> {
    const performances = await this.db.getStrategyPerformances(periodHours);
    const perf = performances.find((p) => p.strategyName === strategyName);

    if (!perf) {
      return null;
    }

    return {
      strategyName: perf.strategyName,
      periodHours,
      totalTrades: perf.totalTrades,
      winRate: perf.totalTrades > 0 ? (perf.winningTrades / perf.totalTrades) * 100 : 0,
      totalPnl: perf.totalPnl,
      avgWin: perf.avgWin,
      avgLoss: perf.avgLoss,
      profitFactor: perf.profitFactor,
      sharpeRatio: perf.sharpeRatio,
      maxDrawdown: perf.maxDrawdown,
      consecutiveLosses: perf.consecutiveLosses,
    };
  }

  formatDailyReportText(report: DailyReport): string {
    const pnlEmoji = report.pnlChange >= 0 ? '+' : '';

    return [
      `=== DAILY REPORT - ${report.date} ===`,
      '',
      'EQUITY',
      `  Start: $${report.startEquity.toFixed(2)}`,
      `  End: $${report.endEquity.toFixed(2)}`,
      `  Change: ${pnlEmoji}$${report.pnlChange.toFixed(2)} (${pnlEmoji}${report.pnlChangePct.toFixed(2)}%)`,
      `  Peak: $${report.peakEquity.toFixed(2)}`,
      `  Drawdown: ${report.drawdownPct.toFixed(2)}%`,
      '',
      'STRATEGY PERFORMANCE (24h)',
      ...report.strategyPerformances.map(
        (s) =>
          `  ${s.name}: ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)} (${s.trades} trades, ${s.wins}W/${s.losses}L)`
      ),
      '',
      'MCL DECISIONS',
      ...report.mclDecisions.map((d) => `  - ${d}`),
      '',
      'CURRENT STATE',
      `  Open positions: ${report.openPositions}`,
      `  Allocations: ${Object.entries(report.allocations)
        .map(([k, v]) => `${k}:${v}%`)
        .join(', ')}`,
      `  System health: ${report.systemHealth}`,
    ].join('\n');
  }
}
