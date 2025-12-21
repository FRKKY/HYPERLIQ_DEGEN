import { Pool } from 'pg';
import { logger } from './logger';

export interface ComponentHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs?: number;
  message?: string;
  lastCheck: Date;
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: ComponentHealth[];
  timestamp: Date;
  uptime: number;
}

type HealthCheckFn = () => Promise<ComponentHealth>;

class HealthChecker {
  private checks: Map<string, HealthCheckFn> = new Map();
  private lastResults: Map<string, ComponentHealth> = new Map();
  private startTime: Date = new Date();

  registerCheck(name: string, check: HealthCheckFn): void {
    this.checks.set(name, check);
  }

  async checkComponent(name: string): Promise<ComponentHealth> {
    const check = this.checks.get(name);
    if (!check) {
      return {
        name,
        status: 'unhealthy',
        message: 'Check not registered',
        lastCheck: new Date(),
      };
    }

    try {
      const result = await check();
      this.lastResults.set(name, result);
      return result;
    } catch (error) {
      const result: ComponentHealth = {
        name,
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error',
        lastCheck: new Date(),
      };
      this.lastResults.set(name, result);
      return result;
    }
  }

  async checkAll(): Promise<SystemHealth> {
    const components: ComponentHealth[] = [];

    for (const name of this.checks.keys()) {
      const result = await this.checkComponent(name);
      components.push(result);
    }

    const unhealthyCount = components.filter((c) => c.status === 'unhealthy').length;
    const degradedCount = components.filter((c) => c.status === 'degraded').length;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (unhealthyCount > 0) {
      status = 'unhealthy';
    } else if (degradedCount > 0) {
      status = 'degraded';
    }

    return {
      status,
      components,
      timestamp: new Date(),
      uptime: Date.now() - this.startTime.getTime(),
    };
  }

  getLastResult(name: string): ComponentHealth | undefined {
    return this.lastResults.get(name);
  }

  getUptime(): number {
    return Date.now() - this.startTime.getTime();
  }
}

export const healthChecker = new HealthChecker();

// Database health check factory
export function createDatabaseHealthCheck(pool: Pool): HealthCheckFn {
  return async (): Promise<ComponentHealth> => {
    const start = Date.now();
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();

      const latencyMs = Date.now() - start;
      return {
        name: 'database',
        status: latencyMs > 1000 ? 'degraded' : 'healthy',
        latencyMs,
        message: latencyMs > 1000 ? 'High latency' : 'Connected',
        lastCheck: new Date(),
      };
    } catch (error) {
      return {
        name: 'database',
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        message: error instanceof Error ? error.message : 'Connection failed',
        lastCheck: new Date(),
      };
    }
  };
}

// API health check factory
export function createApiHealthCheck(
  name: string,
  checkFn: () => Promise<boolean>
): HealthCheckFn {
  return async (): Promise<ComponentHealth> => {
    const start = Date.now();
    try {
      const isHealthy = await checkFn();
      const latencyMs = Date.now() - start;

      return {
        name,
        status: isHealthy ? (latencyMs > 2000 ? 'degraded' : 'healthy') : 'unhealthy',
        latencyMs,
        message: isHealthy ? 'OK' : 'Check failed',
        lastCheck: new Date(),
      };
    } catch (error) {
      return {
        name,
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        message: error instanceof Error ? error.message : 'Check failed',
        lastCheck: new Date(),
      };
    }
  };
}

// WebSocket health check factory
export function createWebSocketHealthCheck(
  name: string,
  isConnected: () => boolean
): HealthCheckFn {
  return async (): Promise<ComponentHealth> => {
    const connected = isConnected();
    return {
      name,
      status: connected ? 'healthy' : 'unhealthy',
      message: connected ? 'Connected' : 'Disconnected',
      lastCheck: new Date(),
    };
  };
}
