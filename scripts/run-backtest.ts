import 'dotenv/config';
import { Database } from '../src/data/database';
import { BacktestEngine } from '../src/backtest/engine';
import { FundingSignalStrategy } from '../src/strategies/funding-signal';
import { MomentumBreakoutStrategy } from '../src/strategies/momentum-breakout';
import { MeanReversionStrategy } from '../src/strategies/mean-reversion';
import { TrendFollowStrategy } from '../src/strategies/trend-follow';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('Missing required environment variable: DATABASE_URL');
    process.exit(1);
  }

  const db = new Database(databaseUrl);

  try {
    await db.connect();
    console.log('Connected to database');

    const engine = new BacktestEngine(db, {
      startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days ago
      endDate: new Date(),
      initialCapital: 100,
      commission: 0.0005, // 0.05% taker fee
    });

    // Create strategies
    const strategies = [
      new FundingSignalStrategy(db),
      new MomentumBreakoutStrategy(db),
      new MeanReversionStrategy(db),
      new TrendFollowStrategy(db),
    ];

    console.log('Running individual strategy backtests...\n');

    for (const strategy of strategies) {
      console.log(`Testing ${strategy.name}...`);
      const result = await engine.run([strategy], {
        funding_signal: strategy.name === 'funding_signal' ? 100 : 0,
        momentum_breakout: strategy.name === 'momentum_breakout' ? 100 : 0,
        mean_reversion: strategy.name === 'mean_reversion' ? 100 : 0,
        trend_follow: strategy.name === 'trend_follow' ? 100 : 0,
      });

      console.log(`${strategy.name}:`);
      console.log(`  Total Return: ${result.totalReturnPct.toFixed(2)}%`);
      console.log(`  Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);
      console.log(`  Max Drawdown: ${result.maxDrawdownPct.toFixed(2)}%`);
      console.log(`  Win Rate: ${result.winRate.toFixed(1)}%`);
      console.log(`  Profit Factor: ${result.profitFactor.toFixed(2)}`);
      console.log(`  Total Trades: ${result.totalTrades}`);
      console.log(`  Max Consecutive Losses: ${result.maxConsecutiveLosses}`);
      console.log('');
    }

    // Backtest combined portfolio
    console.log('Running combined portfolio backtest...\n');

    const combinedResult = await engine.run(strategies, {
      funding_signal: 25,
      momentum_breakout: 25,
      mean_reversion: 25,
      trend_follow: 25,
    });

    console.log('Combined Portfolio:');
    console.log(`  Total Return: ${combinedResult.totalReturnPct.toFixed(2)}%`);
    console.log(`  Sharpe Ratio: ${combinedResult.sharpeRatio.toFixed(2)}`);
    console.log(`  Max Drawdown: ${combinedResult.maxDrawdownPct.toFixed(2)}%`);
    console.log(`  Win Rate: ${combinedResult.winRate.toFixed(1)}%`);
    console.log(`  Total Trades: ${combinedResult.totalTrades}`);

    // Validation checks
    console.log('\n--- Validation ---');
    console.log(`Sharpe > 0.5: ${combinedResult.sharpeRatio > 0.5 ? '✅' : '❌'}`);
    console.log(`Max DD < 30%: ${combinedResult.maxDrawdownPct > -30 ? '✅' : '❌'}`);
    console.log(`Max Consec Losses < 7: ${combinedResult.maxConsecutiveLosses < 7 ? '✅' : '❌'}`);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await db.disconnect();
  }
}

main().catch(console.error);
