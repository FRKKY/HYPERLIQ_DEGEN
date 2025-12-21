import express, { Application, Request, Response, NextFunction } from 'express';
import { createServer, Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { Database } from '../data/database';
import { Position, StrategyAllocation } from '../types';
import {
  logger,
  healthChecker,
  apiKeyAuth,
  ipRateLimit,
  corsMiddleware,
  hashApiKey,
  validateQuery,
  paginationSchema,
  timeRangeSchema,
  SystemHealth,
} from '../utils';

interface SystemController {
  getAccountState(): Promise<{
    equity: number;
    availableBalance: number;
    unrealizedPnl: number;
    drawdownPct: number;
    peakEquity: number;
  }>;
  getPositions(): Promise<Position[]>;
  resumeTrading(): Promise<void>;
  stopTrading(): Promise<void>;
}

export class DashboardServer {
  private app: Application;
  private httpServer: HttpServer;
  private io: SocketIOServer;
  private db: Database;
  private systemController: SystemController | null = null;
  private apiKeyHash: string;

  constructor(port: number, db: Database) {
    this.app = express();
    this.httpServer = createServer(this.app);

    // Get API key from environment or generate one
    const apiKey = process.env.DASHBOARD_API_KEY;
    if (!apiKey) {
      logger.warn('Dashboard', 'No DASHBOARD_API_KEY set, using default (INSECURE for production)');
      this.apiKeyHash = hashApiKey('default-dev-key');
    } else {
      this.apiKeyHash = hashApiKey(apiKey);
    }

    // Configure allowed origins from environment
    const allowedOrigins = process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
      : ['http://localhost:3000', 'http://127.0.0.1:3000'];

    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });
    this.db = db;

    this.setupMiddleware(allowedOrigins);
    this.setupRoutes();
    this.setupWebSocket();
    this.httpServer.listen(port, () => {
      logger.info('Dashboard', `Server running on port ${port}`);
    });
  }

  setSystemController(controller: SystemController): void {
    this.systemController = controller;
  }

  private setupMiddleware(allowedOrigins: string[]): void {
    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      res.on('finish', () => {
        logger.api(req.method, req.path, res.statusCode, Date.now() - start, {
          ip: req.ip,
        });
      });
      next();
    });

    // CORS
    this.app.use(
      corsMiddleware({
        allowedOrigins,
        allowedMethods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
        maxAge: 86400,
      })
    );

    // Rate limiting - 100 requests per minute per IP
    this.app.use(ipRateLimit(100, 60000));

    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));

    // Error handling middleware
    this.app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
      logger.error('Dashboard', 'Unhandled error', {
        error: err.message,
        path: req.path,
        method: req.method,
      });
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    });
  }

  private setupRoutes(): void {
    // Public health check (no auth required)
    this.app.get('/health', async (req: Request, res: Response) => {
      try {
        const health = await healthChecker.checkAll();
        const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
        res.status(statusCode).json(health);
      } catch (error) {
        res.status(503).json({
          status: 'unhealthy',
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Liveness probe (simple check)
    this.app.get('/health/live', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Readiness probe (checks dependencies)
    this.app.get('/health/ready', async (req: Request, res: Response) => {
      try {
        const dbHealth = await healthChecker.checkComponent('database');
        if (dbHealth.status === 'unhealthy') {
          res.status(503).json({ status: 'not ready', reason: 'Database unavailable' });
          return;
        }
        res.json({ status: 'ready', timestamp: new Date().toISOString() });
      } catch (error) {
        res.status(503).json({ status: 'not ready', error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Protected API endpoints
    const authMiddleware = apiKeyAuth(this.apiKeyHash);

    this.app.get('/api/status', authMiddleware, async (req: Request, res: Response) => {
      try {
        const state = await this.db.getSystemState();
        let account = { equity: 0, availableBalance: 0, unrealizedPnl: 0, drawdownPct: 0, peakEquity: 0 };
        if (this.systemController) {
          account = await this.systemController.getAccountState();
        }
        res.json({ state, account });
      } catch (error) {
        logger.error('Dashboard', 'Failed to get status', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        res.status(500).json({ error: 'Failed to get status', code: 'INTERNAL_ERROR' });
      }
    });

    this.app.get('/api/positions', authMiddleware, async (req: Request, res: Response) => {
      try {
        if (this.systemController) {
          const positions = await this.systemController.getPositions();
          res.json(positions);
        } else {
          res.json([]);
        }
      } catch (error) {
        logger.error('Dashboard', 'Failed to get positions', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        res.status(500).json({ error: 'Failed to get positions', code: 'INTERNAL_ERROR' });
      }
    });

    this.app.get(
      '/api/trades',
      authMiddleware,
      validateQuery(paginationSchema),
      async (req: Request, res: Response) => {
        try {
          const { limit } = (req as any).validatedQuery;
          const trades = await this.db.getRecentTrades(limit);
          res.json(trades);
        } catch (error) {
          logger.error('Dashboard', 'Failed to get trades', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          res.status(500).json({ error: 'Failed to get trades', code: 'INTERNAL_ERROR' });
        }
      }
    );

    this.app.get('/api/performance', authMiddleware, async (req: Request, res: Response) => {
      try {
        const performance = await this.db.getStrategyPerformances(24);
        res.json(performance);
      } catch (error) {
        logger.error('Dashboard', 'Failed to get performance', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        res.status(500).json({ error: 'Failed to get performance', code: 'INTERNAL_ERROR' });
      }
    });

    this.app.get(
      '/api/mcl-decisions',
      authMiddleware,
      validateQuery(paginationSchema),
      async (req: Request, res: Response) => {
        try {
          const { limit } = (req as any).validatedQuery;
          const decisions = await this.db.getRecentMCLDecisions(limit);
          res.json(decisions);
        } catch (error) {
          logger.error('Dashboard', 'Failed to get MCL decisions', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          res.status(500).json({ error: 'Failed to get MCL decisions', code: 'INTERNAL_ERROR' });
        }
      }
    );

    this.app.get(
      '/api/equity-history',
      authMiddleware,
      validateQuery(timeRangeSchema),
      async (req: Request, res: Response) => {
        try {
          const { hours } = (req as any).validatedQuery;
          const history = await this.db.getEquityHistory(hours);
          res.json(history);
        } catch (error) {
          logger.error('Dashboard', 'Failed to get equity history', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          res.status(500).json({ error: 'Failed to get equity history', code: 'INTERNAL_ERROR' });
        }
      }
    );

    this.app.get('/api/alerts', authMiddleware, async (req: Request, res: Response) => {
      try {
        const alerts = await this.db.getUnacknowledgedAlerts();
        res.json(alerts);
      } catch (error) {
        logger.error('Dashboard', 'Failed to get alerts', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        res.status(500).json({ error: 'Failed to get alerts', code: 'INTERNAL_ERROR' });
      }
    });

    // Action endpoints - require authentication
    this.app.post('/api/action/go', authMiddleware, async (req: Request, res: Response) => {
      try {
        if (this.systemController) {
          logger.audit('Resume trading', req.ip || 'unknown');
          await this.systemController.resumeTrading();
          res.json({ success: true });
        } else {
          res.status(500).json({ success: false, error: 'System controller not available', code: 'NOT_READY' });
        }
      } catch (error) {
        logger.error('Dashboard', 'Failed to resume trading', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        res.status(500).json({ success: false, error: (error as Error).message, code: 'ACTION_FAILED' });
      }
    });

    this.app.post('/api/action/stop', authMiddleware, async (req: Request, res: Response) => {
      try {
        if (this.systemController) {
          logger.audit('Stop trading', req.ip || 'unknown');
          await this.systemController.stopTrading();
          res.json({ success: true });
        } else {
          res.status(500).json({ success: false, error: 'System controller not available', code: 'NOT_READY' });
        }
      } catch (error) {
        logger.error('Dashboard', 'Failed to stop trading', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        res.status(500).json({ success: false, error: (error as Error).message, code: 'ACTION_FAILED' });
      }
    });
  }

  private setupWebSocket(): void {
    // WebSocket authentication
    this.io.use((socket, next) => {
      const apiKey = socket.handshake.auth.apiKey || socket.handshake.headers['x-api-key'];
      if (!apiKey) {
        logger.warn('Dashboard', 'WebSocket connection rejected: no API key', {
          ip: socket.handshake.address,
        });
        next(new Error('Authentication required'));
        return;
      }

      const providedHash = hashApiKey(apiKey);
      if (providedHash !== this.apiKeyHash) {
        logger.warn('Dashboard', 'WebSocket connection rejected: invalid API key', {
          ip: socket.handshake.address,
        });
        next(new Error('Invalid API key'));
        return;
      }

      next();
    });

    this.io.on('connection', (socket) => {
      logger.info('Dashboard', 'Client connected', { id: socket.id });

      // Send initial state
      this.sendFullState(socket);

      socket.on('disconnect', () => {
        logger.info('Dashboard', 'Client disconnected', { id: socket.id });
      });
    });
  }

  private async sendFullState(socket: any): Promise<void> {
    try {
      const state = await this.db.getSystemState();
      let account = { equity: 0, availableBalance: 0, unrealizedPnl: 0, drawdownPct: 0, peakEquity: 0 };
      let positions: Position[] = [];

      if (this.systemController) {
        account = await this.systemController.getAccountState();
        positions = await this.systemController.getPositions();
      }

      socket.emit('fullState', { state, account, positions });
    } catch (error) {
      logger.error('Dashboard', 'Error sending full state', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Call this when state changes to push updates
  broadcastUpdate(updateType: string, data: any): void {
    this.io.emit(updateType, data);
  }

  stop(): void {
    this.httpServer.close();
    logger.info('Dashboard', 'Server stopped');
  }
}
