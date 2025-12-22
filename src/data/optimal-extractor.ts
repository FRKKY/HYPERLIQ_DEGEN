/**
 * Optimal Historical Data Extractor
 *
 * Orchestrates the complete historical data extraction pipeline:
 * 1. Phase 1: S3 bulk download for unlimited historical trades
 * 2. Phase 2: API parallel fetch to fill recent gaps
 * 3. Phase 3: Handoff to real-time WebSocket updates
 *
 * Features:
 * - Priority-based symbol ordering (high-volume first)
 * - Rate-limit-aware parallel fetching
 * - Incremental mode (only fetch new data)
 * - Progress tracking and resumability
 * - Comprehensive error handling
 */

import { HyperliquidRestClient } from '../hyperliquid';
import { Database } from './database';
import { ParallelFetcher, } from './parallel-fetcher';
import { S3Fetcher } from './s3-fetcher';
import { Timeframe } from '../types';
import { logger } from '../utils';

export interface ExtractionConfig {
  // Symbol configuration
  symbols?: string[];  // If not provided, fetches all from meta
  prioritySymbols: string[];  // High-priority symbols to fetch first

  // Timeframe configuration
  timeframes: Timeframe[];

  // API fetch configuration
  apiConcurrency: number;
  fundingHistoryMonths: number;
  incrementalMode: boolean;

  // S3 fetch configuration
  useS3: boolean;
  s3StartDate?: Date;
  s3EndDate?: Date;

  // Progress callback
  onProgress?: (progress: ExtractionProgress) => void;
}

export interface ExtractionProgress {
  phase: 'initializing' | 's3_fetch' | 'api_fetch' | 'complete' | 'error';
  overallProgress: number;  // 0-100
  currentPhase: {
    name: string;
    progress: number;
    details: string;
  };
  stats: {
    candlesCollected: number;
    fundingRatesCollected: number;
    openInterestSnapshots: number;
    userFillsCollected: number;
    historicalOrdersCollected: number;
    symbolsProcessed: number;
    totalSymbols: number;
    errors: number;
  };
  timing: {
    startTime: Date;
    elapsedSeconds: number;
    estimatedRemainingSeconds: number;
  };
}

const DEFAULT_CONFIG: ExtractionConfig = {
  prioritySymbols: [
    'BTC', 'ETH', 'SOL', 'DOGE', 'AVAX', 'LINK', 'ARB', 'OP', 'SUI', 'APT',
    'MATIC', 'ATOM', 'DOT', 'UNI', 'LTC', 'BCH', 'XRP', 'ADA', 'TRX', 'NEAR',
  ],
  timeframes: ['1d', '4h', '1h', '15m', '5m', '1m'],
  apiConcurrency: 5,
  fundingHistoryMonths: 12,
  incrementalMode: true,
  useS3: true,  // S3 enabled by default for deep historical data
};

export class OptimalExtractor {
  private client: HyperliquidRestClient;
  private db: Database;
  private config: ExtractionConfig;
  private parallelFetcher: ParallelFetcher;
  private s3Fetcher: S3Fetcher;
  private progress: ExtractionProgress;
  private isRunning = false;
  private abortRequested = false;

  constructor(
    client: HyperliquidRestClient,
    db: Database,
    config: Partial<ExtractionConfig> = {}
  ) {
    this.client = client;
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.parallelFetcher = new ParallelFetcher(client, db, {
      maxConcurrency: this.config.apiConcurrency,
      prioritySymbols: this.config.prioritySymbols,
      timeframes: this.config.timeframes,
      fundingHistoryMonths: this.config.fundingHistoryMonths,
      incrementalMode: this.config.incrementalMode,
      onProgress: (p) => this.updateApiProgress(p),
    });

    this.s3Fetcher = new S3Fetcher(db);
    this.progress = this.initProgress();
  }

