import { HyperliquidRestClient } from '../hyperliquid';
import { Database } from '../data/database';
import { Position, StrategyName } from '../types';

export class PositionTracker {
  private client: HyperliquidRestClient;
  private db: Database;
  private positions: Map<string, Position> = new Map();
  private strategyPositionMap: Map<string, StrategyName> = new Map();

  constructor(client: HyperliquidRestClient, db: Database) {
    this.client = client;
    this.db = db;
  }

  async initialize(): Promise<void> {
    await this.syncPositions();
  }

  async syncPositions(): Promise<void> {
    const accountState = await this.client.getAccountState();

    this.positions.clear();

    for (const pos of accountState.assetPositions) {
      const size = parseFloat(pos.position.szi);
      if (size !== 0) {
        const symbol = pos.position.coin;
        const position: Position = {
          symbol,
          side: size > 0 ? 'LONG' : 'SHORT',
          size: Math.abs(size),
          entryPrice: parseFloat(pos.position.entryPx),
          leverage: pos.position.leverage.value,
          liquidationPrice: pos.position.liquidationPx ? parseFloat(pos.position.liquidationPx) : undefined,
          unrealizedPnl: parseFloat(pos.position.unrealizedPnl),
          marginUsed: parseFloat(pos.position.marginUsed),
          strategyName: this.strategyPositionMap.get(symbol) || 'funding_signal',
          openedAt: new Date(), // We don't have this from the API, would need to track separately
        };

        this.positions.set(symbol, position);
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

  clearPositionStrategy(symbol: string): void {
    this.strategyPositionMap.delete(symbol);
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
