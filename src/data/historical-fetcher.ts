import { HyperliquidRestClient } from '../hyperliquid';
import { Database } from './database';
import { Candle, FundingRate, Timeframe } from '../types';
import { logger } from '../utils';

/**
 * Comprehensive historical data fetcher for exhaustive data collection.
 *
 * Hyperliquid API limits:
 * - Candles: 5000 most recent per symbol/timeframe, paginate by 500
 * - Funding history: No stated limit, paginate by 500 records
 * - User fills: 10000 most recent, paginate by 2000
 * - Historical orders: 2000 most recent
 * - Open interest: Current snapshot only (no historical API)
 */
export class HistoricalDataFetcher {
  private client: HyperliquidRestClient;
  private db: Database;
  private isRunning = false;

  constructor(client: HyperliquidRestClient, db: Database) {
    this.client = client;
    this.db = db;
  }

  /**
   * Run full historical data fetch for all available data
   */
  async fetchAllHistoricalData(symbols?: string[]): Promise<HistoricalFetchResult> {
    if (this.isRunning) {
      throw new Error('Historical fetch already in progress');
    }

    this.isRunning = true;
    const result: HistoricalFetchResult = {
      startTime: new Date(),
      endTime: new Date(),
      candlesCollected: 0,
      fundingRatesCollected: 0,
      fillsCollected: 0,
      ordersCollected: 0,
      openInterestRecords: 0,
      errors: [],
    };

    try {
      await this.client.initialize();
      const meta = await this.client.getMeta();
      const targetSymbols = symbols || meta.universe.map((u) => u.name);

      logger.info('HistoricalFetcher', 'Starting exhaustive historical fetch', {
        symbols: targetSymbols.length
      });

      // 1. Fetch candle history for all timeframes
      console.log(`[HistoricalFetcher] Fetching candles for ${targetSymbols.length} symbols...`);
      for (const coin of targetSymbols) {
        try {
          const candles = await this.fetchCoinHistory(coin);
          result.candlesCollected += candles;
        } catch (error) {
          result.errors.push(`Candles ${coin}: ${error instanceof Error ? error.message : 'Unknown'}`);
        }
        await this.sleep(100);
      }

      // 2. Fetch funding history
      console.log(`[HistoricalFetcher] Fetching funding history...`);
      for (const coin of targetSymbols) {
        try {
          const rates = await this.fetchFundingHistory(coin);
          result.fundingRatesCollected += rates;
        } catch (error) {
          result.errors.push(`Funding ${coin}: ${error instanceof Error ? error.message : 'Unknown'}`);
        }
        await this.sleep(100);
      }

      // 3. Fetch user fills with pagination
      console.log(`[HistoricalFetcher] Fetching user fills...`);
      try {
        result.fillsCollected = await this.fetchUserFillsHistory();
      } catch (error) {
        result.errors.push(`User fills: ${error instanceof Error ? error.message : 'Unknown'}`);
      }

      // 4. Fetch historical orders
      console.log(`[HistoricalFetcher] Fetching historical orders...`);
      try {
        result.ordersCollected = await this.fetchHistoricalOrders();
      } catch (error) {
        result.errors.push(`Orders: ${error instanceof Error ? error.message : 'Unknown'}`);
      }

      // 5. Capture current open interest snapshot
      console.log(`[HistoricalFetcher] Capturing open interest snapshot...`);
      try {
        result.openInterestRecords = await this.fetchOpenInterestSnapshot(targetSymbols);
      } catch (error) {
        result.errors.push(`Open interest: ${error instanceof Error ? error.message : 'Unknown'}`);
      }

    } finally {
      this.isRunning = false;
      result.endTime = new Date();
    }

    const duration = (result.endTime.getTime() - result.startTime.getTime()) / 1000;
    logger.info('HistoricalFetcher', 'Historical fetch complete', {
      durationSeconds: duration,
      candles: result.candlesCollected,
      fundingRates: result.fundingRatesCollected,
      fills: result.fillsCollected,
      orders: result.ordersCollected,
      openInterest: result.openInterestRecords,
      errors: result.errors.length,
    });

    console.log(`[HistoricalFetcher] Complete in ${duration}s`);
    console.log(`  Candles: ${result.candlesCollected}`);
    console.log(`  Funding rates: ${result.fundingRatesCollected}`);
    console.log(`  User fills: ${result.fillsCollected}`);
    console.log(`  Orders: ${result.ordersCollected}`);
    console.log(`  Open interest: ${result.openInterestRecords}`);
    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
    }

