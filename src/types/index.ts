// Core data types

export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface FundingRate {
  symbol: string;
  fundingTime: Date;
  fundingRate: number;
  markPrice: number;
}

export interface Signal {
  strategyName: StrategyName;
  symbol: string;
  signalTime: Date;
  direction: 'LONG' | 'SHORT' | 'CLOSE' | 'NONE';
  strength: number;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  metadata?: Record<string, unknown>;
}

export type StrategyName = 'funding_signal' | 'momentum_breakout' | 'mean_reversion' | 'trend_follow';

// Strategy Lifecycle Types
export type StrategyDeploymentState =
  | 'development'        // Being developed, not running anywhere
  | 'testnet_pending'    // Queued for testnet deployment
  | 'testnet_active'     // Running on testnet, gathering performance data
  | 'testnet_validated'  // Passed testnet criteria, ready for mainnet
  | 'mainnet_shadow'     // Running on mainnet, logging signals but not executing
  | 'mainnet_active'     // Fully active on mainnet
  | 'mainnet_paused'     // Temporarily paused on mainnet (e.g., underperforming)
  | 'deprecated';        // Being phased out

export type Environment = 'testnet' | 'mainnet';

export interface StrategyVersion {
  id: number;
  strategyName: StrategyName;
  version: string;           // Semantic version e.g., "1.2.0"
  deploymentState: StrategyDeploymentState;
  codeHash: string;          // Hash of strategy code for change detection
  createdAt: Date;
  updatedAt: Date;
  promotedAt?: Date;         // When promoted to mainnet
  parameters: Record<string, unknown>;  // Strategy parameters for this version
}

export interface StrategyDeployment {
  id: number;
  strategyVersionId: number;
  environment: Environment;
  state: StrategyDeploymentState;
  deployedAt: Date;
  lastEvaluatedAt?: Date;
  shadowMode: boolean;       // If true, logs signals but doesn't execute
  performanceMetrics?: StrategyPerformanceMetrics;
}

export interface StrategyPerformanceMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnl: number;
  sharpeRatio: number;
  maxDrawdown: number;
  profitFactor: number;
  winRate: number;
  consecutiveLosses: number;
  runtimeHours: number;
}

export interface PromotionCriteria {
  minTestnetRuntimeHours: number;    // Default: 48
  minTrades: number;                  // Default: 20
  minSharpeRatio: number;             // Default: 0.5
  maxDrawdownPct: number;             // Default: -20
  minWinRatePct: number;              // Default: 40
  minProfitFactor: number;            // Default: 1.2
  maxConsecutiveLosses: number;       // Default: 5
  minShadowModeHours: number;         // Default: 24 (mainnet shadow before active)
}

export interface PromotionEvaluation {
  strategyName: StrategyName;
  version: string;
  currentState: StrategyDeploymentState;
  targetState: StrategyDeploymentState;
  criteria: PromotionCriteria;
  metrics: StrategyPerformanceMetrics;
  passed: boolean;
  failedCriteria: string[];
  evaluatedAt: Date;
}

export interface RollbackEvent {
  id: number;
  strategyName: StrategyName;
  fromVersion: string;
  toVersion: string;
  reason: string;
  triggeredAt: Date;
  automatic: boolean;  // true if triggered by system, false if manual
}

export interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  leverage: number;
  liquidationPrice?: number;
  unrealizedPnl: number;
  marginUsed: number;
  strategyName: StrategyName;
  openedAt: Date;
}

export interface AccountState {
  equity: number;
  availableBalance: number;
  totalMarginUsed: number;
  unrealizedPnl: number;
  realizedPnl24h: number;
  peakEquity: number;
  drawdownPct: number;
  positions: Position[];
}

export interface StrategyAllocation {
  funding_signal: number;
  momentum_breakout: number;
  mean_reversion: number;
  trend_follow: number;
  [key: string]: number;
}

export interface StrategyPerformance {
  strategyName: StrategyName;
  periodStart: Date;
  periodEnd: Date;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnl: number;
  maxDrawdown: number;
  sharpeRatio: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  consecutiveLosses: number;
}

