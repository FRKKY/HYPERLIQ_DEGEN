import Anthropic from '@anthropic-ai/sdk';
import { Database } from '../data/database';
import {
  StrategyPerformance,
  MarketConditions,
  StrategyAllocation,
  AgentEvaluatorOutput,
  StrategyName,
  Candle,
} from '../types';
import { buildAgentEvaluatorPrompt } from './prompts';
import { IndicatorComputer } from '../data/indicator-computer';
import { PositionTracker } from '../execution/position-tracker';

export class AgentEvaluator {
  private anthropic: Anthropic;
  private db: Database;
  private positionTracker: PositionTracker;

  constructor(apiKey: string, db: Database, positionTracker: PositionTracker) {
    this.anthropic = new Anthropic({ apiKey });
    this.db = db;
    this.positionTracker = positionTracker;
  }

  async evaluate(
    equity: number,
    drawdownPct: number,
    riskLevel: string
  ): Promise<AgentEvaluatorOutput> {
    const startTime = Date.now();

    try {
      // Get current allocations
      const currentAllocations = await this.db.getCurrentAllocations();

      // Get strategy performances for different periods
      const strategies: StrategyName[] = ['funding_signal', 'momentum_breakout', 'mean_reversion', 'trend_follow'];
      const strategyPerformances = await Promise.all(
        strategies.map(async (name) => {
          const perf1h = await this.getStrategyPerformance(name, 1);
          const perf24h = await this.getStrategyPerformance(name, 24);
          const perf7d = await this.getStrategyPerformance(name, 168);

          const openPositions = this.positionTracker.getPositionsByStrategy(name).length;
          const recentSignals = await this.db.getRecentSignals(name, 10);
          const pendingSignals = recentSignals.filter(
            (s) => new Date().getTime() - s.signalTime.getTime() < 60 * 60 * 1000
          ).length;

          return {
            name,
            perf1h,
            perf24h,
            perf7d,
            enabled: true, // Would check disabled strategies
            openPositions,
            pendingSignals,
          };
        })
      );

      // Get market conditions
      const marketConditions = await this.getMarketConditions();

      // Build prompt
      const prompt = buildAgentEvaluatorPrompt(
        currentAllocations,
        strategyPerformances,
        marketConditions,
        equity,
        drawdownPct,
        riskLevel
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

      const output: AgentEvaluatorOutput = JSON.parse(jsonMatch[0]);

      // Validate output
      this.validateOutput(output);

      console.log(
        `[AgentEvaluator] Confidence: ${output.confidence.toFixed(2)}, Disabled: ${output.disable_strategies.length} (${latencyMs}ms)`
      );

      return output;
    } catch (error) {
      console.error('[AgentEvaluator] Error:', error);

      // Return safe defaults on error
      return {
        strategy_assessments: {
          funding_signal: { health: 'HEALTHY', regime_fit: 'NEUTRAL', recommended_allocation: 25, reasoning: 'Default' },
          momentum_breakout: { health: 'HEALTHY', regime_fit: 'NEUTRAL', recommended_allocation: 25, reasoning: 'Default' },
          mean_reversion: { health: 'HEALTHY', regime_fit: 'NEUTRAL', recommended_allocation: 25, reasoning: 'Default' },
          trend_follow: { health: 'HEALTHY', regime_fit: 'NEUTRAL', recommended_allocation: 25, reasoning: 'Default' },
        },
        disable_strategies: [],
        allocation_rationale: 'Using default allocations due to evaluation error',
        market_regime_assessment: 'Unable to assess',
        confidence: 0.3,
      };
    }
  }

  private async getStrategyPerformance(
    strategyName: StrategyName,
    periodHours: number
  ): Promise<StrategyPerformance | null> {
    const performances = await this.db.getStrategyPerformances(periodHours);
    return performances.find((p) => p.strategyName === strategyName) || null;
  }

  private async getMarketConditions(): Promise<MarketConditions> {
    try {
      // Get BTC candles for analysis
      const btcCandles = await this.db.getCandles('BTC', '4h', 100);

      if (btcCandles.length < 50) {
        return {
          btcTrend: 'NEUTRAL',
          volatility: 'MEDIUM',
          dominantRegime: 'UNCLEAR',
          avgFundingRate: 0,
        };
      }

      const btcTrend = IndicatorComputer.detectTrend(btcCandles);
      const volatility = IndicatorComputer.detectVolatility(btcCandles);
      const dominantRegime = IndicatorComputer.detectRegime(btcCandles);

      // Get average funding rate
      const fundingRates = await this.db.getFundingRates('BTC', 24);
      const avgFundingRate =
        fundingRates.length > 0
          ? fundingRates.reduce((sum, r) => sum + r.fundingRate, 0) / fundingRates.length
          : 0;

      return {
        btcTrend,
        volatility,
        dominantRegime,
        avgFundingRate,
      };
    } catch (error) {
      console.error('[AgentEvaluator] Error getting market conditions:', error);
      return {
        btcTrend: 'NEUTRAL',
        volatility: 'MEDIUM',
        dominantRegime: 'UNCLEAR',
        avgFundingRate: 0,
      };
    }
  }

  private validateOutput(output: AgentEvaluatorOutput): void {
    const strategies: StrategyName[] = ['funding_signal', 'momentum_breakout', 'mean_reversion', 'trend_follow'];

    for (const strategy of strategies) {
      const assessment = output.strategy_assessments[strategy];
      if (!assessment) {
        throw new Error(`Missing assessment for ${strategy}`);
      }

      if (!['HEALTHY', 'STRUGGLING', 'FAILING'].includes(assessment.health)) {
        throw new Error(`Invalid health for ${strategy}: ${assessment.health}`);
      }

      if (!['GOOD', 'NEUTRAL', 'POOR'].includes(assessment.regime_fit)) {
        throw new Error(`Invalid regime_fit for ${strategy}: ${assessment.regime_fit}`);
      }

      if (assessment.recommended_allocation < 0 || assessment.recommended_allocation > 50) {
        throw new Error(`Invalid recommended_allocation for ${strategy}: ${assessment.recommended_allocation}`);
      }
    }

    if (output.confidence < 0 || output.confidence > 1) {
      throw new Error(`Invalid confidence: ${output.confidence}`);
    }

    // Check allocation sum
    const allocationSum = Object.values(output.strategy_assessments).reduce(
      (sum, a) => sum + a.recommended_allocation,
      0
    );
    if (allocationSum > 150) {
      console.warn(`[AgentEvaluator] High allocation sum: ${allocationSum}%`);
    }
  }
}
