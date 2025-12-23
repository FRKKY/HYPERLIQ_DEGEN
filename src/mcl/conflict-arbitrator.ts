import Anthropic from '@anthropic-ai/sdk';
import { Database } from '../data/database';
import { Position, StrategyAllocation, ConflictArbitratorOutput, StrategyName } from '../types';
import { buildConflictArbitratorPrompt } from './prompts';
import { PositionTracker } from '../execution/position-tracker';

export class ConflictArbitrator {
  private anthropic: Anthropic;
  private db: Database;
  private positionTracker: PositionTracker;

  constructor(apiKey: string, db: Database, positionTracker: PositionTracker) {
    this.anthropic = new Anthropic({ apiKey });
    this.db = db;
    this.positionTracker = positionTracker;
  }

  async arbitrate(
    proposedAllocations: StrategyAllocation,
    disabledStrategies: StrategyName[],
    riskLevel: string,
    maxLeverage: number
  ): Promise<ConflictArbitratorOutput> {
    const startTime = Date.now();

    try {
      // Get current positions
      const positions = this.positionTracker.getAllPositions();

      // Get recent signals
      const recentSignals = await this.db.getRecentSignals(undefined, 20);
      const pendingSignals = recentSignals
        .filter((s) => new Date().getTime() - s.signalTime.getTime() < 60 * 60 * 1000)
        .map((s) => ({
          strategy: s.strategyName,
          symbol: s.symbol,
          direction: s.direction,
          strength: s.strength,
        }));

      // Find opposing signals
      const opposingSignals = this.findOpposingSignals(pendingSignals);

      // Find disabled strategies with positions
      const disabledWithPositions = disabledStrategies
        .map((strategy) => ({
          strategy,
          positionCount: positions.filter((p) => p.strategyName === strategy).length,
        }))
        .filter((d) => d.positionCount > 0);

      // Calculate current leverage
      const totalMargin = this.positionTracker.getTotalMarginUsed();
      const totalUnrealizedPnl = this.positionTracker.getTotalUnrealizedPnl();
      const currentLeverage = totalMargin > 0 ? (totalMargin + totalUnrealizedPnl) / totalMargin : 0;

      // Build prompt
      const prompt = buildConflictArbitratorPrompt(
        positions,
        pendingSignals,
        proposedAllocations,
        opposingSignals,
        disabledWithPositions,
        riskLevel,
        currentLeverage,
        maxLeverage
      );

      // Call Claude
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const latencyMs = Date.now() - startTime;
      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type');
      }

      // Parse JSON response
      const jsonMatch = content.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to extract JSON from response');
      }

      const output: ConflictArbitratorOutput = JSON.parse(jsonMatch[0]);

      // Validate output
      this.validateOutput(output);

      console.log(
        `[ConflictArbitrator] Adjustments: ${output.adjustments_made.length}, Confidence: ${output.confidence.toFixed(2)} (${latencyMs}ms)`
      );

      return output;
    } catch (error) {
      console.error('[ConflictArbitrator] Error:', error);

      // Return normalized proposed allocations on error
      const sum = Object.values(proposedAllocations).reduce((a, b) => a + b, 0);

      // Guard against division by zero - use equal distribution if sum is 0
      let normalizedAllocations: StrategyAllocation;
      if (sum <= 0) {
        console.warn('[ConflictArbitrator] All allocations are 0, using equal distribution');
        normalizedAllocations = {
          funding_signal: 25,
          momentum_breakout: 25,
          mean_reversion: 25,
          trend_follow: 25,
        };
      } else {
        normalizedAllocations = {
          funding_signal: (proposedAllocations.funding_signal / sum) * 100,
          momentum_breakout: (proposedAllocations.momentum_breakout / sum) * 100,
          mean_reversion: (proposedAllocations.mean_reversion / sum) * 100,
          trend_follow: (proposedAllocations.trend_follow / sum) * 100,
        };
      }

      return {
        resolved_allocations: normalizedAllocations,
        signal_resolutions: [],
        position_actions: [],
        leverage_cap: maxLeverage,
        adjustments_made: ['Using normalized proposed allocations due to arbitration error'],
        confidence: 0.3,
      };
    }
  }

  private findOpposingSignals(
    signals: { strategy: string; symbol: string; direction: string; strength: number }[]
  ): { symbol: string; strategy1: string; direction1: string; strategy2: string; direction2: string }[] {
    const opposing: { symbol: string; strategy1: string; direction1: string; strategy2: string; direction2: string }[] = [];

    const bySymbol = new Map<string, typeof signals>();
    for (const signal of signals) {
      const existing = bySymbol.get(signal.symbol) || [];
      existing.push(signal);
      bySymbol.set(signal.symbol, existing);
    }

    for (const [symbol, symbolSignals] of bySymbol) {
      const longs = symbolSignals.filter((s) => s.direction === 'LONG');
      const shorts = symbolSignals.filter((s) => s.direction === 'SHORT');

      if (longs.length > 0 && shorts.length > 0) {
        opposing.push({
          symbol,
          strategy1: longs[0].strategy,
          direction1: 'LONG',
          strategy2: shorts[0].strategy,
          direction2: 'SHORT',
        });
      }
    }

    return opposing;
  }

  private validateOutput(output: ConflictArbitratorOutput): void {
    const strategies: (keyof StrategyAllocation)[] = ['funding_signal', 'momentum_breakout', 'mean_reversion', 'trend_follow'];

    for (const strategy of strategies) {
      const allocation = output.resolved_allocations[strategy];
      if (allocation === undefined || allocation < 0 || isNaN(allocation)) {
        throw new Error(`Invalid allocation for ${strategy}: ${allocation}`);
      }
    }

    // Check allocation sum
    const sum = Object.values(output.resolved_allocations).reduce((a, b) => a + b, 0);
    if (sum === 0) {
      console.warn('[ConflictArbitrator] All allocations are 0 - normalizing to equal distribution');
      // Fix the allocations to equal distribution
      output.resolved_allocations = {
        funding_signal: 25,
        momentum_breakout: 25,
        mean_reversion: 25,
        trend_follow: 25,
      };
    } else if (Math.abs(sum - 100) > 5) {
      console.warn(`[ConflictArbitrator] Allocation sum ${sum}% differs from 100% - normalizing`);
      // Normalize to 100%
      for (const strategy of strategies) {
        output.resolved_allocations[strategy] = (output.resolved_allocations[strategy] / sum) * 100;
      }
    }

    if (output.leverage_cap <= 0 || output.leverage_cap > 20) {
      throw new Error(`Invalid leverage_cap: ${output.leverage_cap}`);
    }

    if (output.confidence < 0 || output.confidence > 1) {
      throw new Error(`Invalid confidence: ${output.confidence}`);
    }
  }
}