export interface MCLDecision {
  decisionTime: Date;
  decisionType: 'ALLOCATION' | 'STRATEGY_DISABLE' | 'STRATEGY_ENABLE' | 'PARAMETER_CHANGE' | 'LEVERAGE_ADJUST';
  inputs: MCLInputs;
  outputs: MCLOutputs;
  reasoning: string;
  confidence: number;
}

export interface MCLInputs {
  accountState: AccountState;
  strategyPerformances: StrategyPerformance[];
  recentSignals: Signal[];
  marketConditions: MarketConditions;
  systemHealth: SystemHealthCheck[];
}

export interface MCLOutputs {
  allocations?: StrategyAllocation;
  disabledStrategies?: StrategyName[];
  enabledStrategies?: StrategyName[];
  parameterChanges?: Record<StrategyName, Record<string, unknown>>;
  leverageCap?: number;
  riskLevel?: 'NORMAL' | 'REDUCED' | 'MINIMUM';
}

export interface MarketConditions {
  btcTrend: 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN';
  volatility: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  dominantRegime: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'UNCLEAR';
  avgFundingRate: number;
}

export interface SystemHealthCheck {
  component: string;
  status: 'OK' | 'DEGRADED' | 'ERROR';
  details?: Record<string, unknown>;
}

export type SystemStatus = 'RUNNING' | 'PAUSED' | 'ERROR' | 'STOPPED';

export interface Alert {
  alertTime: Date;
  alertType: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL' | 'PAUSE';
  title: string;
  message: string;
  requiresAction: boolean;
}

export interface TelegramCommand {
  command: 'GO' | 'STOP' | 'STATUS' | 'REPORT' | 'POSITIONS' | 'HELP';
  args?: string[];
}

// Trade types
export interface Trade {
  tradeId?: string;
  strategyName: StrategyName;
  symbol: string;
  side: 'BUY' | 'SELL';
  direction: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_LONG' | 'CLOSE_SHORT';
  quantity: number;
  price: number;
  fee?: number;
  leverage?: number;
  executedAt: Date;
  orderType?: 'MARKET' | 'LIMIT';
  pnl?: number;
  metadata?: Record<string, unknown>;
}

export interface TradeResult {
  success: boolean;
  orderId?: string;
  reason?: string;
}

export interface RiskCheckResult {
  approved: boolean;
  maxLeverage: number;
  reason?: string;
  checks?: string[];
}

export interface PositionSizeResult {
  size: number;
  leverage: number;
  marginRequired: number;
}

// Order types
export interface OrderRequest {
  asset: number;
  isBuy: boolean;
  price: number;
  size: number;
  leverage?: number;
  orderType?: { market: Record<string, never> } | { limit: { tif: 'Gtc' | 'Ioc' | 'Alo' } };
  reduceOnly?: boolean;
}

export interface OrderResponse {
  status: 'ok' | 'error';
  response?: {
    type: string;
    data: {
      statuses: Array<{
        resting?: { oid: number };
        filled?: { oid: number; totalSz: string; avgPx: string };
        error?: string;
      }>;
    };
  };
}

// System state types
export interface SystemState {
  tradingEnabled: boolean;
  systemStatus: SystemStatus;
  pauseReason: string | null;
  lastMclRun: Date | null;
  currentAllocations: StrategyAllocation;
  peakEquity: number;
  dailyStartEquity: number;
  dailyPnl: number;
  awaitingGoConfirm: boolean;
  awaitingStopConfirm: boolean;
}

// Daily report types
export interface DailyReport {
  date: string;
  startEquity: number;
  endEquity: number;
  pnlChange: number;
  pnlChangePct: number;
  peakEquity: number;
  drawdownPct: number;
  strategyPerformances: Array<{
    name: string;
    pnl: number;
    trades: number;
    wins: number;
    losses: number;
  }>;
  mclDecisions: string[];
  openPositions: number;
  allocations: StrategyAllocation;
  systemHealth: string;
  dashboardUrl: string;
}

// Pause analysis types
export interface PauseAnalysis {
  whatHappened: string;
  rootCause: string;
  mclAssessment: string;
}

