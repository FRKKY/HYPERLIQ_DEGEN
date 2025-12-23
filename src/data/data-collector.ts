import { EventEmitter } from 'events';
import { HyperliquidRestClient, HyperliquidWebSocket } from '../hyperliquid';
import { Database } from './database';
import { Candle, FundingRate, Timeframe } from '../types';

export class DataCollector extends EventEmitter {
  private restClient: HyperliquidRestClient;
  private wsClient: HyperliquidWebSocket;
  private db: Database;
  private symbols: string[] = [];
  private isRunning = false;
  private candleIntervals: Map<string, NodeJS.Timeout> = new Map();
  // Track consecutive failures per operation for circuit breaker
  private consecutiveFailures: Map<string, number> = new Map();
  private readonly MAX_CONSECUTIVE_FAILURES = 10;
  private readonly FAILURE_RESET_INTERVAL = 5 * 60 * 1000; // 5 minutes

  constructor(restClient: HyperliquidRestClient, wsClient: HyperliquidWebSocket, db: Database) {
    super();
    this.restClient = restClient;
    this.wsClient = wsClient;
    this.db = db;
  }

  async start(symbols?: string[], isTestnet: boolean = false): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Get all symbols if not provided
    if (!symbols) {
      await this.restClient.initialize();
      let allSymbols = this.restClient.getAllSymbols();

      // On testnet, limit to top liquid symbols to avoid rate limits
      if (isTestnet) {
        const prioritySymbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'BNB', 'ADA', 'AVAX', 'MATIC', 'LINK'];
        this.symbols = allSymbols.filter(s => prioritySymbols.includes(s)).slice(0, 10);
        console.log(`[DataCollector] Testnet mode: limiting to ${this.symbols.length} priority symbols`);
      } else {
        this.symbols = allSymbols;
      }
    } else {
      this.symbols = symbols;
    }

    console.log(`[DataCollector] Starting data collection for ${this.symbols.length} symbols`);

    // Connect WebSocket
    await this.wsClient.connect();

    // Subscribe to user events for account updates
    this.wsClient.subscribeUserEvents(this.restClient['auth'].address);

    // Subscribe to all mids for price updates
    this.wsClient.subscribeAllMids();

    // Set up WebSocket event handlers
    this.setupWebSocketHandlers();

    // Start periodic candle fetching for each timeframe
    this.startCandleFetching();

    // Start periodic funding rate fetching
    this.startFundingFetching();

    // Start open interest collection
    this.startOpenInterestFetching();

    // Start account snapshot collection
    this.startAccountSnapshotFetching();

    console.log('[DataCollector] Data collection started');
  }

  stop(): void {
    this.isRunning = false;

    // Clear all intervals
    for (const interval of this.candleIntervals.values()) {
      clearInterval(interval);
    }
    this.candleIntervals.clear();

    // Disconnect WebSocket
    this.wsClient.disconnect();

    console.log('[DataCollector] Data collection stopped');
  }

  private setupWebSocketHandlers(): void {
    this.wsClient.on('candle', async (data: { s: string; i: string; t: number; o: string; h: string; l: string; c: string; v: string }) => {
      const candle: Candle = {
        symbol: data.s,
        timeframe: data.i as Timeframe,
        openTime: new Date(data.t),
        open: parseFloat(data.o),
        high: parseFloat(data.h),
        low: parseFloat(data.l),
        close: parseFloat(data.c),
        volume: parseFloat(data.v),
      };

      await this.db.insertCandle(candle);
      this.emit('candle', candle);
    });

    this.wsClient.on('allMids', (data: Record<string, string>) => {
      this.emit('prices', data);
    });

    this.wsClient.on('userEvents', (data: unknown) => {
      this.emit('userEvents', data);
    });

    this.wsClient.on('maxReconnectReached', () => {
      console.error('[DataCollector] WebSocket max reconnect reached');
      this.emit('error', new Error('WebSocket max reconnect reached'));
    });
  }

  private startCandleFetching(): void {
    const timeframes: { tf: Timeframe; intervalMs: number; delayStart: number }[] = [
      { tf: '1h', intervalMs: 60 * 60 * 1000, delayStart: 0 },        // Start immediately, most important
      { tf: '15m', intervalMs: 15 * 60 * 1000, delayStart: 60000 },   // Start after 1 min
      { tf: '5m', intervalMs: 5 * 60 * 1000, delayStart: 120000 },    // Start after 2 min
      { tf: '4h', intervalMs: 4 * 60 * 60 * 1000, delayStart: 180000 }, // Start after 3 min
      { tf: '1m', intervalMs: 60 * 1000, delayStart: 240000 },        // Start after 4 min
    ];

    for (const { tf, intervalMs, delayStart } of timeframes) {
      // Stagger initial candle fetches to avoid rate limits
      setTimeout(() => {
        console.log(`[DataCollector] Starting ${tf} candle collection...`);
        this.fetchAllCandles(tf)
          .then(() => this.recordSuccess(`candles_${tf}`))
          .catch((error) => {
            console.error(`[DataCollector] Error fetching ${tf} candles:`, error);
            this.recordFailure(`candles_${tf}`);
          });

        // Set up periodic fetching
        const interval = setInterval(() => {
          // Skip if circuit breaker is open
          if (this.isCircuitOpen(`candles_${tf}`)) {
            console.warn(`[DataCollector] Skipping ${tf} candle fetch - circuit breaker open`);
            return;
          }
          this.fetchAllCandles(tf)
            .then(() => this.recordSuccess(`candles_${tf}`))
            .catch((error) => {
              console.error(`[DataCollector] Error fetching ${tf} candles:`, error);
              this.recordFailure(`candles_${tf}`);
            });
        }, intervalMs);

        this.candleIntervals.set(tf, interval);
      }, delayStart);
    }
  }

  private async fetchAllCandles(timeframe: Timeframe): Promise<void> {
    const endTime = Date.now();
    const startTime = endTime - this.getTimeframeDuration(timeframe) * 100; // Fetch last 100 candles

    for (const symbol of this.symbols) {
      try {
        const candles = await this.restClient.getCandles(symbol, timeframe, startTime, endTime);

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

        // Rate limiting - 200ms between requests
        await this.sleep(200);
      } catch (error) {
        // Silently skip failed requests - they'll retry on next cycle
        // Rate limit even on failure to avoid hammering API
        await this.sleep(500);
      }
    }
  }

  private startFundingFetching(): void {
    // Funding rates are updated every 8 hours
    const fetchFunding = async () => {
      const endTime = Date.now();
      const startTime = endTime - 24 * 60 * 60 * 1000; // Last 24 hours

      for (const symbol of this.symbols) {
        try {
          const fundingHistory = await this.restClient.getFundingHistory(symbol, startTime, endTime);

          const rates: FundingRate[] = fundingHistory.map((f) => ({
            symbol,
            fundingTime: new Date(f.time),
            fundingRate: parseFloat(f.fundingRate),
            markPrice: parseFloat(f.premium),
          }));

          await this.db.insertFundingRates(rates);

          // Rate limiting - 200ms between requests
          await this.sleep(200);
        } catch (error) {
          // Silently skip failed requests - they'll retry on next cycle
          await this.sleep(500);
        }
      }
    };

    // Delay initial funding fetch to let candles start first
    setTimeout(() => {
      console.log('[DataCollector] Starting funding rate collection...');
      fetchFunding()
        .then(() => this.recordSuccess('funding'))
        .catch((error) => {
          console.error('[DataCollector] Error fetching funding rates:', error);
          this.recordFailure('funding');
        });
    }, 30000); // Start after 30 seconds

    // Fetch every hour
    const interval = setInterval(() => {
      if (this.isCircuitOpen('funding')) {
        console.warn('[DataCollector] Skipping funding fetch - circuit breaker open');
        return;
      }
      fetchFunding()
        .then(() => this.recordSuccess('funding'))
        .catch((error) => {
          console.error('[DataCollector] Error fetching funding rates:', error);
          this.recordFailure('funding');
        });
    }, 60 * 60 * 1000);

    this.candleIntervals.set('funding', interval);
  }

  private getTimeframeDuration(timeframe: Timeframe): number {
    const durations: Record<Timeframe, number> = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
    };
    return durations[timeframe];
  }

  private startOpenInterestFetching(): void {
    const fetchOpenInterest = async () => {
      try {
        const assetCtxs = await this.restClient.getAssetContexts();

        const oiData = assetCtxs
          .filter(ctx => this.symbols.includes(ctx.coin))
          .map(ctx => ({
            symbol: ctx.coin,
            openInterest: parseFloat(ctx.openInterest),
            openInterestValue: parseFloat(ctx.openInterest) * parseFloat(ctx.markPx),
          }));

        await this.db.insertOpenInterestBatch(oiData);
        this.emit('openInterest', oiData);
      } catch (error) {
        console.error('[DataCollector] Failed to fetch open interest:', error);
      }
    };

    // Delay initial fetch to let other data collection start first
    setTimeout(() => {
      console.log('[DataCollector] Starting open interest collection...');
      fetchOpenInterest()
        .then(() => this.recordSuccess('openInterest'))
        .catch((error) => {
          console.error('[DataCollector] Error fetching open interest:', error);
          this.recordFailure('openInterest');
        });
    }, 45000); // Start after 45 seconds

    // Fetch every 15 minutes (OI doesn't change rapidly)
    const interval = setInterval(() => {
      if (this.isCircuitOpen('openInterest')) {
        console.warn('[DataCollector] Skipping OI fetch - circuit breaker open');
        return;
      }
      fetchOpenInterest()
        .then(() => this.recordSuccess('openInterest'))
        .catch((error) => {
          console.error('[DataCollector] Error fetching open interest:', error);
          this.recordFailure('openInterest');
        });
    }, 15 * 60 * 1000);

    this.candleIntervals.set('openInterest', interval);
  }

  private startAccountSnapshotFetching(): void {
    const fetchAccountSnapshot = async () => {
      try {
        const accountState = await this.restClient.getAccountState();

        const equity = parseFloat(accountState.marginSummary.accountValue);
        const totalMarginUsed = parseFloat(accountState.marginSummary.totalMarginUsed);
        // Available balance = equity - margin used
        const availableBalance = equity - totalMarginUsed;

        // Calculate unrealized PnL from positions
        const unrealizedPnl = accountState.assetPositions.reduce((sum, pos) => {
          return sum + parseFloat(pos.position.unrealizedPnl);
        }, 0);

        // Get peak equity from system state if available
        let peakEquity = equity;
        try {
          const systemState = await this.db.getSystemState();
          peakEquity = Math.max(equity, systemState.peakEquity || equity);
        } catch {
          // System state might not be available, use current equity
        }

        const drawdownPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;

        await this.db.insertAccountSnapshot(
          equity,
          availableBalance,
          totalMarginUsed,
          unrealizedPnl,
          0, // realizedPnl24h - would need trade history to calculate
          peakEquity,
          drawdownPct
        );

        this.emit('accountSnapshot', { equity, availableBalance, totalMarginUsed, unrealizedPnl, drawdownPct });
      } catch (error) {
        console.error('[DataCollector] Failed to fetch account snapshot:', error);
      }
    };

    // Delay initial fetch to let account state be established first
    setTimeout(() => {
      console.log('[DataCollector] Starting account snapshot collection...');
      fetchAccountSnapshot()
        .then(() => this.recordSuccess('accountSnapshot'))
        .catch((error) => {
          console.error('[DataCollector] Error fetching account snapshot:', error);
          this.recordFailure('accountSnapshot');
        });
    }, 60000); // Start after 1 minute

    // Fetch every 5 minutes
    const interval = setInterval(() => {
      if (this.isCircuitOpen('accountSnapshot')) {
        console.warn('[DataCollector] Skipping account snapshot - circuit breaker open');
        return;
      }
      fetchAccountSnapshot()
        .then(() => this.recordSuccess('accountSnapshot'))
        .catch((error) => {
          console.error('[DataCollector] Error fetching account snapshot:', error);
          this.recordFailure('accountSnapshot');
        });
    }, 5 * 60 * 1000);

    this.candleIntervals.set('accountSnapshot', interval);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Track failures for circuit breaker pattern
  private recordFailure(operation: string): boolean {
    const count = (this.consecutiveFailures.get(operation) || 0) + 1;
    this.consecutiveFailures.set(operation, count);

    if (count >= this.MAX_CONSECUTIVE_FAILURES) {
      console.error(`[DataCollector] Circuit breaker triggered for ${operation} after ${count} consecutive failures`);
      this.emit('circuitBreaker', { operation, failures: count });

      // Auto-reset after interval
      setTimeout(() => {
        console.log(`[DataCollector] Resetting circuit breaker for ${operation}`);
        this.consecutiveFailures.set(operation, 0);
      }, this.FAILURE_RESET_INTERVAL);

      return true; // Circuit is open
    }
    return false;
  }

  private recordSuccess(operation: string): void {
    this.consecutiveFailures.set(operation, 0);
  }

  private isCircuitOpen(operation: string): boolean {
    return (this.consecutiveFailures.get(operation) || 0) >= this.MAX_CONSECUTIVE_FAILURES;
  }
}
