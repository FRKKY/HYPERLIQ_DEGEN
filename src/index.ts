import cron from 'node-cron';
import { loadConfig } from './config';
import { Database } from './data/database';
import { DataCollector } from './data/data-collector';
import { HyperliquidAuth, HyperliquidRestClient, HyperliquidWebSocket } from './hyperliquid';
import {
  FundingSignalStrategy,
  MomentumBreakoutStrategy,
  MeanReversionStrategy,
  TrendFollowStrategy,
} from './strategies';
import { OrderManager, PositionTracker, RiskManager, SignalAggregator } from './execution';
import { MCLOrchestrator } from './mcl';
import { AlertManager, TradingTelegramBot, DashboardServer } from './monitoring';
import { StrategyPromoter } from './lifecycle';
import { Position, PauseAnalysis, Environment } from './types';
import { logger } from './utils';

class TradingSystem {
  private db!: Database;
  private auth!: HyperliquidAuth;
  private restClient!: HyperliquidRestClient;
  private wsClient!: HyperliquidWebSocket;
  private dataCollector!: DataCollector;
  private positionTracker!: PositionTracker;
  private riskManager!: RiskManager;
  private orderManager!: OrderManager;
  private signalAggregator!: SignalAggregator;
  private mclOrchestrator!: MCLOrchestrator;
  private alertManager!: AlertManager;
  private telegramBot?: TradingTelegramBot;
  private dashboardServer!: DashboardServer;
  private strategyPromoter!: StrategyPromoter;
  private environment!: Environment;

  async initialize(): Promise<void> {
    logger.info('System', 'Initializing trading system...');

    const config = loadConfig();

    // Determine environment
    this.environment = config.hyperliquid.useTestnet ? 'testnet' : 'mainnet';
    logger.info('System', `Running in ${this.environment} mode`);

    // Initialize database
    this.db = new Database(config.database.url);
    await this.db.connect();

    // Initialize Hyperliquid clients
    this.auth = new HyperliquidAuth(config.hyperliquid.privateKey, config.hyperliquid.useTestnet);
    logger.info('System', `Wallet address (derived from private key): ${this.auth.address}`);
    logger.info('System', `Configured wallet address: ${config.hyperliquid.walletAddress}`);
    if (this.auth.address.toLowerCase() !== config.hyperliquid.walletAddress.toLowerCase()) {
      logger.warn('System', 'Derived address does not match configured HL_WALLET_ADDRESS!');
    }
    this.restClient = new HyperliquidRestClient(this.auth, config.hyperliquid.useTestnet);
    await this.restClient.initialize();

    // CRITICAL: Get account state FIRST before any other API calls
    // This must happen before data collector starts flooding the API
    await this.initializeSystemState(config.trading.initialCapital);

    this.wsClient = new HyperliquidWebSocket(config.hyperliquid.useTestnet);

    // Initialize data collector (will start later, after system is ready)
    this.dataCollector = new DataCollector(this.restClient, this.wsClient, this.db);

    // Initialize execution components
    this.positionTracker = new PositionTracker(this.restClient, this.db);
    await this.positionTracker.initialize();

    this.riskManager = new RiskManager(this.db, this.positionTracker);
    this.orderManager = new OrderManager(this.restClient, this.db, this.riskManager, this.positionTracker);
    this.signalAggregator = new SignalAggregator(this.db, this.orderManager, this.positionTracker, this.restClient, this.environment);

    // Initialize strategy lifecycle management
    this.strategyPromoter = new StrategyPromoter(this.db);

    // Register strategies
    this.signalAggregator.registerStrategy(new FundingSignalStrategy(this.db));
    this.signalAggregator.registerStrategy(new MomentumBreakoutStrategy(this.db));
    this.signalAggregator.registerStrategy(new MeanReversionStrategy(this.db));
    this.signalAggregator.registerStrategy(new TrendFollowStrategy(this.db));

    // Load strategy versions from database
    await this.signalAggregator.loadStrategyVersions();

    // Initialize MCL
    this.mclOrchestrator = new MCLOrchestrator(
      config.anthropic.apiKey,
      this.db,
      this.restClient,
      this.positionTracker,
      this.signalAggregator,
      this.orderManager
    );

    // Initialize monitoring
    this.alertManager = new AlertManager(this.db);

    // Telegram bot is optional
    if (config.telegram.botToken && config.telegram.chatId) {
      this.telegramBot = new TradingTelegramBot(config.telegram.botToken, config.telegram.chatId, this.db);
      this.telegramBot.setSystemController(this.createSystemController());
      this.alertManager.setTelegramBot(this.telegramBot);
      logger.info('System', 'Telegram bot enabled');
    } else {
      logger.info('System', 'Telegram bot disabled (no credentials)');
    }

    this.dashboardServer = new DashboardServer(config.app.port, this.db);
    this.dashboardServer.setSystemController(this.createSystemController());

    logger.info('System', 'Initialization complete');
  }

