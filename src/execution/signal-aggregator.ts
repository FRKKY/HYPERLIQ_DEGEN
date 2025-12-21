import { Signal, StrategyAllocation, StrategyName, Position, Environment, StrategyVersion } from '../types';
import { BaseStrategy } from '../strategies/base-strategy';
import { Database } from '../data/database';
import { OrderManager } from './order-manager';
import { PositionTracker } from './position-tracker';
import { HyperliquidRestClient } from '../hyperliquid';
import { StrategyVersionManager } from '../lifecycle';

interface AggregatedSignal {
  signal: Signal;
  allocation: number;
  priority: number;
  versionId?: number;
  shadowMode: boolean;
}

interface StrategyState {
  strategy: BaseStrategy;
  version?: StrategyVersion;
  shadowMode: boolean;
}

const MIN_24H_VOLUME = 1_000_000; // $1M minimum volume

export class SignalAggregator {
  private strategies: Map<StrategyName, BaseStrategy> = new Map();
  private strategyStates: Map<StrategyName, StrategyState> = new Map();
  private db: Database;
  private orderManager: OrderManager;
  private positionTracker: PositionTracker;
  private client: HyperliquidRestClient;
  private disabledStrategies: Set<StrategyName> = new Set();
  private versionManager: StrategyVersionManager;
  private environment: Environment;

  constructor(
    db: Database,
    orderManager: OrderManager,
    positionTracker: PositionTracker,
    client: HyperliquidRestClient,
    environment: Environment = 'mainnet'
  ) {
    this.db = db;
    this.orderManager = orderManager;
    this.positionTracker = positionTracker;
    this.client = client;
    this.environment = environment;
    this.versionManager = new StrategyVersionManager(db);
  }

  getEnvironment(): Environment {
    return this.environment;
  }

  registerStrategy(strategy: BaseStrategy): void {
    this.strategies.set(strategy.name, strategy);
    this.strategyStates.set(strategy.name, {
      strategy,
      shadowMode: false,
    });
    console.log(`[SignalAggregator] Registered strategy: ${strategy.name}`);
  }

  async loadStrategyVersions(): Promise<void> {
    for (const [strategyName, state] of this.strategyStates) {
      const version = await this.versionManager.getActiveVersion(strategyName, this.environment);
      if (version) {
        const deployment = await this.versionManager.getDeployment(version.id, this.environment);
        state.version = version;
        state.shadowMode = deployment?.shadowMode ?? false;
        console.log(
          `[SignalAggregator] Loaded ${strategyName} v${version.version} (${version.deploymentState}, shadow: ${state.shadowMode})`
        );
      }
    }
  }

  disableStrategy(strategyName: StrategyName): void {
    this.disabledStrategies.add(strategyName);
    console.log(`[SignalAggregator] Disabled strategy: ${strategyName}`);
  }

  enableStrategy(strategyName: StrategyName): void {
    this.disabledStrategies.delete(strategyName);
    console.log(`[SignalAggregator] Enabled strategy: ${strategyName}`);
  }

  setStrategyshadowMode(strategyName: StrategyName, shadowMode: boolean): void {
    const state = this.strategyStates.get(strategyName);
    if (state) {
      state.shadowMode = shadowMode;
      console.log(`[SignalAggregator] Set ${strategyName} shadow mode: ${shadowMode}`);
    }
  }

  isInShadowMode(strategyName: StrategyName): boolean {
    return this.strategyStates.get(strategyName)?.shadowMode ?? false;
  }

  async runCycle(symbols: string[], allocations: StrategyAllocation, equity: number): Promise<void> {
    console.log(`[SignalAggregator] Running cycle for ${symbols.length} symbols (${this.environment})`);

    // Filter symbols by volume
    const eligibleSymbols = await this.filterByVolume(symbols);

    // Collect all signals
    const allSignals: AggregatedSignal[] = [];

    for (const symbol of eligibleSymbols) {
      const symbolSignals = await this.collectSignalsForSymbol(symbol, allocations);
      allSignals.push(...symbolSignals);
    }

    // Resolve conflicts (same symbol, different directions)
    const resolvedSignals = this.resolveConflicts(allSignals);

    // Sort by priority (strength * allocation)
    resolvedSignals.sort((a, b) => b.priority - a.priority);

    // Separate shadow and live signals
    const liveSignals = resolvedSignals.filter((s) => !s.shadowMode);
    const shadowSignals = resolvedSignals.filter((s) => s.shadowMode);

    // Log shadow mode signals without executing
    for (const shadowSignal of shadowSignals) {
      await this.logShadowSignal(shadowSignal);
    }

    // Execute live signals (limited to avoid overexposure)
    const maxNewPositions = Math.max(1, Math.floor((equity / 100) * 2)); // Scale with capital
    let newPositions = 0;

    for (const aggregatedSignal of liveSignals) {
      if (newPositions >= maxNewPositions) break;

      // Skip if already have position in this symbol
      if (this.positionTracker.hasPosition(aggregatedSignal.signal.symbol)) {
        continue;
      }

      // Execute the signal
      const result = await this.orderManager.executeSignal(
        aggregatedSignal.signal,
        aggregatedSignal.allocation,
        equity,
        this.environment,
        aggregatedSignal.versionId
      );

      if (result.success) {
        newPositions++;
      }
    }

    // Check exit conditions for existing positions
    await this.checkExits();

    console.log(
      `[SignalAggregator] Cycle complete. Signals: ${allSignals.length}, Resolved: ${resolvedSignals.length}, ` +
      `Live: ${liveSignals.length}, Shadow: ${shadowSignals.length}, Executed: ${newPositions}`
    );
  }

