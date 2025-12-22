#!/usr/bin/env ts-node
/**
 * Optimal Historical Data Extraction CLI
 *
 * Usage:
 *   npx ts-node scripts/run-optimal-extraction.ts [options]
 *
 * Options:
 *   --symbols=BTC,ETH,SOL   Specific symbols to fetch (default: all)
 *   --timeframes=1h,4h,1d   Timeframes to fetch (default: all)
 *   --concurrency=5         Number of parallel workers (default: 5)
 *   --funding-months=12     Months of funding history (default: 12)
 *   --no-incremental        Fetch all data, ignore existing
 *   --use-s3                Enable S3 bulk download (requires LZ4)
 *   --s3-days=30            Days of S3 data to fetch (default: 30)
 *   --coverage              Show data coverage report and exit
 *   --dry-run               Show what would be fetched without fetching
 *   --help                  Show this help message
 *
 * Environment Variables:
 *   HL_PRIVATE_KEY          Hyperliquid private key
 *   DATABASE_URL            PostgreSQL connection string
 *   USE_TESTNET=true        Use testnet API (default: mainnet)
 */

import 'dotenv/config';
import { HyperliquidAuth, HyperliquidRestClient } from '../src/hyperliquid';
import { Database } from '../src/data/database';
import { OptimalExtractor, ExtractionConfig, ExtractionProgress } from '../src/data/optimal-extractor';
import { Timeframe } from '../src/types';

// Parse command line arguments
function parseArgs(): {
  symbols?: string[];
  timeframes?: Timeframe[];
  concurrency: number;
  fundingMonths: number;
  incremental: boolean;
  useS3: boolean;
  s3Days: number;
  coverage: boolean;
  dryRun: boolean;
  help: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    symbols: undefined as string[] | undefined,
    timeframes: undefined as Timeframe[] | undefined,
    concurrency: 5,
    fundingMonths: 12,
    incremental: true,
    useS3: false,
    s3Days: 30,
    coverage: false,
    dryRun: false,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--coverage') {
      result.coverage = true;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--no-incremental') {
      result.incremental = false;
    } else if (arg === '--use-s3') {
      result.useS3 = true;
    } else if (arg.startsWith('--symbols=')) {
      result.symbols = arg.split('=')[1].split(',').map((s) => s.trim().toUpperCase());
    } else if (arg.startsWith('--timeframes=')) {
      result.timeframes = arg.split('=')[1].split(',').map((s) => s.trim()) as Timeframe[];
    } else if (arg.startsWith('--concurrency=')) {
      result.concurrency = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--funding-months=')) {
      result.fundingMonths = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--s3-days=')) {
      result.s3Days = parseInt(arg.split('=')[1], 10);
    }
  }

  return result;
}

function showHelp(): void {
  console.log(`
Optimal Historical Data Extraction CLI
======================================

Extracts historical data from Hyperliquid with intelligent rate limiting,
parallel fetching, and priority-based symbol ordering.

Usage:
  npx ts-node scripts/run-optimal-extraction.ts [options]

Options:
  --symbols=BTC,ETH,SOL   Specific symbols to fetch (default: all ~200 symbols)
  --timeframes=1h,4h,1d   Timeframes to fetch (default: 1m,5m,15m,1h,4h,1d)
  --concurrency=5         Number of parallel API workers (default: 5)
  --funding-months=12     Months of funding history to fetch (default: 12)
  --no-incremental        Fetch all data, ignoring existing records
  --use-s3                Enable S3 bulk download for deep history
  --s3-days=30            Days of S3 data to fetch (default: 30)
  --coverage              Show current data coverage and exit
  --dry-run               Show extraction plan without executing
  --help                  Show this help message

Environment Variables:
  HL_PRIVATE_KEY          Hyperliquid private key (required)
  DATABASE_URL            PostgreSQL connection string (required)
  USE_TESTNET=true        Use testnet API instead of mainnet

Examples:
  # Fetch all data for top 10 symbols
  npx ts-node scripts/run-optimal-extraction.ts --symbols=BTC,ETH,SOL,DOGE,AVAX,LINK,ARB,OP,SUI,APT

  # Fetch only 1h and 4h candles
  npx ts-node scripts/run-optimal-extraction.ts --timeframes=1h,4h

  # Full re-fetch (ignore existing data)
  npx ts-node scripts/run-optimal-extraction.ts --no-incremental

  # Show current data coverage
  npx ts-node scripts/run-optimal-extraction.ts --coverage

Data Limits (Hyperliquid API):
  - Candles: 5,000 most recent per symbol/timeframe
  - Funding: Unlimited (paginated)
  - Rate limit: 1,200 weight/minute

Time Coverage per Timeframe (5000 candles):
  - 1m  →  ~3.5 days
  - 5m  →  ~17 days
  - 15m →  ~52 days
  - 1h  →  ~208 days (~7 months)
  - 4h  →  ~833 days (~2.3 years)
  - 1d  →  ~13.7 years
  `);
}

