import { HyperliquidRestClient } from '../hyperliquid';
import { Database } from './database';
import { Candle, FundingRate, Timeframe } from '../types';

export class HistoricalDataFetcher {
  private client: HyperliquidRestClient;
  private db: Database;

  constructor(client: HyperliquidRestClient, db: Database) {
    this.client = client;
    this.db = db;
  }

  async fetchAllHistoricalData(): Promise<void> {
    await this.client.initialize();
    const meta = await this.client.getMeta();
    const coins = meta.universe.map((u) => u.name);

    console.log(`[HistoricalFetcher] Fetching historical data for ${coins.length} coins...`);

    for (const coin of coins) {
      console.log(`[HistoricalFetcher] Processing ${coin}...`);

      await this.fetchCoinHistory(coin);
      await this.fetchFundingHistory(coin);

      // Rate limit: pause between coins
      await this.sleep(500);
    }

    console.log('[HistoricalFetcher] Historical data fetch complete');
  }

  async fetchCoinHistory(coin: string): Promise<void> {
    const intervals: { tf: Timeframe; label: string }[] = [
      { tf: '1m', label: '1m' },
      { tf: '5m', label: '5m' },
      { tf: '15m', label: '15m' },
      { tf: '1h', label: '1h' },
      { tf: '4h', label: '4h' },
      { tf: '1d', label: '1d' },
    ];

    for (const { tf, label } of intervals) {
      let startTime = this.getDefaultStartTime(tf);
      const endTime = Date.now();
      let totalCandles = 0;

      while (startTime < endTime) {
        try {
          const candles = await this.client.getCandles(coin, label, startTime, endTime);

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
          totalCandles += formattedCandles.length;

          startTime = candles[candles.length - 1].t + 1;
          await this.sleep(100); // Rate limit
        } catch (error) {
          console.error(`[HistoricalFetcher] Error fetching ${coin} ${tf}:`, error);
          break;
        }
      }

      console.log(`  ${coin} ${tf}: fetched ${totalCandles} candles`);
    }
  }

  async fetchFundingHistory(coin: string): Promise<void> {
    const startTime = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90 days

    try {
      const fundingHistory = await this.client.getFundingHistory(coin, startTime);

      const rates: FundingRate[] = fundingHistory.map((f) => ({
        symbol: coin,
        fundingTime: new Date(f.time),
        fundingRate: parseFloat(f.fundingRate),
        markPrice: parseFloat(f.premium),
      }));

      await this.db.insertFundingRates(rates);

      console.log(`  ${coin} funding: fetched ${fundingHistory.length} records`);
    } catch (error) {
      console.error(`[HistoricalFetcher] Error fetching funding for ${coin}:`, error);
    }
  }

  private getDefaultStartTime(interval: Timeframe): number {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // Fetch different amounts based on interval
    switch (interval) {
      case '1m':
        return now - 7 * day; // 7 days of 1m
      case '5m':
        return now - 30 * day; // 30 days of 5m
      case '15m':
        return now - 60 * day; // 60 days of 15m
      case '1h':
        return now - 90 * day; // 90 days of 1h
      case '4h':
        return now - 180 * day; // 180 days of 4h
      case '1d':
        return now - 365 * day; // 365 days of 1d
      default:
        return now - 30 * day;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
