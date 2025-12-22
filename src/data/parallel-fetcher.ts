/**
 * Rate-limit-aware parallel data fetcher for Hyperliquid API
 *
 * Hyperliquid rate limits:
 * - 1,200 weight per minute per IP
 * - candleSnapshot: 20 base + 1 per 60 candles returned
 * - fundingHistory: 20 base + 1 per 20 records returned
 * - Most info endpoints: 20 weight
 */

import { HyperliquidRestClient } from '../hyperliquid';
import { Database } from './database';
import { Candle, FundingRate, Timeframe } from '../types';
import { logger } from '../utils';

// Weight costs per endpoint
const WEIGHT_COSTS = {
  candleSnapshot: { base: 20, perItems: 60 },
  fundingHistory: { base: 20, perItems: 20 },
  metaAndAssetCtxs: { base: 2 },
  allMids: { base: 2 },
} as const;

const MAX_WEIGHT_PER_MINUTE = 1200;
const SAFETY_MARGIN = 0.85; // Use 85% of budget to be safe
const EFFECTIVE_BUDGET = MAX_WEIGHT_PER_MINUTE * SAFETY_MARGIN;

interface FetchTask {
  id: string;
  type: 'candles' | 'funding' | 'openInterest';
  symbol: string;
  timeframe?: Timeframe;
  priority: number; // Higher = more important
  startTime?: number;
  endTime?: number;
  retryCount: number;
  estimatedWeight: number;
}

interface FetchProgress {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  totalRecords: number;
  startTime: Date;
  currentSymbol: string;
  currentType: string;
  estimatedTimeRemaining: number; // seconds
  weightUsedThisMinute: number;
}

interface ParallelFetcherOptions {
  maxConcurrency: number;
  prioritySymbols: string[];
  timeframes: Timeframe[];
  fundingHistoryMonths: number;
  incrementalMode: boolean;
  onProgress?: (progress: FetchProgress) => void;
}

const DEFAULT_OPTIONS: ParallelFetcherOptions = {
  maxConcurrency: 5,
  prioritySymbols: ['BTC', 'ETH', 'SOL', 'DOGE', 'AVAX', 'LINK', 'ARB', 'OP', 'SUI', 'APT'],
  timeframes: ['1d', '4h', '1h', '15m', '5m', '1m'],
  fundingHistoryMonths: 12,
  incrementalMode: true,
};

export class ParallelFetcher {
  private client: HyperliquidRestClient;
  private db: Database;
  private options: ParallelFetcherOptions;
  private taskQueue: FetchTask[] = [];
  private activeWorkers = 0;
  private weightUsedThisMinute = 0;
  private minuteStart = Date.now();
  private progress: FetchProgress;
  private isRunning = false;
  private abortSignal = false;

  constructor(
    client: HyperliquidRestClient,
    db: Database,
    options: Partial<ParallelFetcherOptions> = {}
  ) {
    this.client = client;
    this.db = db;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.progress = this.initProgress();
  }

  private initProgress(): FetchProgress {
    return {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      totalRecords: 0,
      startTime: new Date(),
      currentSymbol: '',
      currentType: '',
      estimatedTimeRemaining: 0,
      weightUsedThisMinute: 0,
    };
  }

  /**
   * Build the task queue with priority ordering
   */
  async buildTaskQueue(symbols: string[]): Promise<void> {
    this.taskQueue = [];
    const { prioritySymbols, timeframes, fundingHistoryMonths } = this.options;

    // Sort symbols by priority
    const sortedSymbols = [...symbols].sort((a, b) => {
      const aPriority = prioritySymbols.indexOf(a);
      const bPriority = prioritySymbols.indexOf(b);
      if (aPriority === -1 && bPriority === -1) return 0;
      if (aPriority === -1) return 1;
      if (bPriority === -1) return -1;
      return aPriority - bPriority;
    });

    // Add candle tasks (higher timeframes first for each symbol)
    for (const symbol of sortedSymbols) {
      const symbolPriority = prioritySymbols.includes(symbol) ? 100 : 50;

      for (const timeframe of timeframes) {
        const timeframePriority = this.getTimeframePriority(timeframe);
        const startTime = await this.getLastCandleTime(symbol, timeframe);

        this.taskQueue.push({
          id: `candles-${symbol}-${timeframe}`,
          type: 'candles',
          symbol,
          timeframe,
          priority: symbolPriority + timeframePriority,
          startTime,
          retryCount: 0,
          estimatedWeight: WEIGHT_COSTS.candleSnapshot.base + Math.ceil(5000 / WEIGHT_COSTS.candleSnapshot.perItems),
        });
      }

      // Add funding task
      const fundingStartTime = await this.getLastFundingTime(symbol);
      const defaultFundingStart = Date.now() - (fundingHistoryMonths * 30 * 24 * 60 * 60 * 1000);

      this.taskQueue.push({
        id: `funding-${symbol}`,
        type: 'funding',
        symbol,
        priority: symbolPriority + 5, // Funding is less priority than candles
        startTime: fundingStartTime || defaultFundingStart,
        retryCount: 0,
        estimatedWeight: WEIGHT_COSTS.fundingHistory.base + Math.ceil(500 / WEIGHT_COSTS.fundingHistory.perItems),
      });
    }

    // Sort by priority (descending)
    this.taskQueue.sort((a, b) => b.priority - a.priority);

    this.progress.totalTasks = this.taskQueue.length;
    logger.info('ParallelFetcher', 'Task queue built', {
      totalTasks: this.taskQueue.length,
      symbols: sortedSymbols.length,
      timeframes: timeframes.length,
    });
  }