function formatProgress(progress: ExtractionProgress): string {
  const elapsed = progress.timing.elapsedSeconds;
  const eta = progress.timing.estimatedRemainingSeconds;

  const elapsedStr = formatDuration(elapsed);
  const etaStr = eta > 0 ? formatDuration(eta) : '--';

  const bar = createProgressBar(progress.overallProgress, 30);

  return [
    `\r${bar} ${progress.overallProgress.toFixed(1)}%`,
    `Phase: ${progress.currentPhase.name}`,
    `${progress.currentPhase.details}`,
    `Elapsed: ${elapsedStr} | ETA: ${etaStr}`,
    `Records: ${(progress.stats.candlesCollected + progress.stats.fundingRatesCollected).toLocaleString()}`,
  ].join(' | ');
}

function createProgressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

async function showCoverage(extractor: OptimalExtractor): Promise<void> {
  console.log('\nFetching data coverage report...\n');

  const report = await extractor.getDataCoverage();

  console.log('='.repeat(70));
  console.log('DATA COVERAGE REPORT');
  console.log('='.repeat(70));

  console.log('\nCANDLES:');
  console.log(`  Total records: ${report.candles.totalRecords.toLocaleString()}`);
  console.log(`  Symbols: ${report.candles.symbolCount}`);
  if (report.candles.oldestRecord) {
    console.log(`  Date range: ${report.candles.oldestRecord.toISOString().slice(0, 10)} to ${report.candles.newestRecord?.toISOString().slice(0, 10)}`);
  }
  console.log('  By timeframe:');
  for (const [tf, count] of Object.entries(report.candles.byTimeframe)) {
    console.log(`    ${tf}: ${count.toLocaleString()}`);
  }

  console.log('\nFUNDING RATES:');
  console.log(`  Total records: ${report.funding.totalRecords.toLocaleString()}`);
  console.log(`  Symbols: ${report.funding.symbolCount}`);
  if (report.funding.oldestRecord) {
    console.log(`  Date range: ${report.funding.oldestRecord.toISOString().slice(0, 10)} to ${report.funding.newestRecord?.toISOString().slice(0, 10)}`);
  }

  console.log('\nOPEN INTEREST:');
  console.log(`  Total records: ${report.openInterest.totalRecords.toLocaleString()}`);
  console.log(`  Symbols: ${report.openInterest.symbolCount}`);
  if (report.openInterest.oldestRecord) {
    console.log(`  Date range: ${report.openInterest.oldestRecord.toISOString().slice(0, 10)} to ${report.openInterest.newestRecord?.toISOString().slice(0, 10)}`);
  }

  console.log('\n' + '='.repeat(70));
}