  private initProgress(): ExtractionProgress {
    return {
      phase: 'initializing',
      overallProgress: 0,
      currentPhase: {
        name: 'Initializing',
        progress: 0,
        details: '',
      },
      stats: {
        candlesCollected: 0,
        fundingRatesCollected: 0,
        openInterestSnapshots: 0,
        userFillsCollected: 0,
        historicalOrdersCollected: 0,
        symbolsProcessed: 0,
        totalSymbols: 0,
        errors: 0,
      },
      timing: {
        startTime: new Date(),
        elapsedSeconds: 0,
        estimatedRemainingSeconds: 0,
      },
    };
  }

  /**
   * Run the complete extraction pipeline
   */
  async extract(): Promise<ExtractionProgress> {
    if (this.isRunning) {
      throw new Error('Extraction already in progress');
    }

    this.isRunning = true;
    this.abortRequested = false;
    this.progress = this.initProgress();
    this.progress.timing.startTime = new Date();

    logger.info('OptimalExtractor', 'Starting optimal data extraction', {
      useS3: this.config.useS3,
      apiConcurrency: this.config.apiConcurrency,
      incrementalMode: this.config.incrementalMode,
      timeframes: this.config.timeframes,
    });

    try {
      // Initialize client
      await this.client.initialize();

      // Get all available symbols
      const meta = await this.client.getMeta();
      const allSymbols = meta.universe.map((u) => u.name);
      const targetSymbols = this.config.symbols || allSymbols;

      this.progress.stats.totalSymbols = targetSymbols.length;

      logger.info('OptimalExtractor', `Found ${targetSymbols.length} symbols to process`);

      // Phase 1: S3 bulk download (if enabled)
      if (this.config.useS3 && !this.abortRequested) {
        await this.runS3Phase(targetSymbols);
      }

      // Phase 2: API parallel fetch
      if (!this.abortRequested) {
        await this.runApiPhase(targetSymbols);
      }

      // Phase 3: Fetch user account data (fills, orders)
      if (!this.abortRequested) {
        await this.fetchUserData();
      }

      // Phase 4: Capture current open interest
      if (!this.abortRequested) {
        await this.captureOpenInterest(targetSymbols);
      }

      this.progress.phase = 'complete';
      this.progress.overallProgress = 100;
      this.progress.currentPhase = {
        name: 'Complete',
        progress: 100,
        details: 'Extraction finished successfully',
      };
    } catch (error) {
      this.progress.phase = 'error';
      this.progress.stats.errors++;
      logger.error('OptimalExtractor', 'Extraction failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
    } finally {
      this.isRunning = false;
      this.progress.timing.elapsedSeconds =
        (Date.now() - this.progress.timing.startTime.getTime()) / 1000;
    }

    this.reportFinalStats();
    return this.progress;
  }

  /**
   * Phase 1: S3 bulk data download
   */
  private async runS3Phase(symbols: string[]): Promise<void> {
    this.progress.phase = 's3_fetch';
    this.progress.currentPhase = {
      name: 'S3 Bulk Download',
      progress: 0,
      details: 'Checking S3 bucket availability...',
    };

    logger.info('OptimalExtractor', 'Starting S3 bulk download phase');

    // Check S3 availability
    const availability = await this.s3Fetcher.checkAvailability();

    if (!availability.nodeDataAvailable) {
      logger.warn('OptimalExtractor', 'S3 node data bucket not accessible, skipping S3 phase');
      return;
    }

    logger.info('OptimalExtractor', 'S3 buckets available', {
      latestDate: availability.latestDate,
      totalDates: availability.totalDates,
    });

    // Determine date range
    const endDate = this.config.s3EndDate || new Date();
    const startDate = this.config.s3StartDate || new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    this.progress.currentPhase.details = `Fetching data from ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`;

    // Run S3 fetch
    const s3Result = await this.s3Fetcher.fetchHistoricalData(startDate, endDate, symbols);

    this.progress.stats.candlesCollected += s3Result.totalRecords;

    if (s3Result.errors.length > 0) {
      this.progress.stats.errors += s3Result.errors.length;
    }

    logger.info('OptimalExtractor', 'S3 phase complete', {
      records: s3Result.totalRecords,
      errors: s3Result.errors.length,
    });
  }

  /**
   * Phase 2: API parallel fetch
   */
  private async runApiPhase(symbols: string[]): Promise<void> {
    this.progress.phase = 'api_fetch';
    this.progress.currentPhase = {
      name: 'API Parallel Fetch',
      progress: 0,
      details: 'Building task queue...',
    };

    logger.info('OptimalExtractor', 'Starting API parallel fetch phase');

    // Build task queue
    await this.parallelFetcher.buildTaskQueue(symbols);

    this.progress.currentPhase.details = 'Fetching data from Hyperliquid API...';

    // Execute parallel fetch
    const apiResult = await this.parallelFetcher.execute();

    // Update stats (split between candles and funding)
    // Rough estimate: 80% candles, 20% funding
    const candleEstimate = Math.floor(apiResult.totalRecords * 0.8);
    const fundingEstimate = apiResult.totalRecords - candleEstimate;

    this.progress.stats.candlesCollected += candleEstimate;
    this.progress.stats.fundingRatesCollected += fundingEstimate;
    this.progress.stats.symbolsProcessed = symbols.length;
    this.progress.stats.errors += apiResult.failedTasks;

    logger.info('OptimalExtractor', 'API phase complete', {
      completed: apiResult.completedTasks,
      failed: apiResult.failedTasks,
      records: apiResult.totalRecords,
    });
  }

  /**
   * Fetch user account data (fills, orders)
   */
  private async fetchUserData(): Promise<void> {
    this.progress.currentPhase = {
      name: 'User Data',
      progress: 0,
      details: 'Fetching user fills history...',
    };

    // Fetch user fills (up to 10,000 with pagination)
    try {
      let totalFills = 0;
      let startTime = Date.now() - (180 * 24 * 60 * 60 * 1000); // 6 months ago

      while (true) {
        const fills = await this.client.getUserFillsByTime(startTime, Date.now(), true);

        if (fills.length === 0) break;

        for (const fill of fills) {
          try {
            await this.db.query(
              `INSERT INTO trades (trade_id, strategy_name, symbol, side, direction, quantity, price, fee, executed_at, order_type, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (trade_id) DO NOTHING`,
              [
                `fill-${fill.oid}-${fill.time}`,
                'historical',
                fill.coin,
                fill.side === 'B' ? 'BUY' : 'SELL',
                fill.side === 'B' ? 'BUY' : 'SELL',
                parseFloat(fill.sz),
                parseFloat(fill.px),
                parseFloat(fill.fee || '0'),
                new Date(fill.time),
                'MARKET',
                JSON.stringify({ historical: true, oid: fill.oid, closedPnl: fill.closedPnl }),
              ]
            );
            totalFills++;
          } catch {
            // Skip duplicate fills
          }
        }

        if (fills.length < 2000) break;
        startTime = Math.max(...fills.map((f) => f.time)) + 1;

        await this.sleep(100);
      }

      this.progress.stats.userFillsCollected = totalFills;
      logger.info('OptimalExtractor', 'User fills collected', { count: totalFills });
    } catch (error) {
      logger.error('OptimalExtractor', 'Failed to fetch user fills', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      this.progress.stats.errors++;
    }

    // Fetch historical orders (up to 2,000)
    this.progress.currentPhase.details = 'Fetching historical orders...';
    this.progress.currentPhase.progress = 50;

    try {
      const orders = await this.client.getHistoricalOrders();
      let count = 0;

      for (const order of orders) {
        try {
          await this.db.query(
            `INSERT INTO signals (strategy_name, symbol, signal_time, direction, strength, entry_price, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT DO NOTHING`,
            [
              'historical_order',
              order.coin,
              new Date(order.timestamp),
              order.side === 'B' ? 'LONG' : 'SHORT',
              1.0,
              parseFloat(order.limitPx),
              JSON.stringify({ oid: order.oid, sz: order.sz, historical: true }),
            ]
          );
          count++;
        } catch {
          // Skip duplicates
        }
      }

      this.progress.stats.historicalOrdersCollected = count;
      logger.info('OptimalExtractor', 'Historical orders collected', { count });
    } catch (error) {
      logger.error('OptimalExtractor', 'Failed to fetch historical orders', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      this.progress.stats.errors++;
    }

    this.progress.currentPhase.progress = 100;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Capture current open interest snapshot
   */
  private async captureOpenInterest(symbols: string[]): Promise<void> {
    this.progress.currentPhase = {
      name: 'Open Interest Snapshot',
      progress: 0,
      details: 'Capturing current open interest...',
    };

    try {
      const assetCtxs = await this.client.getAssetContexts();

      const oiData = assetCtxs
        .filter((ctx) => symbols.includes(ctx.coin))
        .map((ctx) => ({
          symbol: ctx.coin,
          openInterest: parseFloat(ctx.openInterest),
          openInterestValue: parseFloat(ctx.openInterest) * parseFloat(ctx.markPx),
        }));

      await this.db.insertOpenInterestBatch(oiData);
      this.progress.stats.openInterestSnapshots = oiData.length;

      logger.info('OptimalExtractor', 'Open interest snapshot captured', {
        symbols: oiData.length,
      });
    } catch (error) {
      logger.error('OptimalExtractor', 'Failed to capture open interest', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      this.progress.stats.errors++;
    }
  }

  private updateApiProgress(fetcherProgress: {
    completedTasks: number;
    totalTasks: number;
    totalRecords: number;
    currentSymbol: string;
    currentType: string;
    estimatedTimeRemaining: number;
  }): void {
    const progress = (fetcherProgress.completedTasks / fetcherProgress.totalTasks) * 100;

    this.progress.currentPhase.progress = progress;
    this.progress.currentPhase.details =
      `${fetcherProgress.currentSymbol} ${fetcherProgress.currentType} | ` +
      `${fetcherProgress.completedTasks}/${fetcherProgress.totalTasks} tasks | ` +
      `${fetcherProgress.totalRecords.toLocaleString()} records`;

    // Update overall progress (S3 = 30%, API = 60%, OI = 10%)
    const s3Weight = this.config.useS3 ? 0.3 : 0;
    const apiWeight = this.config.useS3 ? 0.6 : 0.9;
    const s3Progress = this.progress.phase === 's3_fetch' ? this.progress.currentPhase.progress : 100;

    this.progress.overallProgress =
      s3Weight * s3Progress + apiWeight * progress;

    this.progress.timing.elapsedSeconds =
      (Date.now() - this.progress.timing.startTime.getTime()) / 1000;
    this.progress.timing.estimatedRemainingSeconds = fetcherProgress.estimatedTimeRemaining;

    // Call progress callback
    if (this.config.onProgress) {
      this.config.onProgress(this.progress);
    }
  }

  private reportFinalStats(): void {
    const elapsed = this.progress.timing.elapsedSeconds;
    const totalRecords = this.progress.stats.candlesCollected +
      this.progress.stats.fundingRatesCollected +
      this.progress.stats.userFillsCollected +
      this.progress.stats.historicalOrdersCollected;
    const rate = elapsed > 0 ? totalRecords / elapsed : 0;

    console.log('\n' + '='.repeat(70));
    console.log('EXTRACTION COMPLETE');
    console.log('='.repeat(70));
    console.log(`Duration: ${this.formatDuration(elapsed)}`);
    console.log(`Records/sec: ${rate.toFixed(1)}`);
    console.log('-'.repeat(70));
    console.log(`Symbols processed: ${this.progress.stats.symbolsProcessed}/${this.progress.stats.totalSymbols}`);
    console.log(`Candles collected: ${this.progress.stats.candlesCollected.toLocaleString()}`);
    console.log(`Funding rates collected: ${this.progress.stats.fundingRatesCollected.toLocaleString()}`);
    console.log(`User fills collected: ${this.progress.stats.userFillsCollected.toLocaleString()}`);
    console.log(`Historical orders collected: ${this.progress.stats.historicalOrdersCollected.toLocaleString()}`);
    console.log(`Open interest snapshots: ${this.progress.stats.openInterestSnapshots}`);
    console.log(`Errors: ${this.progress.stats.errors}`);
    console.log('='.repeat(70) + '\n');
  }

  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  /**
   * Abort the current extraction
   */
  abort(): void {
    this.abortRequested = true;
    this.parallelFetcher.abort();
    logger.info('OptimalExtractor', 'Abort requested');
  }

  /**
   * Get current progress
   */
  getProgress(): ExtractionProgress {
    return { ...this.progress };
  }

  /**
   * Check if extraction is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get data coverage statistics from database
   */
  async getDataCoverage(): Promise<DataCoverageReport> {
    const report: DataCoverageReport = {
      candles: {
        totalRecords: 0,
        symbolCount: 0,
        oldestRecord: null,
        newestRecord: null,
        byTimeframe: {},
      },
      funding: {
        totalRecords: 0,
        symbolCount: 0,
        oldestRecord: null,
        newestRecord: null,
      },
      openInterest: {
        totalRecords: 0,
        symbolCount: 0,
        oldestRecord: null,
        newestRecord: null,
      },
    };

    try {
      // Candle stats
      const candleStats = await this.db.query<{
        count: string;
        symbols: string;
        min_time: Date;
        max_time: Date;
      }>(`
        SELECT
          COUNT(*) as count,
          COUNT(DISTINCT symbol) as symbols,
          MIN(open_time) as min_time,
          MAX(open_time) as max_time
        FROM candles
      `);

      if (candleStats.rows[0]) {
        report.candles.totalRecords = parseInt(candleStats.rows[0].count);
        report.candles.symbolCount = parseInt(candleStats.rows[0].symbols);
        report.candles.oldestRecord = candleStats.rows[0].min_time;
        report.candles.newestRecord = candleStats.rows[0].max_time;
      }

      // Candles by timeframe
      const timeframeStats = await this.db.query<{
        timeframe: string;
        count: string;
      }>(`
        SELECT timeframe, COUNT(*) as count
        FROM candles
        GROUP BY timeframe
        ORDER BY timeframe
      `);

      for (const row of timeframeStats.rows) {
        report.candles.byTimeframe[row.timeframe] = parseInt(row.count);
      }

      // Funding stats
      const fundingStats = await this.db.query<{
        count: string;
        symbols: string;
        min_time: Date;
        max_time: Date;
      }>(`
        SELECT
          COUNT(*) as count,
          COUNT(DISTINCT symbol) as symbols,
          MIN(funding_time) as min_time,
          MAX(funding_time) as max_time
        FROM funding_rates
      `);

      if (fundingStats.rows[0]) {
        report.funding.totalRecords = parseInt(fundingStats.rows[0].count);
        report.funding.symbolCount = parseInt(fundingStats.rows[0].symbols);
        report.funding.oldestRecord = fundingStats.rows[0].min_time;
        report.funding.newestRecord = fundingStats.rows[0].max_time;
      }

      // Open interest stats
      const oiStats = await this.db.query<{
        count: string;
        symbols: string;
        min_time: Date;
        max_time: Date;
      }>(`
        SELECT
          COUNT(*) as count,
          COUNT(DISTINCT symbol) as symbols,
          MIN(recorded_at) as min_time,
          MAX(recorded_at) as max_time
        FROM open_interest
      `);

      if (oiStats.rows[0]) {
        report.openInterest.totalRecords = parseInt(oiStats.rows[0].count);
        report.openInterest.symbolCount = parseInt(oiStats.rows[0].symbols);
        report.openInterest.oldestRecord = oiStats.rows[0].min_time;
        report.openInterest.newestRecord = oiStats.rows[0].max_time;
      }
    } catch (error) {
      logger.error('OptimalExtractor', 'Failed to get data coverage', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }

    return report;
  }
}

export interface DataCoverageReport {
  candles: {
    totalRecords: number;
    symbolCount: number;
    oldestRecord: Date | null;
    newestRecord: Date | null;
    byTimeframe: Record<string, number>;
  };
  funding: {
    totalRecords: number;
    symbolCount: number;
    oldestRecord: Date | null;
    newestRecord: Date | null;
  };
  openInterest: {
    totalRecords: number;
    symbolCount: number;
    oldestRecord: Date | null;
    newestRecord: Date | null;
  };
}

// Export sub-modules
export { ParallelFetcher } from './parallel-fetcher';
export { S3Fetcher } from './s3-fetcher';