  private getTimeframePriority(timeframe: Timeframe): number {
    const priorities: Record<Timeframe, number> = {
      '1d': 10,
      '4h': 9,
      '1h': 8,
      '15m': 7,
      '5m': 6,
      '1m': 5,
    };
    return priorities[timeframe];
  }

  private async getLastCandleTime(symbol: string, timeframe: Timeframe): Promise<number | undefined> {
    if (!this.options.incrementalMode) return undefined;

    try {
      const result = await this.db.query<{ max_time: Date }>(
        `SELECT MAX(open_time) as max_time FROM candles WHERE symbol = $1 AND timeframe = $2`,
        [symbol, timeframe]
      );
      if (result.rows[0]?.max_time) {
        return new Date(result.rows[0].max_time).getTime() + 1;
      }
    } catch {
      // Table might not exist yet
    }
    return undefined;
  }

  private async getLastFundingTime(symbol: string): Promise<number | undefined> {
    if (!this.options.incrementalMode) return undefined;

    try {
      const result = await this.db.query<{ max_time: Date }>(
        `SELECT MAX(funding_time) as max_time FROM funding_rates WHERE symbol = $1`,
        [symbol]
      );
      if (result.rows[0]?.max_time) {
        return new Date(result.rows[0].max_time).getTime() + 1;
      }
    } catch {
      // Table might not exist yet
    }
    return undefined;
  }

  /**
   * Execute all tasks with rate-limiting and parallelism
   */
  async execute(): Promise<FetchProgress> {
    if (this.isRunning) {
      throw new Error('Fetcher is already running');
    }

    this.isRunning = true;
    this.abortSignal = false;
    this.progress = this.initProgress();
    this.progress.totalTasks = this.taskQueue.length;
    this.progress.startTime = new Date();

    logger.info('ParallelFetcher', 'Starting parallel fetch', {
      tasks: this.taskQueue.length,
      concurrency: this.options.maxConcurrency,
    });

    try {
      await this.runWorkerPool();
    } finally {
      this.isRunning = false;
    }

    logger.info('ParallelFetcher', 'Parallel fetch complete', {
      completed: this.progress.completedTasks,
      failed: this.progress.failedTasks,
      records: this.progress.totalRecords,
      durationSeconds: (Date.now() - this.progress.startTime.getTime()) / 1000,
    });

    return this.progress;
  }

  /**
   * Abort the current fetch operation
   */
  abort(): void {
    this.abortSignal = true;
    logger.info('ParallelFetcher', 'Abort requested');
  }

  private async runWorkerPool(): Promise<void> {
    const workers: Promise<void>[] = [];

    for (let i = 0; i < this.options.maxConcurrency; i++) {
      workers.push(this.worker(i));
    }

    await Promise.all(workers);
  }