async function showDryRun(
  client: HyperliquidRestClient,
  config: Partial<ExtractionConfig>
): Promise<void> {
  console.log('\nDRY RUN - Extraction Plan\n');

  await client.initialize();
  const meta = await client.getMeta();
  const allSymbols = meta.universe.map((u) => u.name);
  const targetSymbols = config.symbols || allSymbols;
  const timeframes = config.timeframes || ['1d', '4h', '1h', '15m', '5m', '1m'];

  console.log('='.repeat(70));
  console.log('EXTRACTION PLAN');
  console.log('='.repeat(70));

  console.log(`\nSymbols: ${targetSymbols.length}`);
  if (targetSymbols.length <= 20) {
    console.log(`  ${targetSymbols.join(', ')}`);
  } else {
    console.log(`  ${targetSymbols.slice(0, 10).join(', ')} ... and ${targetSymbols.length - 10} more`);
  }

  console.log(`\nTimeframes: ${timeframes.join(', ')}`);

  const totalCandleTasks = targetSymbols.length * timeframes.length;
  const totalFundingTasks = targetSymbols.length;
  const totalTasks = totalCandleTasks + totalFundingTasks;

  console.log(`\nTasks:`);
  console.log(`  Candle tasks: ${totalCandleTasks} (${targetSymbols.length} symbols × ${timeframes.length} timeframes)`);
  console.log(`  Funding tasks: ${totalFundingTasks}`);
  console.log(`  Total tasks: ${totalTasks}`);

  // Estimate time
  const concurrency = config.apiConcurrency || 5;
  const avgWeightPerTask = 100; // Rough estimate
  const maxWeightPerMinute = 1200 * 0.85; // 85% safety margin
  const tasksPerMinute = maxWeightPerMinute / avgWeightPerTask;
  const estimatedMinutes = totalTasks / tasksPerMinute;

  console.log(`\nEstimated time: ${formatDuration(estimatedMinutes * 60)}`);
  console.log(`  Concurrency: ${concurrency} workers`);
  console.log(`  Rate limit budget: ${maxWeightPerMinute.toFixed(0)} weight/min`);

  // Estimate data volume
  const maxCandlesPerTask = 5000;
  const maxFundingPerTask = 500 * 12; // 12 months, 500 per page
  const estimatedCandles = totalCandleTasks * maxCandlesPerTask;
  const estimatedFunding = totalFundingTasks * maxFundingPerTask;

  console.log(`\nEstimated data volume (maximum):`);
  console.log(`  Candles: up to ${estimatedCandles.toLocaleString()} records`);
  console.log(`  Funding: up to ${estimatedFunding.toLocaleString()} records`);

  console.log('\n' + '='.repeat(70));
  console.log('Run without --dry-run to execute extraction');
  console.log('='.repeat(70) + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Validate environment
  const privateKey = process.env.HL_PRIVATE_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  const useTestnet = process.env.USE_TESTNET === 'true';

  // For dry-run, we only need to call public API endpoints (getMeta)
  // Use a dummy key if not provided or if placeholder value
  const isDryRunOnly = args.dryRun && !args.coverage;
  const isValidPrivateKey = privateKey && !privateKey.includes('REPLACE') && privateKey.startsWith('0x');
  const effectivePrivateKey = isValidPrivateKey
    ? privateKey
    : (isDryRunOnly
        ? '0x0000000000000000000000000000000000000000000000000000000000000001'
        : null);

  if (!effectivePrivateKey) {
    console.error('Error: HL_PRIVATE_KEY environment variable is required');
    process.exit(1);
  }

  if (!databaseUrl && !isDryRunOnly) {
    console.error('Error: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  // Initialize clients
  const auth = new HyperliquidAuth(effectivePrivateKey, useTestnet);
  const client = new HyperliquidRestClient(auth, useTestnet);
  const db = databaseUrl ? new Database(databaseUrl) : null;

  console.log(`\nHyperliquid Optimal Data Extraction`);
  console.log(`Network: ${useTestnet ? 'TESTNET' : 'MAINNET'}`);
  console.log(`Mode: ${args.incremental ? 'Incremental' : 'Full'}${isDryRunOnly ? ' (dry-run)' : ''}`);

  try {
    // Build config
    const config: Partial<ExtractionConfig> = {
      symbols: args.symbols,
      timeframes: args.timeframes,
      apiConcurrency: args.concurrency,
      fundingHistoryMonths: args.fundingMonths,
      incrementalMode: args.incremental,
      useS3: args.useS3,
    };

    if (args.useS3) {
      config.s3EndDate = new Date();
      config.s3StartDate = new Date(Date.now() - args.s3Days * 24 * 60 * 60 * 1000);
    }

    // Dry run - just show plan (no database needed)
    if (args.dryRun) {
      await showDryRun(client, config);
      process.exit(0);
    }

    // For actual extraction, connect to database
    if (!db) {
      console.error('Error: DATABASE_URL is required for extraction');
      process.exit(1);
    }

    await db.connect();
    console.log('Database connected\n');

    // Create extractor
    const extractor = new OptimalExtractor(client, db, {
      ...config,
      onProgress: (progress) => {
        process.stdout.write('\r' + ' '.repeat(120) + '\r'); // Clear line
        process.stdout.write(formatProgress(progress));
      },
    });

    // Coverage report
    if (args.coverage) {
      await client.initialize();
      await showCoverage(extractor);
      await db.disconnect();
      process.exit(0);
    }

    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
      console.log('\n\nAborting extraction...');
      extractor.abort();
    });

    // Run extraction
    console.log('Starting extraction...\n');
    const startTime = Date.now();

    await extractor.extract();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\nExtraction completed in ${formatDuration(duration)}`);

    // Show final coverage
    await showCoverage(extractor);

  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    if (db) {
      await db.disconnect();
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
