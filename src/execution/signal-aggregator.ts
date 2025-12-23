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

interface ExecutionStats {
  consecutiveFailures: number;
  lastFailureTime?: Date;
  totalFailures: number;
  totalSuccesses: number;
}

const MIN_24H_VOLUME = 1_000_000; // $1M minimum volume
const MAX_CONSECUTIVE_FAILURES = 5;

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
  // Track execution failures per strategy for alerting
  private executionStats: Map<StrategyName, ExecutionStats> = new Map();

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
    let failedExecutions = 0;

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
        this.recordExecutionSuccess(aggregatedSignal.signal.strategyName);
      } else {
        failedExecutions++;
        const shouldAlert = this.recordExecutionFailure(aggregatedSignal.signal.strategyName, result.reason || 'Unknown');

        if (shouldAlert) {
          console.error(`[SignalAggregator] ALERT: Strategy ${aggregatedSignal.signal.strategyName} has ${MAX_CONSECUTIVE_FAILURES}+ consecutive execution failures`);
          // Log alert to database
          await this.db.insertAlert({
            alertTime: new Date(),
            alertType: 'EXECUTION_FAILURES',
            severity: 'WARNING',
            title: 'Strategy Execution Failures',
            message: `Strategy ${aggregatedSignal.signal.strategyName} has failed ${MAX_CONSECUTIVE_FAILURES}+ times consecutively. Last error: ${result.reason}`,
            requiresAction: true,
          });
        }
      }
    }

    if (failedExecutions > 0) {
      console.warn(`[SignalAggregator] ${failedExecutions} signal executions failed this cycle`);
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
    // Get a snapshot of positions to avoid modification during iteration
    const positions = [...this.positionTracker.getAllPositions()];

    // Collect positions to close, then close them after iteration
    const positionsToClose: { symbol: string; reason: string }[] = [];

    // Get prices once for all positions
    let mids: Record<string, string>;
    try {
      mids = await this.client.getAllMids();
    } catch (error) {
      console.error('[SignalAggregator] Failed to get prices for exit checks:', error);
      return;
    }

    for (const position of positions) {
      // Skip 'unknown' strategies - we don't know how to manage them
      if (position.strategyName === 'unknown') continue;

      const strategy = this.strategies.get(position.strategyName);
      if (!strategy) continue;

      try {
        const currentPrice = parseFloat(mids[position.symbol]);
        if (!currentPrice || isNaN(currentPrice)) continue;

        // Check stop loss
        if (position.stopLoss !== undefined) {
          if (position.side === 'LONG' && currentPrice <= position.stopLoss) {
            positionsToClose.push({ symbol: position.symbol, reason: 'Stop loss hit' });
            continue;
          }
          if (position.side === 'SHORT' && currentPrice >= position.stopLoss) {
            positionsToClose.push({ symbol: position.symbol, reason: 'Stop loss hit' });
            continue;
          }
        }

        // Check take profit
        if (position.takeProfit !== undefined) {
          if (position.side === 'LONG' && currentPrice >= position.takeProfit) {
            positionsToClose.push({ symbol: position.symbol, reason: 'Take profit hit' });
            continue;
          }
          if (position.side === 'SHORT' && currentPrice <= position.takeProfit) {
            positionsToClose.push({ symbol: position.symbol, reason: 'Take profit hit' });
            continue;
          }
        }

        // Check strategy-specific exit conditions
        const exitCheck = await strategy.shouldExit(position, currentPrice);
        if (exitCheck.shouldExit) {
          positionsToClose.push({ symbol: position.symbol, reason: exitCheck.reason || 'Strategy exit' });
        }
      } catch (error) {
        console.error(`[SignalAggregator] Error checking exit for ${position.symbol}:`, error);
      }
    }

    // Now close positions after iteration is complete
    for (const { symbol, reason } of positionsToClose) {
      try {
        await this.orderManager.closePosition(symbol, reason);
      } catch (error) {
        console.error(`[SignalAggregator] Error closing position ${symbol}:`, error);
      }
    }
  }

  // Execution stats tracking methods
  private recordExecutionSuccess(strategyName: StrategyName): void {
    const stats = this.getOrCreateStats(strategyName);
    stats.consecutiveFailures = 0;
    stats.totalSuccesses++;
  }

  private recordExecutionFailure(strategyName: StrategyName, reason: string): boolean {
    const stats = this.getOrCreateStats(strategyName);
    stats.consecutiveFailures++;
    stats.lastFailureTime = new Date();
    stats.totalFailures++;

    console.warn(`[SignalAggregator] Execution failure for ${strategyName}: ${reason} (consecutive: ${stats.consecutiveFailures})`);

    // Return true if we should alert (hit threshold)
    return stats.consecutiveFailures === MAX_CONSECUTIVE_FAILURES;
  }

  private getOrCreateStats(strategyName: StrategyName): ExecutionStats {
    let stats = this.executionStats.get(strategyName);
    if (!stats) {
      stats = {
        consecutiveFailures: 0,
        totalFailures: 0,
        totalSuccesses: 0,
      };
      this.executionStats.set(strategyName, stats);
    }
    return stats;
  }

  getExecutionStats(): Map<StrategyName, ExecutionStats> {
    return new Map(this.executionStats);
  }
}