// Strategy parameter types
export interface FundingSignalParams {
  entryThresholdLong: number;
  entryThresholdShort: number;
  exitThresholdLong: number;
  exitThresholdShort: number;
  atrMultiplierSL: number;
  atrMultiplierTP: number;
  maxHoldHours: number;
  useEmaFilter: boolean;
  emaPeriod: number;
}

export interface MomentumBreakoutParams {
  consolidationMaxRange: number;
  consolidationPeriodHours: number;
  adxThreshold: number;
  volumeMultiplier: number;
  atrMultiplierTrailingSL: number;
  atrMultiplierTP: number;
  rsiOverbought: number;
  rsiOversold: number;
}

export interface MeanReversionParams {
  entryMoveThreshold: number;
  rsiEntryLong: number;
  rsiEntryShort: number;
  rsiExitLong: number;
  rsiExitShort: number;
  bbPeriod: number;
  bbStdDev: number;
  atrMultiplierSL: number;
  maxHoldHours: number;
  trendFilterEnabled: boolean;
}

export interface TrendFollowParams {
  fastEmaPeriod: number;
  slowEmaPeriod: number;
  adxEntryThreshold: number;
  adxExitThreshold: number;
  atrMultiplierTrailingSL: number;
  timeframe: Timeframe;
  consecutiveClosesForExit: number;
}

// Hyperliquid API types
export interface HyperliquidMeta {
  universe: Array<{
    name: string;
    szDecimals: number;
    maxLeverage: number;
  }>;
}

export interface HyperliquidAccountInfo {
  marginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
  };
  assetPositions: Array<{
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      leverage: { type: string; value: number };
      liquidationPx: string | null;
      unrealizedPnl: string;
      marginUsed: string;
    };
  }>;
}

export interface HyperliquidOpenOrder {
  coin: string;
  oid: number;
  side: string;
  limitPx: string;
  sz: string;
  timestamp: number;
}

export interface HyperliquidFill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  closedPnl: string;
  fee: string;
  oid: number;
}

export interface HyperliquidFundingHistory {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

export interface HyperliquidCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

// Evaluator output types
export interface SystemEvaluatorOutput {
  overall_health: 'OK' | 'DEGRADED' | 'CRITICAL';
  should_pause: boolean;
  pause_reason: string | null;
  risk_level: 'NORMAL' | 'REDUCED' | 'MINIMUM';
  anomalies_detected: string[];
  recommendations: string[];
  confidence: number;
}

export interface AgentEvaluatorOutput {
  strategy_assessments: Record<StrategyName, {
    health: 'HEALTHY' | 'STRUGGLING' | 'FAILING';
    regime_fit: 'GOOD' | 'NEUTRAL' | 'POOR';
    recommended_allocation: number;
    reasoning: string;
  }>;
  disable_strategies: StrategyName[];
  allocation_rationale: string;
  market_regime_assessment: string;
  confidence: number;
}

export interface ConflictArbitratorOutput {
  resolved_allocations: StrategyAllocation;
  signal_resolutions: Array<{
    symbol: string;
    chosen_direction: 'LONG' | 'SHORT' | 'NONE';
    chosen_strategy: string;
    reasoning: string;
  }>;
  position_actions: Array<{
    symbol: string;
    action: 'KEEP' | 'CLOSE';
    reasoning: string;
  }>;
  leverage_cap: number;
  adjustments_made: string[];
  confidence: number;
}

// Backtest types
export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  commission: number;
}

export interface BacktestResult {
  totalReturnPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  maxConsecutiveLosses: number;
  equityCurve: Array<{ date: Date; equity: number }>;
}

// Config types
export interface Config {
  hyperliquid: {
    privateKey: string;
    walletAddress: string;
    useTestnet: boolean;
  };
  anthropic: {
    apiKey: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  database: {
    url: string;
  };
  app: {
    port: number;
    nodeEnv: string;
    logLevel: string;
  };
  trading: {
    initialCapital: number;
    reportTimeUtc: string;
    mclIntervalMinutes: number;
  };
}
