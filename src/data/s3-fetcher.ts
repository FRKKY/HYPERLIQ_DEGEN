/**
 * S3 Bulk Data Fetcher for Hyperliquid Historical Data
 *
 * Hyperliquid provides historical data via public S3 buckets:
 * - hl-mainnet-node-data: Raw trade fills, node data
 * - hyperliquid-archive: L2 book snapshots, asset contexts
 *
 * This module downloads bulk historical data that exceeds API limits.
 */

import axios from 'axios';
import * as zlib from 'zlib';
import * as lz4 from 'lz4';
import { promisify } from 'util';
import { Database } from './database';
import { Candle, Timeframe } from '../types';
import { logger } from '../utils';

const gunzip = promisify(zlib.gunzip);

/**
 * Decompress LZ4 block data
 * Hyperliquid S3 uses LZ4 block format, not frame format
 */
function decompressLz4(compressed: Buffer): Buffer {
  // Try frame format first (has magic number 0x184D2204)
  if (compressed.length >= 4 && compressed.readUInt32LE(0) === 0x184D2204) {
    return lz4.decode(compressed);
  }

  // For block format, we need to know the uncompressed size
  // Hyperliquid typically uses a size prefix or we estimate
  // Try decoding with a large output buffer
  const maxOutputSize = compressed.length * 10; // Estimate 10x compression ratio
  const output = Buffer.alloc(maxOutputSize);

  try {
    const decodedSize = lz4.decodeBlock(compressed, output);
    return output.slice(0, decodedSize);
  } catch {
    // If block decode fails, try frame decode
    return lz4.decode(compressed);
  }
}

// S3 bucket URLs (public, no auth required)
const S3_BUCKETS = {
  nodeData: 'https://hl-mainnet-node-data.s3.amazonaws.com',
  archive: 'https://hyperliquid-archive.s3.amazonaws.com',
} as const;

interface S3FetcherOptions {
  downloadPath: string;
  maxConcurrentDownloads: number;
  symbols?: string[];
  startDate?: Date;
  endDate?: Date;
}

interface RawTrade {
  coin: string;
  side: 'B' | 'S';
  px: string;
  sz: string;
  time: number;
  hash: string;
}

interface AssetContext {
  coin: string;
  dayNtlVlm: string;
  funding: string;
  markPx: string;
  oraclePx: string;
  openInterest: string;
  prevDayPx: string;
}

interface FetchProgress {
  phase: string;
  totalFiles: number;
  processedFiles: number;
  totalRecords: number;
  currentFile: string;
  errors: string[];
}

const DEFAULT_OPTIONS: S3FetcherOptions = {
  downloadPath: '/tmp/hyperliquid-data',
  maxConcurrentDownloads: 3,
};

export class S3Fetcher {
  private db: Database;
  private options: S3FetcherOptions;
  private progress: FetchProgress;
  private isRunning = false;

  constructor(db: Database, options: Partial<S3FetcherOptions> = {}) {
    this.db = db;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.progress = this.initProgress();
  }

  private initProgress(): FetchProgress {
    return {
      phase: 'idle',
      totalFiles: 0,
      processedFiles: 0,
      totalRecords: 0,
      currentFile: '',
      errors: [],
    };
  }

