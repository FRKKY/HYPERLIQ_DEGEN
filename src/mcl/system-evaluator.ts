import Anthropic from '@anthropic-ai/sdk';
import { Database } from '../data/database';
import { AccountState, SystemHealthCheck, Alert, SystemEvaluatorOutput } from '../types';
import { buildSystemEvaluatorPrompt } from './prompts';

export class SystemEvaluator {
  private anthropic: Anthropic;
  private db: Database;

  constructor(apiKey: string, db: Database) {
    this.anthropic = new Anthropic({ apiKey });
    this.db = db;
  }

  async evaluate(accountState: AccountState): Promise<SystemEvaluatorOutput> {
    const startTime = Date.now();

    try {
      // Gather inputs
      const systemState = await this.db.getSystemState();
      const healthChecks = await this.db.getRecentHealthChecks();
      const alerts = await this.db.getUnacknowledgedAlerts();

      // Build prompt
      const prompt = buildSystemEvaluatorPrompt(
        systemState.systemStatus,
        systemState.tradingEnabled,
        systemState.lastMclRun,
        accountState,
        healthChecks,
        alerts
      );

      // Call Claude
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
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

      const output: SystemEvaluatorOutput = JSON.parse(jsonMatch[0]);

      // Validate output
      this.validateOutput(output);

      console.log(
        `[SystemEvaluator] Health: ${output.overall_health}, Risk: ${output.risk_level}, Confidence: ${output.confidence.toFixed(2)} (${latencyMs}ms)`
      );

      return output;
    } catch (error) {
      console.error('[SystemEvaluator] Error:', error);

      // Return safe defaults on error
      return {
        overall_health: 'DEGRADED',
        should_pause: false,
        pause_reason: null,
        risk_level: 'REDUCED',
        anomalies_detected: ['MCL evaluation failed'],
        recommendations: ['Manual review recommended'],
        confidence: 0.3,
      };
    }
  }

  private validateOutput(output: SystemEvaluatorOutput): void {
    if (!['OK', 'DEGRADED', 'CRITICAL'].includes(output.overall_health)) {
      throw new Error(`Invalid overall_health: ${output.overall_health}`);
    }

    if (typeof output.should_pause !== 'boolean') {
      throw new Error('should_pause must be boolean');
    }

    if (!['NORMAL', 'REDUCED', 'MINIMUM'].includes(output.risk_level)) {
      throw new Error(`Invalid risk_level: ${output.risk_level}`);
    }

    if (output.confidence < 0 || output.confidence > 1) {
      throw new Error(`Invalid confidence: ${output.confidence}`);
    }

    // Check for contradictions
    if (output.overall_health === 'OK' && output.should_pause) {
      console.warn('[SystemEvaluator] Contradiction: health OK but should_pause true');
    }

    if (output.overall_health === 'CRITICAL' && !output.should_pause && output.risk_level === 'NORMAL') {
      console.warn('[SystemEvaluator] Contradiction: health CRITICAL but no protective action');
    }
  }
}