  private async initializeSystemState(configInitialCapital: number): Promise<void> {
    try {
      // Get actual account equity from Hyperliquid
      logger.info('System', 'Fetching account state from Hyperliquid...');
      const accountState = await this.restClient.getAccountState();
      logger.debug('System', 'Account state received', { marginSummary: accountState.marginSummary });
      const equity = parseFloat(accountState.marginSummary.accountValue);

      if (isNaN(equity) || equity <= 0) {
        logger.warn('System', 'Could not get valid equity, using config value', { configInitialCapital });
        await this.db.updateSystemState('peak_equity', configInitialCapital);
        await this.db.updateSystemState('daily_start_equity', configInitialCapital);
      } else {
        logger.info('System', `Account equity: $${equity.toFixed(2)}`);
        await this.db.updateSystemState('peak_equity', equity);
        await this.db.updateSystemState('daily_start_equity', equity);
      }

      // Re-enable trading (in case it was paused from previous bad state)
      await this.db.updateSystemState('trading_enabled', true);
      await this.db.updateSystemState('system_status', 'RUNNING');
      await this.db.updateSystemState('pause_reason', null);
    } catch (error) {
      logger.warn('System', 'Could not initialize equity, using config value', { configInitialCapital });
      await this.db.updateSystemState('peak_equity', configInitialCapital);
      await this.db.updateSystemState('daily_start_equity', configInitialCapital);
    }
  }

  private createSystemController() {
    return {
      getAccountState: async () => {
        const state = await this.restClient.getAccountState();
        const systemState = await this.db.getSystemState();
        const equity = parseFloat(state.marginSummary.accountValue);
        return {
          equity,
          availableBalance: equity - parseFloat(state.marginSummary.totalMarginUsed),
          unrealizedPnl: this.positionTracker.getTotalUnrealizedPnl(),
          drawdownPct: ((equity - systemState.peakEquity) / systemState.peakEquity) * 100,
          peakEquity: systemState.peakEquity,
        };
      },
      getPositions: async (): Promise<Position[]> => {
        return this.positionTracker.getAllPositions();
      },
      resumeTrading: async () => {
        await this.riskManager.resumeTrading();
        logger.info('System', 'Trading resumed');
      },
      stopTrading: async () => {
        await this.orderManager.closeAllPositions('Manual stop');
        await this.db.updateSystemState('trading_enabled', false);
        await this.db.updateSystemState('system_status', 'STOPPED');
        logger.info('System', 'Trading stopped');
      },
      generatePauseAnalysis: async (): Promise<PauseAnalysis> => {
        const systemState = await this.db.getSystemState();
        const recentTrades = await this.db.getRecentTrades(10);

        return {
          whatHappened: `System paused due to: ${systemState.pauseReason}`,
          rootCause: 'Risk threshold exceeded. Review recent trades and market conditions.',
          mclAssessment: `Last MCL run: ${systemState.lastMclRun?.toISOString() || 'Never'}. Allocations: ${JSON.stringify(systemState.currentAllocations)}`,
        };
      },
    };
  }

