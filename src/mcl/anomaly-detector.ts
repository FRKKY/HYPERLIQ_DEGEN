import { SystemEvaluatorOutput, AgentEvaluatorOutput, ConflictArbitratorOutput } from '../types';

export interface AnomalyCheckResult {
  isValid: boolean;
  anomalies: string[];
}

type EvaluatorType = 'system' | 'agent' | 'conflict';

export function checkForAnomalies(
  output: SystemEvaluatorOutput | AgentEvaluatorOutput | ConflictArbitratorOutput,
  evaluatorType: EvaluatorType
): AnomalyCheckResult {
  const anomalies: string[] = [];

  // 1. Check for valid JSON structure
  if (!output || typeof output !== 'object') {
    anomalies.push('Output is not valid JSON object');
    return { isValid: false, anomalies };
  }

  // 2. Check confidence bounds
  if ('confidence' in output && output.confidence !== undefined) {
    if (output.confidence < 0 || output.confidence > 1) {
      anomalies.push(`Confidence ${output.confidence} outside valid range [0,1]`);
    }
    if (output.confidence < 0.3) {
      anomalies.push(`Very low confidence (${output.confidence}), MCL uncertain`);
    }
  }

  // 3. Check for allocation validity (agent evaluator)
  if (evaluatorType === 'agent' && 'strategy_assessments' in output) {
    const agentOutput = output as AgentEvaluatorOutput;
    const allocations = Object.values(agentOutput.strategy_assessments)
      .map((s) => s.recommended_allocation || 0);

    const sum = allocations.reduce((a: number, b: number) => a + b, 0);
    if (sum > 150) {
      anomalies.push(`Allocation sum ${sum}% exceeds 150%, likely hallucination`);
    }

    allocations.forEach((alloc: number) => {
      if (alloc < 0 || alloc > 100) {
        anomalies.push(`Invalid allocation value: ${alloc}`);
      }
    });
  }

  // 4. Check for contradictions
  if (evaluatorType === 'system') {
    const systemOutput = output as SystemEvaluatorOutput;
    if (systemOutput.overall_health === 'OK' && systemOutput.should_pause) {
      anomalies.push('Contradiction: health OK but should_pause true');
    }
    if (
      systemOutput.overall_health === 'CRITICAL' &&
      !systemOutput.should_pause &&
      systemOutput.risk_level === 'NORMAL'
    ) {
      anomalies.push('Contradiction: health CRITICAL but no protective action');
    }
  }

  // 5. Check for empty/missing required fields
  const requiredFields: Record<EvaluatorType, string[]> = {
    system: ['overall_health', 'should_pause', 'risk_level'],
    agent: ['strategy_assessments', 'allocation_rationale'],
    conflict: ['resolved_allocations', 'leverage_cap'],
  };

  requiredFields[evaluatorType].forEach((field) => {
    const outputRecord = output as unknown as Record<string, unknown>;
    if (outputRecord[field] === undefined || outputRecord[field] === null) {
      anomalies.push(`Missing required field: ${field}`);
    }
  });

  return {
    isValid: anomalies.length === 0,
    anomalies,
  };
}

export class AnomalyDetector {
  checkSystemEvaluatorOutput(output: SystemEvaluatorOutput): AnomalyCheckResult {
    return checkForAnomalies(output, 'system');
  }

  checkAgentEvaluatorOutput(output: AgentEvaluatorOutput): AnomalyCheckResult {
    return checkForAnomalies(output, 'agent');
  }

  checkConflictArbitratorOutput(output: ConflictArbitratorOutput): AnomalyCheckResult {
    return checkForAnomalies(output, 'conflict');
  }
}