  /**
   * Fetch available dates from the node_fills bucket
   */
  async listAvailableDates(): Promise<string[]> {
    try {
      // List bucket contents to find available dates
      // Note: S3 public buckets allow listing via XML
      const response = await axios.get(`${S3_BUCKETS.nodeData}?list-type=2&prefix=node_fills_by_block/&delimiter=/`, {
        headers: { Accept: 'application/xml' },
      });

      // Parse XML response to extract date prefixes
      const dates: string[] = [];
      const prefixMatches = response.data.match(/<Prefix>node_fills_by_block\/(\d{8})\/<\/Prefix>/g);

      if (prefixMatches) {
        for (const match of prefixMatches) {
          const dateMatch = match.match(/(\d{8})/);
          if (dateMatch) {
            dates.push(dateMatch[1]);
          }
        }
      }

      return dates.sort();
    } catch (error) {
      logger.error('S3Fetcher', 'Failed to list available dates', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      return [];
    }
  }

  /**
   * Fetch raw trade data from S3 for a specific date
   */
  async fetchTradesForDate(date: string): Promise<RawTrade[]> {
    const trades: RawTrade[] = [];
    this.progress.currentFile = `node_fills_by_block/${date}`;

    try {
      // List files for this date
      const listUrl = `${S3_BUCKETS.nodeData}?list-type=2&prefix=node_fills_by_block/${date}/`;
      const listResponse = await axios.get(listUrl, {
        headers: { Accept: 'application/xml' },
      });

      // Extract file keys from XML
      const keyMatches = listResponse.data.match(/<Key>([^<]+)<\/Key>/g);
      if (!keyMatches) return trades;

      const files = keyMatches
        .map((m: string) => m.replace(/<\/?Key>/g, ''))
        .filter((k: string) => k.endsWith('.lz4') || k.endsWith('.json'));

      logger.info('S3Fetcher', `Found ${files.length} files for date ${date}`);

      // Download and process each file
      for (const file of files) {
        try {
          const fileUrl = `${S3_BUCKETS.nodeData}/${file}`;
          const response = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
          });

          let data: string;
          if (file.endsWith('.lz4')) {
            try {
              const decompressed = decompressLz4(Buffer.from(response.data));
              data = decompressed.toString('utf-8');
            } catch (lz4Error) {
              logger.warn('S3Fetcher', `Failed to decompress LZ4 file: ${file}`, {
                error: lz4Error instanceof Error ? lz4Error.message : 'Unknown',
              });
              continue;
            }
          } else if (file.endsWith('.gz')) {
            const decompressed = await gunzip(response.data);
            data = decompressed.toString('utf-8');
          } else {
            data = Buffer.from(response.data).toString('utf-8');
          }

          // Parse JSON lines or JSON array
          const lines = data.trim().split('\n');
          for (const line of lines) {
            if (!line) continue;
            try {
              const parsed = JSON.parse(line);
              if (Array.isArray(parsed)) {
                trades.push(...parsed);
              } else if (parsed.coin) {
                trades.push(parsed);
              }
            } catch {
              // Skip malformed lines
            }
          }

          this.progress.processedFiles++;
          this.progress.totalRecords = trades.length;
        } catch (error) {
          logger.warn('S3Fetcher', `Failed to process file: ${file}`, {
            error: error instanceof Error ? error.message : 'Unknown',
          });
        }
      }
    } catch (error) {
      logger.error('S3Fetcher', `Failed to fetch trades for date ${date}`, {
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }

    return trades;
  }

  /**
   * Fetch asset contexts (funding, OI, etc.) from archive
   */
  async fetchAssetContexts(date: string): Promise<AssetContext[]> {
    const contexts: AssetContext[] = [];

    try {
      const fileUrl = `${S3_BUCKETS.archive}/asset_ctxs/${date}.csv.lz4`;

      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        validateStatus: (status) => status < 500,
      });

      if (response.status === 404) {
        logger.debug('S3Fetcher', `Asset contexts not found for date ${date}`);
        return contexts;
      }

      // Decompress LZ4
      const decompressed = decompressLz4(Buffer.from(response.data));
      const csvData = decompressed.toString('utf-8');

      // Parse CSV (skip header row)
      const lines = csvData.trim().split('\n');
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length >= 7) {
          contexts.push({
            coin: parts[0],
            dayNtlVlm: parts[1],
            funding: parts[2],
            markPx: parts[3],
            oraclePx: parts[4],
            openInterest: parts[5],
            prevDayPx: parts[6],
          });
        }
      }

      logger.debug('S3Fetcher', `Loaded ${contexts.length} asset contexts for ${date}`);
    } catch (error) {
      logger.debug('S3Fetcher', `Failed to fetch asset contexts for ${date}`, {
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }

    return contexts;
  }

  /**
   * Build candles from raw trade data
   */
  buildCandlesFromTrades(
    trades: RawTrade[],
    symbol: string,
    timeframe: Timeframe
  ): Candle[] {
    const intervalMs = this.getIntervalMs(timeframe);
    const candleMap = new Map<number, Candle>();

    // Filter trades for this symbol
    const symbolTrades = trades.filter((t) => t.coin === symbol);

    for (const trade of symbolTrades) {
      const candleTime = Math.floor(trade.time / intervalMs) * intervalMs;
      const price = parseFloat(trade.px);
      const size = parseFloat(trade.sz);

      let candle = candleMap.get(candleTime);
      if (!candle) {
        candle = {
          symbol,
          timeframe,
          openTime: new Date(candleTime),
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
        };
        candleMap.set(candleTime, candle);
      }

      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
      candle.volume += size;
    }

    return Array.from(candleMap.values()).sort(
      (a, b) => a.openTime.getTime() - b.openTime.getTime()
    );
  }

  /**
   * Fetch and process historical data for a date range
   */
  async fetchHistoricalData(
    startDate: Date,
    endDate: Date,
    symbols?: string[]
  ): Promise<FetchProgress> {
    if (this.isRunning) {
      throw new Error('S3 fetcher is already running');
    }

    this.isRunning = true;
    this.progress = this.initProgress();
    this.progress.phase = 'listing';

    try {
      // Get available dates
      const availableDates = await this.listAvailableDates();
      const startStr = this.formatDate(startDate);
      const endStr = this.formatDate(endDate);

      const targetDates = availableDates.filter((d) => d >= startStr && d <= endStr);
      this.progress.totalFiles = targetDates.length;

      logger.info('S3Fetcher', `Processing ${targetDates.length} dates`, {
        start: startStr,
        end: endStr,
      });

      this.progress.phase = 'downloading';

      for (const date of targetDates) {
        logger.info('S3Fetcher', `Processing date: ${date}`);

        // Fetch trades for this date
        const trades = await this.fetchTradesForDate(date);

        if (trades.length > 0) {
          // Get unique symbols from trades
          const tradeSymbols = [...new Set(trades.map((t) => t.coin))];
          const targetSymbols = symbols || tradeSymbols;

          // Build and store candles for each symbol/timeframe
          const timeframes: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

          for (const symbol of targetSymbols.filter((s) => tradeSymbols.includes(s))) {
            for (const timeframe of timeframes) {
              const candles = this.buildCandlesFromTrades(trades, symbol, timeframe);
              if (candles.length > 0) {
                await this.db.insertCandles(candles);
                this.progress.totalRecords += candles.length;
              }
            }
          }
        }

        this.progress.processedFiles++;
      }

      this.progress.phase = 'complete';
    } catch (error) {
      this.progress.phase = 'error';
      this.progress.errors.push(error instanceof Error ? error.message : 'Unknown error');
      logger.error('S3Fetcher', 'Historical data fetch failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
    } finally {
      this.isRunning = false;
    }

    return this.progress;
  }

  /**
   * Check S3 bucket availability and data freshness
   */
  async checkAvailability(): Promise<{
    nodeDataAvailable: boolean;
    archiveAvailable: boolean;
    latestDate: string | null;
    totalDates: number;
  }> {
    let nodeDataAvailable = false;
    let archiveAvailable = false;
    let latestDate: string | null = null;
    let totalDates = 0;

    try {
      // Check node data bucket
      const response = await axios.head(S3_BUCKETS.nodeData, {
        validateStatus: () => true,
      });
      nodeDataAvailable = response.status < 400;

      // Get available dates
      const dates = await this.listAvailableDates();
      totalDates = dates.length;
      latestDate = dates[dates.length - 1] || null;
    } catch {
      // Bucket not accessible
    }

    try {
      // Check archive bucket
      const response = await axios.head(S3_BUCKETS.archive, {
        validateStatus: () => true,
      });
      archiveAvailable = response.status < 400;
    } catch {
      // Bucket not accessible
    }

    return { nodeDataAvailable, archiveAvailable, latestDate, totalDates };
  }

  private formatDate(date: Date): string {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
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

  getProgress(): FetchProgress {
    return { ...this.progress };
  }

  isActive(): boolean {
    return this.isRunning;
  }
}