  private async worker(workerId: number): Promise<void> {
    while (!this.abortSignal) {
      // Wait for rate limit budget
      await this.waitForBudget();

      // Get next task
      const task = this.taskQueue.shift();
      if (!task) break;

      this.activeWorkers++;
      this.progress.currentSymbol = task.symbol;
      this.progress.currentType = task.type;

      try {
        const records = await this.executeTask(task);
        this.progress.completedTasks++;
        this.progress.totalRecords += records;

        // Update ETA
        const elapsed = (Date.now() - this.progress.startTime.getTime()) / 1000;
        const rate = this.progress.completedTasks / elapsed;
        const remaining = this.taskQueue.length + this.activeWorkers - 1;
        this.progress.estimatedTimeRemaining = remaining / rate;

        logger.debug('ParallelFetcher', `Worker ${workerId} completed task`, {
          task: task.id,
          records,
          remaining: this.taskQueue.length,
        });
      } catch (error) {
        if (task.retryCount < 3) {
          task.retryCount++;
          task.priority -= 10; // Lower priority on retry
          this.taskQueue.push(task);
          logger.warn('ParallelFetcher', `Task failed, retrying`, {
            task: task.id,
            retry: task.retryCount,
            error: error instanceof Error ? error.message : 'Unknown',
          });
        } else {
          this.progress.failedTasks++;
          logger.error('ParallelFetcher', `Task failed permanently`, {
            task: task.id,
            error: error instanceof Error ? error.message : 'Unknown',
          });
        }
      }

      this.activeWorkers--;

      // Report progress
      if (this.options.onProgress) {
        this.progress.weightUsedThisMinute = this.weightUsedThisMinute;
        this.options.onProgress(this.progress);
      }
    }
  }

  private async waitForBudget(): Promise<void> {
    while (true) {
      // Reset weight counter every minute
      const now = Date.now();
      if (now - this.minuteStart >= 60000) {
        this.weightUsedThisMinute = 0;
        this.minuteStart = now;
      }

      // Check if we have budget
      const nextTaskWeight = this.taskQueue[0]?.estimatedWeight || 100;
      if (this.weightUsedThisMinute + nextTaskWeight <= EFFECTIVE_BUDGET) {
        this.weightUsedThisMinute += nextTaskWeight;
        return;
      }

      // Wait for budget to reset
      const waitTime = 60000 - (now - this.minuteStart) + 100;
      logger.debug('ParallelFetcher', `Waiting for rate limit budget`, {
        waitMs: waitTime,
        weightUsed: this.weightUsedThisMinute,
        budget: EFFECTIVE_BUDGET,
      });
      await this.sleep(Math.min(waitTime, 5000)); // Check every 5 seconds
    }
  }

  private async executeTask(task: FetchTask): Promise<number> {
    switch (task.type) {
      case 'candles':
        return this.fetchCandles(task);
      case 'funding':
        return this.fetchFunding(task);
      default:
        return 0;
    }
  }

  private async fetchCandles(task: FetchTask): Promise<number> {
    const { symbol, timeframe, startTime } = task;
    if (!timeframe) return 0;

    const intervalMs = this.getIntervalMs(timeframe);
    const maxCandles = 5000;
    const calculatedStart = startTime || (Date.now() - intervalMs * maxCandles);
    const endTime = Date.now();

    let totalCandles = 0;
    let currentStart = calculatedStart;

    while (currentStart < endTime) {
      const candles = await this.client.getCandles(symbol, timeframe, currentStart, endTime);

      if (candles.length === 0) break;

      const formattedCandles: Candle[] = candles.map((c) => ({
        symbol,
        timeframe,
        openTime: new Date(c.t),
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
        volume: parseFloat(c.v),
      }));

      await this.db.insertCandles(formattedCandles);
      totalCandles += formattedCandles.length;

      // Move forward for next page
      currentStart = candles[candles.length - 1].t + 1;

      // If we got less than 500, we've reached the end of available data
      if (candles.length < 500) break;

      // Small delay between pagination requests
      await this.sleep(50);
    }

    return totalCandles;
  }

  private async fetchFunding(task: FetchTask): Promise<number> {
    const { symbol, startTime } = task;
    const calculatedStart = startTime || Date.now() - (this.options.fundingHistoryMonths * 30 * 24 * 60 * 60 * 1000);

    let totalRates = 0;
    let currentStart = calculatedStart;

    while (currentStart < Date.now()) {
      const fundingHistory = await this.client.getFundingHistory(symbol, currentStart, Date.now());

      if (fundingHistory.length === 0) break;

      const rates: FundingRate[] = fundingHistory.map((f) => ({
        symbol,
        fundingTime: new Date(f.time),
        fundingRate: parseFloat(f.fundingRate),
        markPrice: parseFloat(f.premium),
      }));

      await this.db.insertFundingRates(rates);
      totalRates += rates.length;

      // If we got less than 500, we've reached the end
      if (fundingHistory.length < 500) break;

      // Move forward for pagination
      currentStart = Math.max(...fundingHistory.map((f) => f.time)) + 1;

      await this.sleep(50);
    }

    return totalRates;
  }

  private getIntervalMs(interval: Timeframe): number {
    const intervals: Record<Timeframe, number> = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
    };
    return intervals[interval];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getProgress(): FetchProgress {
    return { ...this.progress };
  }

  isActive(): boolean {
    return this.isRunning;
  }
}
