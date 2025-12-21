import { createWriteStream, WriteStream } from 'fs';
import { join } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
  correlationId?: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private minLevel: LogLevel;
  private fileStream: WriteStream | null = null;
  private correlationId: string | null = null;

  constructor() {
    this.minLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

    // Create file stream for production
    if (process.env.NODE_ENV === 'production') {
      const logDir = process.env.LOG_DIR || '/var/log/trading-system';
      try {
        this.fileStream = createWriteStream(join(logDir, 'app.log'), { flags: 'a' });
      } catch {
        // Fall back to console only
      }
    }
  }

  setCorrelationId(id: string): void {
    this.correlationId = id;
  }

  clearCorrelationId(): void {
    this.correlationId = null;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private formatEntry(entry: LogEntry): string {
    return JSON.stringify(entry);
  }

  private log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...(data && { data }),
      ...(this.correlationId && { correlationId: this.correlationId }),
    };

    const formatted = this.formatEntry(entry);

    // Console output with colors
    const colors: Record<LogLevel, string> = {
      debug: '\x1b[36m', // cyan
      info: '\x1b[32m',  // green
      warn: '\x1b[33m',  // yellow
      error: '\x1b[31m', // red
    };
    const reset = '\x1b[0m';

    if (process.env.NODE_ENV === 'production') {
      // Structured JSON output for production
      console.log(formatted);
    } else {
      // Human-readable output for development
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      console.log(`${colors[level]}[${entry.timestamp}] [${level.toUpperCase()}] [${component}] ${message}${dataStr}${reset}`);
    }

    // Write to file if available
    if (this.fileStream) {
      this.fileStream.write(formatted + '\n');
    }
  }

  debug(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('debug', component, message, data);
  }

  info(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('info', component, message, data);
  }

  warn(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('warn', component, message, data);
  }

  error(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('error', component, message, data);
  }

  // Specialized logging methods
  trade(action: string, data: Record<string, unknown>): void {
    this.info('Trade', action, { ...data, type: 'TRADE_EVENT' });
  }

  api(method: string, endpoint: string, status: number, latencyMs: number, data?: Record<string, unknown>): void {
    this.info('API', `${method} ${endpoint}`, { status, latencyMs, ...data, type: 'API_CALL' });
  }

  mcl(decision: string, data: Record<string, unknown>): void {
    this.info('MCL', decision, { ...data, type: 'MCL_DECISION' });
  }

  risk(event: string, data: Record<string, unknown>): void {
    this.warn('Risk', event, { ...data, type: 'RISK_EVENT' });
  }

  audit(action: string, user: string, data?: Record<string, unknown>): void {
    this.info('Audit', action, { user, ...data, type: 'AUDIT' });
  }
}

export const logger = new Logger();
