import { Config } from './types';

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value && defaultValue === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || defaultValue!;
}

export function loadConfig(): Config {
  return {
    hyperliquid: {
      privateKey: getEnvVar('HL_PRIVATE_KEY'),
      walletAddress: getEnvVar('HL_WALLET_ADDRESS'),
      useTestnet: getEnvVar('HL_USE_TESTNET', 'false').toLowerCase() === 'true',
    },
    anthropic: {
      apiKey: getEnvVar('ANTHROPIC_API_KEY'),
    },
    telegram: {
      botToken: getEnvVar('TELEGRAM_BOT_TOKEN'),
      chatId: getEnvVar('TELEGRAM_CHAT_ID'),
    },
    database: {
      url: getEnvVar('DATABASE_URL'),
    },
    app: {
      port: parseInt(getEnvVar('PORT', '3000'), 10),
      nodeEnv: getEnvVar('NODE_ENV', 'development'),
      logLevel: getEnvVar('LOG_LEVEL', 'info'),
    },
    trading: {
      initialCapital: parseFloat(getEnvVar('INITIAL_CAPITAL', '100')),
      reportTimeUtc: getEnvVar('REPORT_TIME_UTC', '15:00'),
      mclIntervalMinutes: parseInt(getEnvVar('MCL_INTERVAL_MINUTES', '60'), 10),
    },
  };
}

export const config = loadConfig();