  async start(): Promise<void> {
    logger.info('System', 'Starting trading system...');

    const config = loadConfig();

    // Start data collection (limit symbols on testnet to avoid rate limits)
    const isTestnet = this.environment === 'testnet';
    await this.dataCollector.start(undefined, isTestnet);

    // Schedule trading cycle (every minute)
    cron.schedule('* * * * *', async () => {
      await this.runTradingCycle();
    });

    // Schedule MCL evaluation (every hour at minute 0)
    cron.schedule(`0 */${config.trading.mclIntervalMinutes} * * *`, async () => {
      await this.runMCLCycle();
    });

    // Schedule daily report
    const [hour, minute] = config.trading.reportTimeUtc.split(':');
    cron.schedule(`${minute} ${hour} * * *`, async () => {
      await this.generateDailyReport();
    });

    // Schedule daily metrics reset (midnight UTC)
    cron.schedule('0 0 * * *', async () => {
      const state = await this.restClient.getAccountState();
      const equity = parseFloat(state.marginSummary.accountValue);
      await this.riskManager.resetDailyMetrics(equity);
    });

    // Schedule account snapshot (every 5 minutes)
    cron.schedule('*/5 * * * *', async () => {
      await this.takeAccountSnapshot();
    });

    // Schedule position sync (every 30 seconds)
    setInterval(async () => {
      await this.positionTracker.syncPositions();
    }, 30000);

    // Send startup notification
    await this.alertManager.send({
      alertTime: new Date(),
      alertType: 'SYSTEM_START',
      severity: 'INFO',
      title: 'Trading System Started',
      message: `System initialized and running. Initial capital: $${config.trading.initialCapital}`,
      requiresAction: false,
    });

    logger.info('System', 'Trading system started');
  }

  private async runTradingCycle(): Promise<void> {
    try {
      const systemState = await this.db.getSystemState();
      if (!systemState.tradingEnabled) {
        return;
      }

      // Get account state for equity
      let equity: number;
      try {
        const accountState = await this.restClient.getAccountState();
        equity = parseFloat(accountState.marginSummary.accountValue);
      } catch (error) {
        logger.debug('System', 'Skipping trading cycle - could not get account state');
        return;
      }

      // Validate equity before proceeding
      if (isNaN(equity) || equity <= 0) {
        logger.debug('System', 'Skipping trading cycle - invalid equity', { equity });
        return;
      }

      // Run continuous risk checks
      const riskCheck = await this.riskManager.runContinuousChecks(equity);

      // Send any alerts
      for (const alert of riskCheck.alerts) {
        await this.alertManager.send(alert);
      }

      if (riskCheck.shouldPause) {
        return; // Trading paused by risk manager
      }

      // Get symbols and current allocations
      const symbols = this.restClient.getAllSymbols();
      const allocations = await this.db.getCurrentAllocations();

      // Run signal aggregator
      await this.signalAggregator.runCycle(symbols, allocations, equity);
    } catch (error) {
      logger.error('System', 'Error in trading cycle', { error: error instanceof Error ? error.message : 'Unknown' });
    }
  }

  private async runMCLCycle(): Promise<void> {
    try {
      const systemState = await this.db.getSystemState();
      if (systemState.systemStatus === 'PAUSED' || systemState.systemStatus === 'STOPPED') {
        return;
      }

      logger.info('System', 'Running MCL evaluation...');
      const decision = await this.mclOrchestrator.runCycle();

      if (decision) {
        await this.alertManager.sendMCLAlert(
          decision.reasoning.substring(0, 100),
          decision.finalAllocations
        );

        // Broadcast update to dashboard
        this.dashboardServer.broadcastUpdate('mclDecision', decision);
      }
    } catch (error) {
      logger.error('System', 'Error in MCL cycle', { error: error instanceof Error ? error.message : 'Unknown' });
    }
  }

  private async takeAccountSnapshot(): Promise<void> {
    try {
      const accountState = await this.restClient.getAccountState();
      const systemState = await this.db.getSystemState();

      const equity = parseFloat(accountState.marginSummary.accountValue);
      const totalMarginUsed = parseFloat(accountState.marginSummary.totalMarginUsed);
      const unrealizedPnl = this.positionTracker.getTotalUnrealizedPnl();
      const drawdownPct = ((equity - systemState.peakEquity) / systemState.peakEquity) * 100;

      // Calculate 24h realized P&L
      const recentTrades = await this.db.getRecentTrades(100);
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const realizedPnl24h = recentTrades
        .filter((t) => t.executedAt.getTime() > oneDayAgo && t.pnl !== undefined)
        .reduce((sum, t) => sum + (t.pnl || 0), 0);

      await this.db.insertAccountSnapshot(
        equity,
        equity - totalMarginUsed,
        totalMarginUsed,
        unrealizedPnl,
        realizedPnl24h,
        Math.max(equity, systemState.peakEquity),
        drawdownPct
      );

      // Broadcast update to dashboard
      this.dashboardServer.broadcastUpdate('accountUpdate', {
        equity,
        availableBalance: equity - totalMarginUsed,
        unrealizedPnl,
        drawdownPct,
      });
    } catch (error) {
      logger.error('System', 'Error taking account snapshot', { error: error instanceof Error ? error.message : 'Unknown' });
    }
  }

