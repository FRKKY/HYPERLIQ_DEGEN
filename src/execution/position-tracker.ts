import { HyperliquidRestClient } from '../hyperliquid';
import { Database } from '../data/database';
import { Position, StrategyName, PositionStrategyName } from '../types';

export class PositionTracker {
  private client: HyperliquidRestClient;
  private db: Database;
  private positions: Map<string, Position> = new Map();
  private strategyPositionMap: Map<string, PositionStrategyName> = new Map();
  // Track when positions were actually opened (not when we synced them)
  private positionOpenTimes: Map<string, Date> = new Map();

  constructor(client: HyperliquidRestClient, db: Database) {
    this.client = client;
    this.db = db;
  }

  async initialize(): Promise<void> {
    await this.syncPositions();
  }

  async syncPositions(): Promise<void> {
    const accountState = await this.client.getAccountState();

    // Track which symbols we currently have positions in
    const currentSymbols = new Set<string>();

    for (const pos of accountState.assetPositions) {
      const size = parseFloat(pos.position.szi);
      if (size !== 0) {
        const symbol = pos.position.coin;
        currentSymbols.add(symbol);

        // Use tracked open time, or current time if this is a new position we haven't seen
        let openedAt = this.positionOpenTimes.get(symbol);
        if (!openedAt) {
          // This is a position we're seeing for the first time (either on startup or opened elsewhere)
          openedAt = new Date();
          this.positionOpenTimes.set(symbol, openedAt);
        }

        const position: Position = {
          symbol,
          side: size > 0 ? 'LONG' : 'SHORT',
          size: Math.abs(size),
          entryPrice: parseFloat(pos.position.entryPx),
          leverage: pos.position.leverage.value,
          liquidationPrice: pos.position.liquidationPx ? parseFloat(pos.position.liquidationPx) : undefined,
          unrealizedPnl: parseFloat(pos.position.unrealizedPnl),
          marginUsed: parseFloat(pos.position.marginUsed),
          // Use 'unknown' if strategy not tracked - don't assume funding_signal
          strategyName: this.strategyPositionMap.get(symbol) || 'unknown',
          openedAt,
        };

        this.positions.set(symbol, position);
      }
    }

    // Clean up positions that no longer exist
    for (const symbol of this.positions.keys()) {
      if (!currentSymbols.has(symbol)) {
        this.positions.delete(symbol);
        this.positionOpenTimes.delete(symbol);
        this.strategyPositionMap.delete(symbol);
      }
    }

    // Sync to database
    await this.db.syncPositions([...this.positions.values()]);
  }

  async updatePosition(symbol: string): Promise<void> {
    await this.syncPositions();
  }

  setPositionStrategy(symbol: string, strategyName: StrategyName): void {
    this.strategyPositionMap.set(symbol, strategyName);
  }

  // Track when a position is opened (called by OrderManager after successful order)
  setPositionOpenTime(symbol: string, openTime: Date): void {
    this.positionOpenTimes.set(symbol, openTime);
  }

  clearPositionStrategy(symbol: string): void {
    this.strategyPositionMap.delete(symbol);
    this.positionOpenTimes.delete(symbol);
  }

  getPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  getAllPositions(): Position[] {
    return [...this.positions.values()];
  }

  getPositionsByStrategy(strategyName: StrategyName): Position[] {
    return [...this.positions.values()].filter((p) => p.strategyName === strategyName);
  }

  hasPosition(symbol: string): boolean {
    return this.positions.has(symbol);
  }

  getTotalUnrealizedPnl(): number {
    return [...this.positions.values()].reduce((sum, p) => sum + p.unrealizedPnl, 0);
  }

  getTotalMarginUsed(): number {
    return [...this.positions.values()].reduce((sum, p) => sum + p.marginUsed, 0);
  }

  getPositionCount(): number {
    return this.positions.size;
  }
}
