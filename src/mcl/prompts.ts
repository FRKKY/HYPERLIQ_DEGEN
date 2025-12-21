import {
  AccountState,
  StrategyPerformance,
  Signal,
  MarketConditions,
  SystemHealthCheck,
  StrategyAllocation,
  Position,
  Alert,
} from '../types';

export function buildSystemEvaluatorPrompt(
  systemStatus: string,
  tradingEnabled: boolean,
  lastMclRun: Date | null,
  accountState: AccountState,
  healthChecks: SystemHealthCheck[],
  recentAlerts: Alert[]
): string {
  return `You are the System Evaluator for an autonomous cryptocurrency trading system.

CURRENT STATE:
- System Status: ${systemStatus}
- Trading Enabled: ${tradingEnabled}
- Last MCL Run: ${lastMclRun?.toISOString() || 'Never'}

ACCOUNT STATE:
- Equity: $${accountState.equity.toFixed(2)}
- Peak Equity: $${accountState.peakEquity.toFixed(2)}
- Drawdown: ${accountState.drawdownPct.toFixed(2)}%
- Available Balance: $${accountState.availableBalance.toFixed(2)}
- Unrealized P&L: $${accountState.unrealizedPnl.toFixed(2)}
- Realized P&L (24h): $${accountState.realizedPnl24h.toFixed(2)}
- Open Positions: ${accountState.positions.length}

SYSTEM HEALTH:
${healthChecks.map((h) => `- ${h.component}: ${h.status}${h.details ? ` (${JSON.stringify(h.details)})` : ''}`).join('\n')}

THRESHOLDS:
- Drawdown Warning: -10%
- Drawdown Critical: -15%
- Drawdown Pause: -20%
- Daily Loss Pause: -15%

RECENT ALERTS (last 24h):
${recentAlerts.slice(0, 10).map((a) => `- [${a.severity}] ${a.title}: ${a.message}`).join('\n') || 'None'}

Evaluate the system and respond in JSON format:
{
  "overall_health": "OK" | "DEGRADED" | "CRITICAL",
  "should_pause": boolean,
  "pause_reason": string | null,
  "risk_level": "NORMAL" | "REDUCED" | "MINIMUM",
  "anomalies_detected": string[],
  "recommendations": string[],
  "confidence": number (0.0 to 1.0)
}

Consider:
1. Is equity trajectory healthy?
2. Are all components functioning?
3. Any concerning patterns in recent alerts?
4. Should we reduce exposure preemptively?`;
}

export function buildAgentEvaluatorPrompt(
  currentAllocations: StrategyAllocation,
  strategyPerformances: {
    name: string;
    perf1h: StrategyPerformance | null;
    perf24h: StrategyPerformance | null;
    perf7d: StrategyPerformance | null;
    enabled: boolean;
    openPositions: number;
    pendingSignals: number;
  }[],
  marketConditions: MarketConditions,
  equity: number,
  drawdownPct: number,
  riskLevel: string
): string {
  const strategyDetails = strategyPerformances
    .map(
      (s) => `
## ${s.name}
### Last 1 Hour:
- Trades: ${s.perf1h?.totalTrades || 0} (${s.perf1h?.winningTrades || 0}W / ${s.perf1h?.losingTrades || 0}L)
- P&L: $${s.perf1h?.totalPnl?.toFixed(2) || '0.00'}
- Consecutive Losses: ${s.perf1h?.consecutiveLosses || 0}

### Last 24 Hours:
- Trades: ${s.perf24h?.totalTrades || 0} (${s.perf24h?.winningTrades || 0}W / ${s.perf24h?.losingTrades || 0}L)
- P&L: $${s.perf24h?.totalPnl?.toFixed(2) || '0.00'}
- Win Rate: ${s.perf24h?.totalTrades ? ((s.perf24h.winningTrades / s.perf24h.totalTrades) * 100).toFixed(1) : '0'}%
- Profit Factor: ${s.perf24h?.profitFactor?.toFixed(2) || 'N/A'}
- Max Drawdown: ${s.perf24h?.maxDrawdown?.toFixed(2) || '0'}%
- Sharpe Ratio: ${s.perf24h?.sharpeRatio?.toFixed(2) || 'N/A'}

### Last 7 Days:
- Trades: ${s.perf7d?.totalTrades || 0} (${s.perf7d?.winningTrades || 0}W / ${s.perf7d?.losingTrades || 0}L)
- P&L: $${s.perf7d?.totalPnl?.toFixed(2) || '0.00'}
- Win Rate: ${s.perf7d?.totalTrades ? ((s.perf7d.winningTrades / s.perf7d.totalTrades) * 100).toFixed(1) : '0'}%
- Profit Factor: ${s.perf7d?.profitFactor?.toFixed(2) || 'N/A'}
- Max Drawdown: ${s.perf7d?.maxDrawdown?.toFixed(2) || '0'}%

### Current Status:
- Enabled: ${s.enabled}
- Open Positions: ${s.openPositions}
- Pending Signals: ${s.pendingSignals}`
    )
    .join('\n');

  return `You are the Agent Evaluator for an autonomous cryptocurrency trading system.

CURRENT ALLOCATIONS:
- funding_signal: ${currentAllocations.funding_signal}%
- momentum_breakout: ${currentAllocations.momentum_breakout}%
- mean_reversion: ${currentAllocations.mean_reversion}%
- trend_follow: ${currentAllocations.trend_follow}%

STRATEGY PERFORMANCES:
${strategyDetails}

MARKET CONDITIONS:
- BTC Trend: ${marketConditions.btcTrend}
- Volatility: ${marketConditions.volatility}
- Dominant Regime: ${marketConditions.dominantRegime}
- Avg Funding Rate: ${(marketConditions.avgFundingRate * 100).toFixed(4)}%

ACCOUNT CONTEXT:
- Total Equity: $${equity.toFixed(2)}
- Current Drawdown: ${drawdownPct.toFixed(2)}%
- Risk Level (from System Evaluator): ${riskLevel}

EVALUATION RULES:
1. Strategy with 5+ consecutive losses should be DISABLED (requires human approval to re-enable)
2. Total allocations must sum to 100%
3. No strategy can have more than 50% allocation
4. In REDUCED risk mode, prefer lower-risk strategies
5. In MINIMUM risk mode, only keep best-performing strategy at 30% max
6. Weight recent performance (1h, 24h) more than 7d
7. Consider regime fit: momentum/trend work in trends, mean reversion works in ranges

Respond in JSON format:
{
  "strategy_assessments": {
    "funding_signal": {
      "health": "HEALTHY" | "STRUGGLING" | "FAILING",
      "regime_fit": "GOOD" | "NEUTRAL" | "POOR",
      "recommended_allocation": number (0-50),
      "reasoning": string
    },
    "momentum_breakout": { ... },
    "mean_reversion": { ... },
    "trend_follow": { ... }
  },
  "disable_strategies": string[],
  "allocation_rationale": string,
  "market_regime_assessment": string,
  "confidence": number (0.0 to 1.0)
}`;
}