    return result;
  }

  /**
   * Fetch all available candle history for a coin (up to 5000 per timeframe)
   */
  async fetchCoinHistory(coin: string): Promise<number> {
    const intervals: { tf: Timeframe; label: string }[] = [
      { tf: '1m', label: '1m' },
      { tf: '5m', label: '5m' },
      { tf: '15m', label: '15m' },
      { tf: '1h', label: '1h' },
      { tf: '4h', label: '4h' },
      { tf: '1d', label: '1d' },
    ];

    let totalCandles = 0;

    for (const { tf, label } of intervals) {
      // Calculate start time to fetch maximum available (5000 candles)
      const intervalMs = this.getIntervalMs(tf);
      const startTime = Date.now() - (intervalMs * 5000);
      const endTime = Date.now();

      let currentStart = startTime;
      let intervalCandles = 0;

      // Paginate to fetch all available candles
      while (currentStart < endTime) {
        try {
          const candles = await this.client.getCandles(coin, label, currentStart, endTime);

          if (candles.length === 0) break;

          const formattedCandles: Candle[] = candles.map((c) => ({
            symbol: coin,
            timeframe: tf,
            openTime: new Date(c.t),
            open: parseFloat(c.o),
            high: parseFloat(c.h),
            low: parseFloat(c.l),
            close: parseFloat(c.c),
            volume: parseFloat(c.v),
          }));

          await this.db.insertCandles(formattedCandles);
          intervalCandles += formattedCandles.length;
          totalCandles += formattedCandles.length;

          // Move forward for next page
          currentStart = candles[candles.length - 1].t + 1;

          // If we got less than expected, we've reached the end
          if (candles.length < 500) break;

          await this.sleep(50);
        } catch (error) {
          console.error(`[HistoricalFetcher] Error fetching ${coin} ${tf}:`, error);
          break;
        }
      }

      if (intervalCandles > 0) {
        console.log(`  ${coin} ${tf}: ${intervalCandles} candles`);
      }
    }

    return totalCandles;
  }

  /**
   * Fetch all available funding history (up to 6 months back)
   */
  async fetchFundingHistory(coin: string): Promise<number> {
    // Go back 6 months (funding is every 8 hours = 3 per day * 180 days = 540 records expected)
    const sixMonthsAgo = Date.now() - (180 * 24 * 60 * 60 * 1000);
    let startTime = sixMonthsAgo;
    let totalRates = 0;

    while (startTime < Date.now()) {
      try {
        const fundingHistory = await this.client.getFundingHistory(coin, startTime, Date.now());

        if (fundingHistory.length === 0) break;

        const rates: FundingRate[] = fundingHistory.map((f) => ({
          symbol: coin,
          fundingTime: new Date(f.time),
          fundingRate: parseFloat(f.fundingRate),
          markPrice: parseFloat(f.premium),
        }));

        await this.db.insertFundingRates(rates);
        totalRates += rates.length;

        // If we got less than 500, we've reached the end
        if (fundingHistory.length < 500) break;

        // Move forward for pagination (guard against empty array)
        const maxTime = fundingHistory.reduce((max, f) => Math.max(max, f.time), 0);
        if (maxTime === 0) break;
        startTime = maxTime + 1;

        await this.sleep(50);
      } catch (error) {
        console.error(`[HistoricalFetcher] Error fetching funding for ${coin}:`, error);
        break;
      }
    }

    if (totalRates > 0) {
      console.log(`  ${coin} funding: ${totalRates} records`);
    }

    return totalRates;
  }

  /**
   * Fetch user fills history with pagination (up to 10000 most recent)
   */
  private async fetchUserFillsHistory(): Promise<number> {
    let totalFills = 0;

    // Start from 6 months ago
    let startTime = Date.now() - (180 * 24 * 60 * 60 * 1000);

    while (true) {
      try {
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

        // If we got less than 2000, we've reached the end
        if (fills.length < 2000) break;

        // Move start time forward (guard against empty array)
        const maxFillTime = fills.reduce((max, f) => Math.max(max, f.time), 0);
        if (maxFillTime === 0) break;
        startTime = maxFillTime + 1;

        await this.sleep(100);
      } catch (error) {
        console.error('[HistoricalFetcher] Error fetching user fills:', error);
        break;
      }
    }

    return totalFills;
  }

  /**
   * Fetch historical orders (up to 2000 most recent)
   */
  private async fetchHistoricalOrders(): Promise<number> {
    try {
      const orders = await this.client.getHistoricalOrders();

      let count = 0;
      for (const order of orders) {
        try {
          await this.db.query(
            `INSERT INTO signals (strategy_name, symbol, signal_time, direction, strength, entry_price, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              'historical_order',
              order.coin,
              new Date(order.timestamp),
              order.side === 'B' ? 'LONG' : 'SHORT',
              1.0,
              parseFloat(order.limitPx),
              { oid: order.oid, sz: order.sz, historical: true },
            ]
          );
          count++;
        } catch {
          // Skip duplicates or errors
        }
      }

      return count;
    } catch (error) {
      console.error('[HistoricalFetcher] Error fetching historical orders:', error);
      return 0;
    }
  }

  /**
   * Fetch current open interest snapshot for all symbols
   */
  private async fetchOpenInterestSnapshot(symbols: string[]): Promise<number> {
    try {
      const assetCtxs = await this.client.getAssetContexts();

      const oiData = assetCtxs
        .filter(ctx => symbols.includes(ctx.coin))
        .map(ctx => ({
          symbol: ctx.coin,
          openInterest: parseFloat(ctx.openInterest),
          openInterestValue: parseFloat(ctx.openInterest) * parseFloat(ctx.markPx),
        }));

      await this.db.insertOpenInterestBatch(oiData);

      return oiData.length;
    } catch (error) {
      console.error('[HistoricalFetcher] Error fetching open interest:', error);
      return 0;
    }
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
}

export interface HistoricalFetchResult {
  startTime: Date;
  endTime: Date;
  candlesCollected: number;
  fundingRatesCollected: number;
  fillsCollected: number;
  ordersCollected: number;
  openInterestRecords: number;
  errors: string[];
}
