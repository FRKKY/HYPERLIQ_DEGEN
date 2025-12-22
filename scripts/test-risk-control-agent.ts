/**
 * Local test script for Risk Control Agent
 * Run with: npx ts-node scripts/test-risk-control-agent.ts
 */

import { RiskControlAgent, DEFAULT_RISK_PARAMETERS } from '../src/mcl/risk-control-agent';
import { AccountState, MarketConditions, Position } from '../src/types';

// Mock Database
const mockDb = {
  getRecentTrades: async (limit: number) => {
    // Simulate some recent trades with mixed results
    const now = Date.now();
    return [
      { pnl: -15, executedAt: new Date(now - 1 * 60 * 60 * 1000), strategyName: 'momentum_breakout', symbol: 'BTC' },
      { pnl: -8, executedAt: new Date(now - 2 * 60 * 60 * 1000), strategyName: 'funding_signal', symbol: 'ETH' },
      { pnl: 25, executedAt: new Date(now - 3 * 60 * 60 * 1000), strategyName: 'trend_follow', symbol: 'SOL' },
      { pnl: -5, executedAt: new Date(now - 4 * 60 * 60 * 1000), strategyName: 'mean_reversion', symbol: 'BTC' },
      { pnl: 12, executedAt: new Date(now - 5 * 60 * 60 * 1000), strategyName: 'momentum_breakout', symbol: 'ETH' },
    ];
  },
  getUnacknowledgedAlerts: async () => {
    return [
      {
        alertTime: new Date(),
        alertType: 'DRAWDOWN_WARNING',
        severity: 'WARNING' as const,
        title: 'Drawdown Warning',
        message: 'Drawdown at -8.5%',
        requiresAction: false,
      },
    ];
  },
  getCandles: async (symbol: string, timeframe: string, limit: number) => {
    // Generate mock candle data with some volatility
    const candles = [];
    let price = symbol === 'BTC' ? 42000 : 2200;
    const now = Date.now();
    const interval = timeframe === '1h' ? 60 * 60 * 1000 : 4 * 60 * 60 * 1000;

    for (let i = 0; i < limit; i++) {
      const volatility = 0.02 * (Math.random() - 0.5); // ±1% random move
      const open = price;
      const close = price * (1 + volatility);
      const high = Math.max(open, close) * (1 + Math.random() * 0.005);
      const low = Math.min(open, close) * (1 - Math.random() * 0.005);

      candles.push({
        symbol,
        timeframe,
        openTime: new Date(now - i * interval),
        open,
        high,
        low,
        close,
        volume: Math.random() * 1000000,
      });

      price = close;
    }

    return candles;
  },
};

// Mock Position Tracker
const mockPositionTracker = {
  getAllPositions: (): Position[] => [
    {
      symbol: 'BTC',
      side: 'LONG' as const,
      size: 0.05,
      entryPrice: 41500,
      leverage: 5,
      liquidationPrice: 35000,
      unrealizedPnl: 75,
      marginUsed: 415,
      strategyName: 'trend_follow' as const,
      openedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    },
    {
      symbol: 'ETH',
      side: 'SHORT' as const,
      size: 0.5,
      entryPrice: 2250,
      leverage: 3,
      liquidationPrice: 2800,
      unrealizedPnl: -25,
      marginUsed: 375,
      strategyName: 'mean_reversion' as const,
      openedAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
    },
  ],
};