  private async generateDailyReport(): Promise<void> {
    try {
      logger.info('System', 'Generating daily report...');

      const systemState = await this.db.getSystemState();
      const accountState = await this.restClient.getAccountState();
      const equity = parseFloat(accountState.marginSummary.accountValue);
      const performances = await this.db.getStrategyPerformances(24);
      const mclDecisions = await this.db.getRecentMCLDecisions(24);
      const positions = this.positionTracker.getAllPositions();

      const report = {
        date: new Date().toISOString().split('T')[0],
        startEquity: systemState.dailyStartEquity,
        endEquity: equity,
        pnlChange: equity - systemState.dailyStartEquity,
        pnlChangePct: ((equity - systemState.dailyStartEquity) / systemState.dailyStartEquity) * 100,
        peakEquity: systemState.peakEquity,
        drawdownPct: ((equity - systemState.peakEquity) / systemState.peakEquity) * 100,
        strategyPerformances: performances.map((p) => ({
          name: p.strategyName,
          pnl: p.totalPnl,
          trades: p.totalTrades,
          wins: p.winningTrades,
          losses: p.losingTrades,
        })),
        mclDecisions: mclDecisions.map((d) => d.reasoning.substring(0, 50)),
        openPositions: positions.length,
        allocations: systemState.currentAllocations,
        systemHealth: systemState.systemStatus,
        dashboardUrl: `http://localhost:${process.env.PORT || 3000}`,
      };

      if (this.telegramBot) {
        await this.telegramBot.sendDailyReport(report);
      }
      logger.info('System', 'Daily report sent');
    } catch (error) {
      logger.error('System', 'Error generating daily report', { error: error instanceof Error ? error.message : 'Unknown' });
    }
  }

  async stop(): Promise<void> {
    logger.info('System', 'Stopping trading system...');

    this.dataCollector.stop();
    if (this.telegramBot) {
      this.telegramBot.stop();
    }
    this.dashboardServer.stop();
    await this.db.disconnect();

    logger.info('System', 'Trading system stopped');
  }
}

// Run migrations inline
async function runMigrations(): Promise<void> {
  const { Pool } = await import('pg');
  const { readFileSync, readdirSync } = await import('fs');
  const { join } = await import('path');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL not set');
  }

  // Log connection attempt (mask password)
  const maskedUrl = databaseUrl.replace(/:[^:@]+@/, ':***@');
  logger.info('Migrations', `Connecting to: ${maskedUrl}`);
  logger.debug('Migrations', `NODE_ENV: ${process.env.NODE_ENV}`);

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10000, // 10 second timeout
  });

  logger.debug('Migrations', 'Pool created, attempting connection...');

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const result = await pool.query('SELECT filename FROM schema_migrations');
    const executed = new Set(result.rows.map((r: { filename: string }) => r.filename));

    const migrationsDir = join(__dirname, '..', 'migrations');
    const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    logger.info('Migrations', `Found ${files.length} migration files`);

    for (const file of files) {
      if (executed.has(file)) {
        logger.debug('Migrations', `Skipping ${file} (already executed)`);
        continue;
      }

      logger.info('Migrations', `Running: ${file}`);
      const sql = readFileSync(join(migrationsDir, file), 'utf-8');

      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await pool.query('COMMIT');
        logger.info('Migrations', `Completed: ${file}`);
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
    }

    logger.info('Migrations', 'All migrations completed');
  } finally {
    await pool.end();
  }
}

// Main entry point
async function main() {
  logger.info('System', 'Starting...');

  // Run migrations first
  try {
    await runMigrations();
  } catch (error) {
    logger.error('System', 'Migration failed', { error: error instanceof Error ? error.message : 'Unknown' });
    process.exit(1);
  }

  const system = new TradingSystem();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('System', 'Received SIGINT, shutting down...');
    await system.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('System', 'Received SIGTERM, shutting down...');
    await system.stop();
    process.exit(0);
  });

  try {
    await system.initialize();
    await system.start();
  } catch (error) {
    logger.error('System', 'Fatal error', { error: error instanceof Error ? error.message : 'Unknown' });
    process.exit(1);
  }
}

main();