export function buildConflictArbitratorPrompt(
  positions: Position[],
  pendingSignals: { strategy: string; symbol: string; direction: string; strength: number }[],
  proposedAllocations: StrategyAllocation,
  opposingSignals: { symbol: string; strategy1: string; direction1: string; strategy2: string; direction2: string }[],
  disabledWithPositions: { strategy: string; positionCount: number }[],
  riskLevel: string,
  currentLeverage: number,
  maxSafeLeverage: number
): string {
  const allocationSum = Object.values(proposedAllocations).reduce((a, b) => a + b, 0);

  return `You are the Conflict Arbitrator for an autonomous cryptocurrency trading system.

CURRENT OPEN POSITIONS:
${positions.map((p) => `- ${p.symbol} ${p.side} (Strategy: ${p.strategyName}, Size: $${(p.size * p.entryPrice).toFixed(2)}, P&L: ${((p.unrealizedPnl / p.marginUsed) * 100).toFixed(2)}%)`).join('\n') || 'None'}

PENDING SIGNALS (not yet executed):
${pendingSignals.map((s) => `- ${s.strategy}: ${s.symbol} ${s.direction} (Strength: ${s.strength.toFixed(2)})`).join('\n') || 'None'}

PROPOSED ALLOCATIONS (from Agent Evaluator):
- funding_signal: ${proposedAllocations.funding_signal}%
- momentum_breakout: ${proposedAllocations.momentum_breakout}%
- mean_reversion: ${proposedAllocations.mean_reversion}%
- trend_follow: ${proposedAllocations.trend_follow}%

CONFLICT SCENARIOS TO CHECK:

1. OPPOSING SIGNALS: Multiple strategies signaling opposite directions on same asset
   Current conflicts:
   ${opposingSignals.map((c) => `- ${c.symbol}: ${c.strategy1} says ${c.direction1}, ${c.strategy2} says ${c.direction2}`).join('\n') || 'None'}

2. ALLOCATION OVERFLOW: Proposed allocations sum to ${allocationSum}% (must be 100%)

3. POSITION CONFLICTS: Strategy being disabled has open position
   ${disabledWithPositions.map((d) => `- ${d.strategy} has ${d.positionCount} open positions`).join('\n') || 'None'}

4. LEVERAGE OVERFLOW: Combined position leverage would exceed safe limits

RISK CONTEXT:
- Risk Level: ${riskLevel}
- Current Total Leverage: ${currentLeverage.toFixed(1)}x
- Max Safe Leverage: ${maxSafeLeverage}x

Resolve conflicts and respond in JSON format:
{
  "resolved_allocations": {
    "funding_signal": number,
    "momentum_breakout": number,
    "mean_reversion": number,
    "trend_follow": number
  },
  "signal_resolutions": [
    {
      "symbol": string,
      "chosen_direction": "LONG" | "SHORT" | "NONE",
      "chosen_strategy": string,
      "reasoning": string
    }
  ],
  "position_actions": [
    {
      "symbol": string,
      "action": "KEEP" | "CLOSE",
      "reasoning": string
    }
  ],
  "leverage_cap": number,
  "adjustments_made": string[],
  "confidence": number (0.0 to 1.0)
}`;
}