// Test scenarios
async function runTests() {
  console.log('='.repeat(70));
  console.log('Risk Control Agent Local Test');
  console.log('='.repeat(70));

  // Check if ANTHROPIC_API_KEY is set
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('\n⚠️  ANTHROPIC_API_KEY not set - running in mock mode\n');
    runMockTests();
    return;
  }

  console.log('\n✓ ANTHROPIC_API_KEY found - running live tests\n');

  const agent = new RiskControlAgent(apiKey, mockDb as any, mockPositionTracker as any);

  // Test Scenario 1: Normal conditions
  console.log('\n' + '-'.repeat(70));
  console.log('Scenario 1: NORMAL Risk Level - Moderate market conditions');
  console.log('-'.repeat(70));

  const normalAccountState: AccountState = {
    equity: 950,
    availableBalance: 500,
    totalMarginUsed: 450,
    unrealizedPnl: 50,
    realizedPnl24h: -20,
    peakEquity: 1000,
    drawdownPct: -5,
    positions: mockPositionTracker.getAllPositions(),
  };

  const normalMarketConditions: MarketConditions = {
    btcTrend: 'UP',
    volatility: 'MEDIUM',
    dominantRegime: 'TRENDING',
    avgFundingRate: 0.0001,
  };

  try {
    console.log('\nCalling Risk Control Agent...');
    const result1 = await agent.evaluate(normalAccountState, normalMarketConditions, 'NORMAL');
    printResult('NORMAL', result1);
  } catch (error) {
    console.error('Error in Scenario 1:', error);
  }

  // Test Scenario 2: High volatility / stress conditions
  console.log('\n' + '-'.repeat(70));
  console.log('Scenario 2: REDUCED Risk Level - High volatility, drawdown');
  console.log('-'.repeat(70));

  const stressedAccountState: AccountState = {
    equity: 880,
    availableBalance: 300,
    totalMarginUsed: 580,
    unrealizedPnl: -50,
    realizedPnl24h: -70,
    peakEquity: 1000,
    drawdownPct: -12,
    positions: mockPositionTracker.getAllPositions(),
  };

  const stressedMarketConditions: MarketConditions = {
    btcTrend: 'STRONG_DOWN',
    volatility: 'HIGH',
    dominantRegime: 'VOLATILE',
    avgFundingRate: -0.0005,
  };

  try {
    console.log('\nCalling Risk Control Agent...');
    const result2 = await agent.evaluate(stressedAccountState, stressedMarketConditions, 'REDUCED');
    printResult('REDUCED', result2);
  } catch (error) {
    console.error('Error in Scenario 2:', error);
  }

  // Test Scenario 3: Critical conditions
  console.log('\n' + '-'.repeat(70));
  console.log('Scenario 3: MINIMUM Risk Level - Critical drawdown, extreme vol');
  console.log('-'.repeat(70));

  const criticalAccountState: AccountState = {
    equity: 820,
    availableBalance: 150,
    totalMarginUsed: 670,
    unrealizedPnl: -100,
    realizedPnl24h: -130,
    peakEquity: 1000,
    drawdownPct: -18,
    positions: mockPositionTracker.getAllPositions(),
  };

  const criticalMarketConditions: MarketConditions = {
    btcTrend: 'STRONG_DOWN',
    volatility: 'EXTREME',
    dominantRegime: 'VOLATILE',
    avgFundingRate: -0.001,
  };

  try {
    console.log('\nCalling Risk Control Agent...');
    const result3 = await agent.evaluate(criticalAccountState, criticalMarketConditions, 'MINIMUM');
    printResult('MINIMUM', result3);
  } catch (error) {
    console.error('Error in Scenario 3:', error);
  }

  // Test parameter application
  console.log('\n' + '-'.repeat(70));
  console.log('Testing Parameter Management');
  console.log('-'.repeat(70));

  console.log('\nCurrent parameters:');
  const currentParams = agent.getCurrentParameters();
  console.log(`  Drawdown Warning: ${currentParams.drawdownWarning}%`);
  console.log(`  Drawdown Critical: ${currentParams.drawdownCritical}%`);
  console.log(`  Drawdown Pause: ${currentParams.drawdownPause}%`);
  console.log(`  Max Leverage Normal: ${currentParams.maxLeverageNormal}x`);
  console.log(`  Position Size Scalar: ${currentParams.positionSizeScalar}`);
  console.log(`  Updated By: ${currentParams.updatedBy}`);

  console.log('\nResetting to defaults...');
  agent.resetToDefaults();
  const defaultParams = agent.getCurrentParameters();
  console.log(`  Drawdown Warning: ${defaultParams.drawdownWarning}% (should be -10)`);
  console.log(`  Updated By: ${defaultParams.updatedBy} (should be DEFAULT)`);

  console.log('\n' + '='.repeat(70));
  console.log('Tests Complete');
  console.log('='.repeat(70));
}

