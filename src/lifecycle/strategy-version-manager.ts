import * as crypto from 'crypto';
import { Database } from '../data/database';
import {
  StrategyName,
  StrategyVersion,
  StrategyDeployment,
  StrategyDeploymentState,
  Environment,
  StrategyPerformanceMetrics,
} from '../types';

export class StrategyVersionManager {
  constructor(private db: Database) {}

  async createVersion(
    strategyName: StrategyName,
    version: string,
    parameters: Record<string, unknown>,
    codeContent: string
  ): Promise<StrategyVersion> {
    const codeHash = crypto.createHash('sha256').update(codeContent).digest('hex');

    const result = await this.db.query<{ id: number; created_at: Date }>(
      `INSERT INTO strategy_versions (strategy_name, version, deployment_state, code_hash, parameters)
       VALUES ($1, $2, 'development', $3, $4)
       RETURNING id, created_at`,
      [strategyName, version, codeHash, parameters]
    );

    return {
      id: result.rows[0].id,
      strategyName,
      version,
      deploymentState: 'development',
      codeHash,
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[0].created_at,
      parameters,
    };
  }

  async getVersion(strategyName: StrategyName, version: string): Promise<StrategyVersion | null> {
    const result = await this.db.query<{
      id: number;
      strategy_name: string;
      version: string;
      deployment_state: string;
      code_hash: string;
      parameters: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
      promoted_at: Date | null;
    }>(
      `SELECT id, strategy_name, version, deployment_state, code_hash, parameters, created_at, updated_at, promoted_at
       FROM strategy_versions WHERE strategy_name = $1 AND version = $2`,
      [strategyName, version]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      strategyName: row.strategy_name as StrategyName,
      version: row.version,
      deploymentState: row.deployment_state as StrategyDeploymentState,
      codeHash: row.code_hash,
      parameters: row.parameters,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      promotedAt: row.promoted_at || undefined,
    };
  }

  async getActiveVersion(strategyName: StrategyName, environment: Environment): Promise<StrategyVersion | null> {
    const activeStates = environment === 'mainnet'
      ? ['mainnet_active', 'mainnet_shadow']
      : ['testnet_active'];

    const result = await this.db.query<{
      id: number;
      strategy_name: string;
      version: string;
      deployment_state: string;
      code_hash: string;
      parameters: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
      promoted_at: Date | null;
    }>(
      `SELECT sv.id, sv.strategy_name, sv.version, sv.deployment_state, sv.code_hash,
              sv.parameters, sv.created_at, sv.updated_at, sv.promoted_at
       FROM strategy_versions sv
       JOIN strategy_deployments sd ON sv.id = sd.strategy_version_id
       WHERE sv.strategy_name = $1 AND sd.environment = $2 AND sd.state = ANY($3)
       ORDER BY sv.created_at DESC LIMIT 1`,
      [strategyName, environment, activeStates]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      strategyName: row.strategy_name as StrategyName,
      version: row.version,
      deploymentState: row.deployment_state as StrategyDeploymentState,
      codeHash: row.code_hash,
      parameters: row.parameters,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      promotedAt: row.promoted_at || undefined,
    };
  }

  async getAllActiveVersions(environment: Environment): Promise<StrategyVersion[]> {
    const activeStates = environment === 'mainnet'
      ? ['mainnet_active', 'mainnet_shadow']
      : ['testnet_active'];

    const result = await this.db.query<{
      id: number;
      strategy_name: string;
      version: string;
      deployment_state: string;
      code_hash: string;
      parameters: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
      promoted_at: Date | null;
    }>(
      `SELECT DISTINCT ON (sv.strategy_name)
              sv.id, sv.strategy_name, sv.version, sv.deployment_state, sv.code_hash,
              sv.parameters, sv.created_at, sv.updated_at, sv.promoted_at
       FROM strategy_versions sv
       JOIN strategy_deployments sd ON sv.id = sd.strategy_version_id
       WHERE sd.environment = $1 AND sd.state = ANY($2)
       ORDER BY sv.strategy_name, sv.created_at DESC`,
      [environment, activeStates]
    );

    return result.rows.map((row) => ({
      id: row.id,
      strategyName: row.strategy_name as StrategyName,
      version: row.version,
      deploymentState: row.deployment_state as StrategyDeploymentState,
      codeHash: row.code_hash,
      parameters: row.parameters,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      promotedAt: row.promoted_at || undefined,
    }));
  }

  async updateVersionState(
    versionId: number,
    newState: StrategyDeploymentState
  ): Promise<void> {
    const promotedAt = newState === 'mainnet_active' ? 'NOW()' : 'promoted_at';

    await this.db.query(
      `UPDATE strategy_versions
       SET deployment_state = $1, updated_at = NOW(), promoted_at = ${promotedAt}
       WHERE id = $2`,
      [newState, versionId]
    );
  }

  async createDeployment(
    versionId: number,
    environment: Environment,
    state: StrategyDeploymentState,
    shadowMode: boolean = false
  ): Promise<StrategyDeployment> {
    const result = await this.db.query<{ id: number; deployed_at: Date }>(
      `INSERT INTO strategy_deployments (strategy_version_id, environment, state, shadow_mode)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (strategy_version_id, environment)
       DO UPDATE SET state = EXCLUDED.state, shadow_mode = EXCLUDED.shadow_mode
       RETURNING id, deployed_at`,
      [versionId, environment, state, shadowMode]
    );

    return {
      id: result.rows[0].id,
      strategyVersionId: versionId,
      environment,
      state,
      deployedAt: result.rows[0].deployed_at,
      shadowMode,
    };
  }