  private async logShadowSignal(aggregatedSignal: AggregatedSignal): Promise<void> {
    const { signal, versionId } = aggregatedSignal;

    // Log signal with shadow flag for tracking
    await this.db.query(
      `INSERT INTO signals (strategy_name, symbol, signal_time, direction, strength, entry_price, stop_loss, take_profit, metadata, environment, strategy_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        signal.strategyName,
        signal.symbol,
        signal.signalTime,
        signal.direction,
        signal.strength,
        signal.entryPrice,
        signal.stopLoss,
        signal.takeProfit,
        { ...signal.metadata, shadowMode: true },
        this.environment,
        versionId,
      ]
    );

    console.log(
      `[SignalAggregator] Shadow signal logged: ${signal.strategyName} ${signal.direction} ${signal.symbol} @ ${signal.entryPrice}`
    );
  }

  private async filterByVolume(symbols: string[]): Promise<string[]> {
    // For now, return all symbols
    // In production, would check 24h volume from market data
    return symbols;
  }

  private async collectSignalsForSymbol(
    symbol: string,
    allocations: StrategyAllocation
  ): Promise<AggregatedSignal[]> {
    const signals: AggregatedSignal[] = [];

    for (const [strategyName, state] of this.strategyStates) {
      // Skip disabled strategies
      if (this.disabledStrategies.has(strategyName)) continue;

      const allocation = allocations[strategyName];
      if (allocation <= 0) continue;

      try {
        const signal = await state.strategy.generateSignal(symbol);

        if (signal && signal.direction !== 'NONE') {
          signals.push({
            signal,
            allocation,
            priority: signal.strength * allocation,
            versionId: state.version?.id,
            shadowMode: state.shadowMode,
          });
        }
      } catch (error) {
        console.error(`[SignalAggregator] Error generating signal for ${symbol} (${strategyName}):`, error);
      }
    }

    return signals;
  }

  private resolveConflicts(signals: AggregatedSignal[]): AggregatedSignal[] {
    // Group by symbol
    const bySymbol = new Map<string, AggregatedSignal[]>();

    for (const signal of signals) {
      const existing = bySymbol.get(signal.signal.symbol) || [];
      existing.push(signal);
      bySymbol.set(signal.signal.symbol, existing);
    }

    const resolved: AggregatedSignal[] = [];

    for (const [symbol, symbolSignals] of bySymbol) {
      if (symbolSignals.length === 1) {
        resolved.push(symbolSignals[0]);
        continue;
      }

      // Check for conflicting directions
      const longs = symbolSignals.filter((s) => s.signal.direction === 'LONG');
      const shorts = symbolSignals.filter((s) => s.signal.direction === 'SHORT');

      if (longs.length > 0 && shorts.length > 0) {
        // Conflict: pick the stronger signal
        const longPriority = Math.max(...longs.map((s) => s.priority));
        const shortPriority = Math.max(...shorts.map((s) => s.priority));

        if (longPriority > shortPriority * 1.5) {
          // Strong long preference
          resolved.push(longs.reduce((a, b) => (a.priority > b.priority ? a : b)));
        } else if (shortPriority > longPriority * 1.5) {
          // Strong short preference
          resolved.push(shorts.reduce((a, b) => (a.priority > b.priority ? a : b)));
        }
        // If neither is significantly stronger, skip this symbol
      } else {
        // No conflict, pick the strongest signal
        resolved.push(symbolSignals.reduce((a, b) => (a.priority > b.priority ? a : b)));
      }
    }

    return resolved;
  }

  private async checkExits(): Promise<void> {
    const positions = this.positionTracker.getAllPositions();

    for (const position of positions) {
      const strategy = this.strategies.get(position.strategyName);
      if (!strategy) continue;

      try {
        // Get current price
        const mids = await this.client.getAllMids();
        const currentPrice = parseFloat(mids[position.symbol]);
        if (!currentPrice) continue;

        // Check stop loss
        if (position.side === 'LONG' && currentPrice <= (position as any).stopLoss) {
          await this.orderManager.closePosition(position.symbol, 'Stop loss hit');
          continue;
        }
        if (position.side === 'SHORT' && currentPrice >= (position as any).stopLoss) {
          await this.orderManager.closePosition(position.symbol, 'Stop loss hit');
          continue;
        }

        // Check take profit
        if (position.side === 'LONG' && currentPrice >= (position as any).takeProfit) {
          await this.orderManager.closePosition(position.symbol, 'Take profit hit');
          continue;
        }
        if (position.side === 'SHORT' && currentPrice <= (position as any).takeProfit) {
          await this.orderManager.closePosition(position.symbol, 'Take profit hit');
          continue;
        }

        // Check strategy-specific exit conditions
        const exitCheck = await strategy.shouldExit(position, currentPrice);
        if (exitCheck.shouldExit) {
          await this.orderManager.closePosition(position.symbol, exitCheck.reason || 'Strategy exit');
        }
      } catch (error) {
        console.error(`[SignalAggregator] Error checking exit for ${position.symbol}:`, error);
      }
    }
  }
}