function runMockTests() {
  console.log('Running validation and safety constraint tests without API...\n');

  // Test DEFAULT_RISK_PARAMETERS
  console.log('Default Risk Parameters:');
  console.log(`  Drawdown Warning: ${DEFAULT_RISK_PARAMETERS.drawdownWarning}%`);
  console.log(`  Drawdown Critical: ${DEFAULT_RISK_PARAMETERS.drawdownCritical}%`);
  console.log(`  Drawdown Pause: ${DEFAULT_RISK_PARAMETERS.drawdownPause}%`);
  console.log(`  Daily Loss Pause: ${DEFAULT_RISK_PARAMETERS.dailyLossPause}%`);
  console.log(`  Max Leverage Normal: ${DEFAULT_RISK_PARAMETERS.maxLeverageNormal}x`);
  console.log(`  Max Leverage Reduced: ${DEFAULT_RISK_PARAMETERS.maxLeverageReduced}x`);
  console.log(`  Max Leverage Minimum: ${DEFAULT_RISK_PARAMETERS.maxLeverageMinimum}x`);
  console.log(`  Max Total Exposure: ${(DEFAULT_RISK_PARAMETERS.maxTotalExposure * 100).toFixed(0)}%`);
  console.log(`  Position Size Scalar: ${DEFAULT_RISK_PARAMETERS.positionSizeScalar}`);

  // Verify manifesto compliance
  console.log('\n✓ Verifying manifesto compliance:');
  const checks = [
    { name: 'Drawdown Warning = -10%', pass: DEFAULT_RISK_PARAMETERS.drawdownWarning === -10 },
    { name: 'Drawdown Critical = -15%', pass: DEFAULT_RISK_PARAMETERS.drawdownCritical === -15 },
    { name: 'Drawdown Pause = -20%', pass: DEFAULT_RISK_PARAMETERS.drawdownPause === -20 },
    { name: 'Daily Loss Pause = -15%', pass: DEFAULT_RISK_PARAMETERS.dailyLossPause === -15 },
    { name: 'Max Leverage Normal = 10x', pass: DEFAULT_RISK_PARAMETERS.maxLeverageNormal === 10 },
    { name: 'Max Exposure = 80%', pass: DEFAULT_RISK_PARAMETERS.maxTotalExposure === 0.8 },
  ];

  checks.forEach(check => {
    console.log(`  ${check.pass ? '✓' : '✗'} ${check.name}`);
  });

  const allPassed = checks.every(c => c.pass);
  console.log(`\n${allPassed ? '✓ All checks passed!' : '✗ Some checks failed'}`);
}

function printResult(scenario: string, result: any) {
  console.log(`\n📊 Results for ${scenario}:`);
  console.log(`\n  Risk Assessment:`);
  console.log(`    Risk Score: ${result.current_risk_score}/100`);
  console.log(`    Risk Trend: ${result.risk_trend}`);
  console.log(`    Market Stress: ${result.market_stress_level}`);
  console.log(`    Confidence: ${(result.confidence * 100).toFixed(0)}%`);

  console.log(`\n  Dynamic Thresholds:`);
  console.log(`    Drawdown Warning: ${result.risk_thresholds.drawdown_warning}%`);
  console.log(`    Drawdown Critical: ${result.risk_thresholds.drawdown_critical}%`);
  console.log(`    Drawdown Pause: ${result.risk_thresholds.drawdown_pause}%`);
  console.log(`    Daily Loss Pause: ${result.risk_thresholds.daily_loss_pause}%`);

  console.log(`\n  Leverage Caps:`);
  console.log(`    Normal: ${result.leverage_caps.normal}x`);
  console.log(`    Reduced: ${result.leverage_caps.reduced}x`);
  console.log(`    Minimum: ${result.leverage_caps.minimum}x`);

  console.log(`\n  Exposure Limits:`);
  console.log(`    Max Total: ${(result.exposure_limits.max_total_exposure * 100).toFixed(0)}%`);
  console.log(`    Max Single Position: ${(result.exposure_limits.max_single_position * 100).toFixed(0)}%`);

  console.log(`\n  Volatility Adjustments:`);
  console.log(`    Position Size Scalar: ${result.volatility_adjustments.position_size_scalar}`);
  console.log(`    Hold Time Reduction: ${result.volatility_adjustments.hold_time_reduction}`);
  console.log(`    Tighten Stops: ${result.volatility_adjustments.tighten_stops}`);

  if (result.immediate_actions.length > 0) {
    console.log(`\n  ⚠️  Immediate Actions (${result.immediate_actions.length}):`);
    result.immediate_actions.forEach((action: any, i: number) => {
      console.log(`    ${i + 1}. ${action.action_type}${action.target ? ` [${action.target}]` : ''}`);
      console.log(`       Reason: ${action.reason}`);
    });
  } else {
    console.log(`\n  ✓ No immediate actions required`);
  }

  console.log(`\n  Reasoning:`);
  const reasoningLines = result.reasoning.match(/.{1,65}(\s|$)/g) || [result.reasoning];
  reasoningLines.forEach((line: string) => console.log(`    ${line.trim()}`));
}

// Run tests
runTests().catch(console.error);