  async getDeployment(versionId: number, environment: Environment): Promise<StrategyDeployment | null> {
    const result = await this.db.query<{
      id: number;
      strategy_version_id: number;
      environment: string;
      state: string;
      deployed_at: Date;
      last_evaluated_at: Date | null;
      shadow_mode: boolean;
      performance_metrics: StrategyPerformanceMetrics | null;
    }>(
      `SELECT id, strategy_version_id, environment, state, deployed_at, last_evaluated_at, shadow_mode, performance_metrics
       FROM strategy_deployments WHERE strategy_version_id = $1 AND environment = $2`,
      [versionId, environment]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      strategyVersionId: row.strategy_version_id,
      environment: row.environment as Environment,
      state: row.state as StrategyDeploymentState,
      deployedAt: row.deployed_at,
      lastEvaluatedAt: row.last_evaluated_at || undefined,
      shadowMode: row.shadow_mode,
      performanceMetrics: row.performance_metrics || undefined,
    };
  }

  async updateDeploymentState(
    deploymentId: number,
    state: StrategyDeploymentState,
    shadowMode?: boolean
  ): Promise<void> {
    if (shadowMode !== undefined) {
      await this.db.query(
        `UPDATE strategy_deployments SET state = $1, shadow_mode = $2 WHERE id = $3`,
        [state, shadowMode, deploymentId]
      );
    } else {
      await this.db.query(
        `UPDATE strategy_deployments SET state = $1 WHERE id = $2`,
        [state, deploymentId]
      );
    }
  }

  async updateDeploymentMetrics(
    deploymentId: number,
    metrics: StrategyPerformanceMetrics
  ): Promise<void> {
    await this.db.query(
      `UPDATE strategy_deployments
       SET performance_metrics = $1, last_evaluated_at = NOW()
       WHERE id = $2`,
      [metrics, deploymentId]
    );
  }

  async getVersionsAwaitingPromotion(): Promise<StrategyVersion[]> {
    const result = await this.db.query<{
      id: number;
      strategy_name: string;
      version: string;
      deployment_state: string;
      code_hash: string;
      parameters: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
      promoted_at: Date | null;
    }>(
      `SELECT id, strategy_name, version, deployment_state, code_hash, parameters, created_at, updated_at, promoted_at
       FROM strategy_versions
       WHERE deployment_state IN ('testnet_active', 'testnet_validated', 'mainnet_shadow')
       ORDER BY strategy_name, created_at DESC`
    );

    return result.rows.map((row) => ({
      id: row.id,
      strategyName: row.strategy_name as StrategyName,
      version: row.version,
      deploymentState: row.deployment_state as StrategyDeploymentState,
      codeHash: row.code_hash,
      parameters: row.parameters,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      promotedAt: row.promoted_at || undefined,
    }));
  }

  async queueForTestnet(versionId: number): Promise<void> {
    await this.updateVersionState(versionId, 'testnet_pending');
    await this.createDeployment(versionId, 'testnet', 'testnet_pending', false);
  }

  async activateOnTestnet(versionId: number): Promise<void> {
    await this.updateVersionState(versionId, 'testnet_active');
    const deployment = await this.getDeployment(versionId, 'testnet');
    if (deployment) {
      await this.updateDeploymentState(deployment.id, 'testnet_active');
    }
  }

  async validateTestnet(versionId: number): Promise<void> {
    await this.updateVersionState(versionId, 'testnet_validated');
    const deployment = await this.getDeployment(versionId, 'testnet');
    if (deployment) {
      await this.updateDeploymentState(deployment.id, 'testnet_validated');
    }
  }

  async promoteToMainnetShadow(versionId: number): Promise<void> {
    await this.updateVersionState(versionId, 'mainnet_shadow');
    await this.createDeployment(versionId, 'mainnet', 'mainnet_shadow', true);
  }

  async activateOnMainnet(versionId: number): Promise<void> {
    // First, pause any currently active version for this strategy
    const version = await this.db.query<{ strategy_name: string }>(
      `SELECT strategy_name FROM strategy_versions WHERE id = $1`,
      [versionId]
    );

    if (version.rows.length > 0) {
      const strategyName = version.rows[0].strategy_name;

      // Pause old active versions
      await this.db.query(
        `UPDATE strategy_versions
         SET deployment_state = 'deprecated', updated_at = NOW()
         WHERE strategy_name = $1 AND deployment_state = 'mainnet_active' AND id != $2`,
        [strategyName, versionId]
      );
    }

    // Activate this version
    await this.updateVersionState(versionId, 'mainnet_active');
    const deployment = await this.getDeployment(versionId, 'mainnet');
    if (deployment) {
      await this.updateDeploymentState(deployment.id, 'mainnet_active', false);
    } else {
      await this.createDeployment(versionId, 'mainnet', 'mainnet_active', false);
    }
  }

  async pauseOnMainnet(versionId: number): Promise<void> {
    await this.updateVersionState(versionId, 'mainnet_paused');
    const deployment = await this.getDeployment(versionId, 'mainnet');
    if (deployment) {
      await this.updateDeploymentState(deployment.id, 'mainnet_paused');
    }
  }

  async deprecateVersion(versionId: number): Promise<void> {
    await this.updateVersionState(versionId, 'deprecated');
  }

  async isVersionInShadowMode(versionId: number): Promise<boolean> {
    const deployment = await this.getDeployment(versionId, 'mainnet');
    return deployment?.shadowMode ?? false;
  }

  async getRuntimeHours(versionId: number, environment: Environment): Promise<number> {
    const deployment = await this.getDeployment(versionId, environment);
    if (!deployment) return 0;

    const now = new Date();
    const deployedAt = new Date(deployment.deployedAt);
    const diffMs = now.getTime() - deployedAt.getTime();
    return diffMs / (1000 * 60 * 60);
  }
}
