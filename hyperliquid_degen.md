# Hyperliquid Autonomous Trading System
## Complete System Design Document

**Version:** 1.0  
**Date:** December 2025  
**Purpose:** Blueprint for Claude Code implementation

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Data Models](#3-data-models)
4. [Strategy Specifications](#4-strategy-specifications)
5. [Metacognitive Layer Specifications](#5-metacognitive-layer-specifications)
6. [Hyperliquid API Integration](#6-hyperliquid-api-integration)
7. [Execution Engine](#7-execution-engine)
8. [Monitoring System](#8-monitoring-system)
9. [Deployment Configuration](#9-deployment-configuration)
10. [Cold Start Protocol](#10-cold-start-protocol)
11. [File Structure](#11-file-structure)

---

## 1. System Overview

### 1.1 Objective

Fully autonomous perpetual futures trading system on Hyperliquid DEX with self-improving metacognitive layer. Primary goal: maximize daily profit from $100 initial capital.

### 1.2 Key Parameters

| Parameter | Value |
|-----------|-------|
| Initial Capital | $100 USDC |
| Target Daily Return | ≥1% |
| Deployment Region | Railway Singapore |
| MCL Evaluation Frequency | Every 1 hour |
| LLM Model | Claude Sonnet |
| Asset Universe | All Hyperliquid perpetuals |
| Leverage | Dynamic (MCL-controlled) |
| Report Time | 12:00 AM KST (15:00 UTC) |

### 1.3 Critical Thresholds

| Event | Threshold | Behavior |
|-------|-----------|----------|
| Drawdown warning | -10% | ALERT + MCL auto-reduces exposure |
| Drawdown critical | -15% | ALERT + MCL minimum exposure |
| Drawdown pause | -20% | PAUSE + close all + wait for human |
| Daily loss limit | -15% in 24h | PAUSE until next day |
| Single trade loss | -8% of equity | ALERT only |
| Strategy losing streak | 5 consecutive losses | DISABLE strategy + wait for approval |
| System error | Any unhandled exception | PAUSE + alert |
| Connection loss | >3 minutes | ALERT + close losing positions (>5% loss) |
| MCL anomaly | Invalid allocation | REJECT + use last known good |

---

## 2. Architecture

### 2.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL SERVICES                                │
├──────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Hyperliquid │  │  Anthropic  │  │  Telegram   │  │  Railway    │         │
│  │     API     │  │     API     │  │     API     │  │  Postgres   │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
└─────────┼────────────────┼────────────────┼────────────────┼────────────────┘
          │                │                │                │
          ▼                ▼                ▼                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           APPLICATION LAYER                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                      METACOGNITIVE LAYER                                 │ │
│  │                         (Hourly cycle)                                   │ │
│  │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐                  │ │
│  │  │    System     │ │     Agent     │ │   Conflict    │                  │ │
│  │  │   Evaluator   │ │   Evaluator   │ │  Arbitrator   │                  │ │
│  │  └───────┬───────┘ └───────┬───────┘ └───────┬───────┘                  │ │
│  │          └─────────────────┼─────────────────┘                          │ │
│  │                            ▼                                             │ │
│  │                   ┌─────────────────┐                                   │ │
│  │                   │ Decision Engine │                                   │ │
│  │                   └────────┬────────┘                                   │ │
│  └────────────────────────────┼────────────────────────────────────────────┘ │
│                               │                                               │
│                               ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                       OPERATIONAL LAYER                                  │ │
│  │                    (Continuous / per-minute)                             │ │
│  │  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐               │ │
│  │  │  Funding  │ │ Momentum  │ │ Mean Rev  │ │   Trend   │               │ │
│  │  │  Signal   │ │ Breakout  │ │   Fade    │ │  Follow   │               │ │
│  │  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘               │ │
│  │        └─────────────┴─────────────┴─────────────┘                      │ │
│  │                            │                                             │ │
│  │                            ▼                                             │ │
│  │                   ┌─────────────────┐                                   │ │
│  │                   │ Signal Aggregator│                                   │ │
│  │                   └────────┬────────┘                                   │ │
│  └────────────────────────────┼────────────────────────────────────────────┘ │
│                               │                                               │
│                               ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                       EXECUTION LAYER                                    │ │
│  │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐                  │ │
│  │  │    Order      │ │   Position    │ │     Risk      │                  │ │
│  │  │   Manager     │ │   Tracker     │ │   Manager     │                  │ │
│  │  └───────────────┘ └───────────────┘ └───────────────┘                  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        DATA LAYER                                        │ │
│  │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐                  │ │
│  │  │    Market     │ │   Indicator   │ │     State     │                  │ │
│  │  │  Data Store   │ │   Computer    │ │    Manager    │                  │ │
│  │  └───────────────┘ └───────────────┘ └───────────────┘                  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                      MONITORING LAYER                                    │ │
│  │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐                  │ │
│  │  │   Telegram    │ │   Dashboard   │ │    Alert      │                  │ │
│  │  │     Bot       │ │    Server     │ │   Manager     │                  │ │
│  │  └───────────────┘ └───────────────┘ └───────────────┘                  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Responsibilities

| Component | Responsibility | Frequency |
|-----------|---------------|-----------|
| **Data Collector** | Fetch & store market data via WebSocket | Continuous |
| **Indicator Computer** | Calculate technical indicators | On new candle |
| **Strategy Engines** | Generate trade signals | Per-minute |
| **Signal Aggregator** | Combine signals, respect allocations | Per-minute |
| **Order Manager** | Execute orders on Hyperliquid | On signal |
| **Position Tracker** | Track open positions, P&L | Continuous |
| **Risk Manager** | Enforce limits, trigger pauses | Continuous |
| **System Evaluator** | Check system health | Hourly |
| **Agent Evaluator** | Evaluate strategy performance | Hourly |
| **Conflict Arbitrator** | Resolve competing signals | Hourly |
| **Decision Engine** | Output capital allocations | Hourly |
| **Alert Manager** | Send notifications | On event |
| **Telegram Bot** | Handle commands, send reports | Continuous |
| **Dashboard Server** | Serve web UI | Continuous |

### 2.3 Data Flow

```
Hyperliquid WebSocket
        │
        ▼
┌───────────────┐     ┌───────────────┐
│ Data Collector│────►│   PostgreSQL  │
└───────────────┘     └───────┬───────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│   Indicator   │     │   Strategy    │     │     MCL       │
│   Computer    │     │   Engines     │     │  Evaluators   │
└───────┬───────┘     └───────┬───────┘     └───────┬───────┘
        │                     │                     │
        └──────────┬──────────┘                     │
                   │                                │
                   ▼                                ▼
           ┌───────────────┐               ┌───────────────┐
           │    Signal     │◄──────────────│   Decision    │
           │  Aggregator   │  allocations  │    Engine     │
           └───────┬───────┘               └───────────────┘
                   │
                   ▼
           ┌───────────────┐
           │     Risk      │
           │    Manager    │
           └───────┬───────┘
                   │ (if approved)
                   ▼
           ┌───────────────┐
           │    Order      │
           │   Manager     │
           └───────┬───────┘
                   │
                   ▼
           Hyperliquid API
```

---

## 3. Data Models

### 3.1 Database Schema

```sql
-- Market data: OHLCV candles
CREATE TABLE candles (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    timeframe VARCHAR(10) NOT NULL,  -- '1m', '5m', '15m', '1h', '4h', '1d'
    open_time TIMESTAMPTZ NOT NULL,
    open DECIMAL(20, 8) NOT NULL,
    high DECIMAL(20, 8) NOT NULL,
    low DECIMAL(20, 8) NOT NULL,
    close DECIMAL(20, 8) NOT NULL,
    volume DECIMAL(20, 8) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(symbol, timeframe, open_time)
);

CREATE INDEX idx_candles_symbol_timeframe_time ON candles(symbol, timeframe, open_time DESC);

-- Funding rates
CREATE TABLE funding_rates (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    funding_time TIMESTAMPTZ NOT NULL,
    funding_rate DECIMAL(20, 10) NOT NULL,
    mark_price DECIMAL(20, 8),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(symbol, funding_time)
);

CREATE INDEX idx_funding_symbol_time ON funding_rates(symbol, funding_time DESC);

-- Open interest
CREATE TABLE open_interest (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    open_interest DECIMAL(20, 8) NOT NULL,
    open_interest_value DECIMAL(20, 2),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_oi_symbol_time ON open_interest(symbol, recorded_at DESC);

-- Computed indicators (cached)
CREATE TABLE indicators (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    timeframe VARCHAR(10) NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL,
    indicator_name VARCHAR(50) NOT NULL,
    indicator_value DECIMAL(20, 8) NOT NULL,
    parameters JSONB,  -- e.g., {"period": 14}
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(symbol, timeframe, computed_at, indicator_name, parameters)
);

-- Strategy signals
CREATE TABLE signals (
    id SERIAL PRIMARY KEY,
    strategy_name VARCHAR(50) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    signal_time TIMESTAMPTZ NOT NULL,
    direction VARCHAR(10) NOT NULL,  -- 'LONG', 'SHORT', 'CLOSE', 'NONE'
    strength DECIMAL(5, 4),  -- 0.0 to 1.0
    entry_price DECIMAL(20, 8),
    stop_loss DECIMAL(20, 8),
    take_profit DECIMAL(20, 8),
    metadata JSONB,  -- strategy-specific data
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_signals_strategy_time ON signals(strategy_name, signal_time DESC);

-- Executed trades
CREATE TABLE trades (
    id SERIAL PRIMARY KEY,
    trade_id VARCHAR(100) UNIQUE,  -- from Hyperliquid
    strategy_name VARCHAR(50) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(10) NOT NULL,  -- 'BUY', 'SELL'
    direction VARCHAR(10) NOT NULL,  -- 'OPEN_LONG', 'OPEN_SHORT', 'CLOSE_LONG', 'CLOSE_SHORT'
    quantity DECIMAL(20, 8) NOT NULL,
    price DECIMAL(20, 8) NOT NULL,
    fee DECIMAL(20, 8),
    leverage INTEGER,
    executed_at TIMESTAMPTZ NOT NULL,
    order_type VARCHAR(20),  -- 'MARKET', 'LIMIT'
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trades_strategy_time ON trades(strategy_name, executed_at DESC);

-- Current positions
CREATE TABLE positions (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL UNIQUE,
    side VARCHAR(10) NOT NULL,  -- 'LONG', 'SHORT'
    size DECIMAL(20, 8) NOT NULL,
    entry_price DECIMAL(20, 8) NOT NULL,
    leverage INTEGER NOT NULL,
    liquidation_price DECIMAL(20, 8),
    unrealized_pnl DECIMAL(20, 8),
    margin_used DECIMAL(20, 8),
    strategy_name VARCHAR(50),
    opened_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Account state snapshots
CREATE TABLE account_snapshots (
    id SERIAL PRIMARY KEY,
    snapshot_time TIMESTAMPTZ NOT NULL,
    equity DECIMAL(20, 8) NOT NULL,
    available_balance DECIMAL(20, 8) NOT NULL,
    total_margin_used DECIMAL(20, 8),
    unrealized_pnl DECIMAL(20, 8),
    realized_pnl_24h DECIMAL(20, 8),
    peak_equity DECIMAL(20, 8) NOT NULL,
    drawdown_pct DECIMAL(10, 4),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_snapshots_time ON account_snapshots(snapshot_time DESC);

-- Strategy allocations (from MCL)
CREATE TABLE strategy_allocations (
    id SERIAL PRIMARY KEY,
    effective_from TIMESTAMPTZ NOT NULL,
    effective_until TIMESTAMPTZ,
    allocations JSONB NOT NULL,  -- {"funding_signal": 0.25, "momentum": 0.35, ...}
    total_leverage_cap DECIMAL(5, 2),
    reasoning TEXT,
    mcl_decision_id INTEGER REFERENCES mcl_decisions(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Strategy performance metrics
CREATE TABLE strategy_performance (
    id SERIAL PRIMARY KEY,
    strategy_name VARCHAR(50) NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    total_trades INTEGER,
    winning_trades INTEGER,
    losing_trades INTEGER,
    total_pnl DECIMAL(20, 8),
    max_drawdown DECIMAL(10, 4),
    sharpe_ratio DECIMAL(10, 4),
    profit_factor DECIMAL(10, 4),
    avg_win DECIMAL(20, 8),
    avg_loss DECIMAL(20, 8),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_perf_strategy_period ON strategy_performance(strategy_name, period_end DESC);

-- MCL decisions log
CREATE TABLE mcl_decisions (
    id SERIAL PRIMARY KEY,
    decision_time TIMESTAMPTZ NOT NULL,
    decision_type VARCHAR(50) NOT NULL,  -- 'ALLOCATION', 'STRATEGY_DISABLE', 'PARAMETER_CHANGE', etc.
    inputs JSONB NOT NULL,  -- what data MCL saw
    outputs JSONB NOT NULL,  -- what MCL decided
    reasoning TEXT,
    confidence DECIMAL(5, 4),
    llm_model VARCHAR(50),
    tokens_used INTEGER,
    latency_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mcl_decisions_time ON mcl_decisions(decision_time DESC);

-- System health logs
CREATE TABLE system_health (
    id SERIAL PRIMARY KEY,
    check_time TIMESTAMPTZ NOT NULL,
    component VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,  -- 'OK', 'DEGRADED', 'ERROR'
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Alerts log
CREATE TABLE alerts (
    id SERIAL PRIMARY KEY,
    alert_time TIMESTAMPTZ NOT NULL,
    alert_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL,  -- 'INFO', 'WARNING', 'CRITICAL', 'PAUSE'
    title VARCHAR(200) NOT NULL,
    message TEXT,
    acknowledged BOOLEAN DEFAULT FALSE,
    acknowledged_at TIMESTAMPTZ,
    action_taken VARCHAR(50),  -- 'GO', 'STOP', null
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alerts_time ON alerts(alert_time DESC);
CREATE INDEX idx_alerts_unacknowledged ON alerts(acknowledged) WHERE acknowledged = FALSE;

-- System state
CREATE TABLE system_state (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) UNIQUE NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize system state
INSERT INTO system_state (key, value) VALUES
    ('trading_enabled', 'true'),
    ('system_status', '"RUNNING"'),
    ('pause_reason', 'null'),
    ('last_mcl_run', 'null'),
    ('current_allocations', '{"funding_signal": 0.25, "momentum_breakout": 0.25, "mean_reversion": 0.25, "trend_follow": 0.25}'),
    ('peak_equity', '100.0'),
    ('daily_start_equity', '100.0'),
    ('daily_pnl', '0.0');
```

### 3.2 TypeScript Types

```typescript
// src/types/index.ts

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
  strength: number;  // 0.0 to 1.0
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  metadata?: Record<string, any>;
}

export type StrategyName = 'funding_signal' | 'momentum_breakout' | 'mean_reversion' | 'trend_follow';

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
  parameterChanges?: Record<StrategyName, Record<string, any>>;
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
  details?: Record<string, any>;
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
```

---

## 4. Strategy Specifications

### 4.1 Strategy Overview

| Strategy | Market Regime | Edge Source | Typical Hold Time |
|----------|---------------|-------------|-------------------|
| Funding Signal | Any | Funding rate mean reversion | 1-8 hours |
| Momentum Breakout | Trending | Trend continuation | 4-48 hours |
| Mean Reversion | Ranging | Overextension snapback | 15min-4 hours |
| Trend Follow | Trending | Ride established trend | 1-7 days |

### 4.2 Funding Signal Strategy

**Core Logic:** Extreme funding rates indicate crowded positioning. High positive funding = too many longs = fade (go short). High negative funding = too many shorts = fade (go long).

**Entry Conditions:**
```
LONG Entry:
  - funding_rate < -0.01% (annualized < -8.76%)
  - funding_rate_4h_avg < -0.008%
  - price above 20 EMA (not catching falling knife)

SHORT Entry:
  - funding_rate > 0.03% (annualized > 26.28%)
  - funding_rate_4h_avg > 0.02%
  - price below 20 EMA (not shorting into strength)
```

**Exit Conditions:**
```
Exit LONG:
  - funding_rate > 0% (normalized)
  - OR stop_loss hit (entry - 2 * ATR)
  - OR take_profit hit (entry + 3 * ATR)
  - OR max_hold_time exceeded (8 hours)

Exit SHORT:
  - funding_rate < 0.01% (normalized)
  - OR stop_loss hit (entry + 2 * ATR)
  - OR take_profit hit (entry - 3 * ATR)
  - OR max_hold_time exceeded (8 hours)
```

**Position Sizing:**
```
base_size = allocated_capital * 0.5  // use 50% of allocation per trade
leverage = min(10, max_leverage_for_liquidation_at_stop)
position_value = base_size * leverage
```

**Parameters (MCL-tunable):**
```typescript
interface FundingSignalParams {
  entryThresholdLong: number;   // default: -0.0001 (-0.01%)
  entryThresholdShort: number;  // default: 0.0003 (0.03%)
  exitThresholdLong: number;    // default: 0
  exitThresholdShort: number;   // default: 0.0001
  atrMultiplierSL: number;      // default: 2
  atrMultiplierTP: number;      // default: 3
  maxHoldHours: number;         // default: 8
  useEmaFilter: boolean;        // default: true
  emaPeriod: number;            // default: 20
}
```

### 4.3 Momentum Breakout Strategy

**Core Logic:** Enter on volume-confirmed breakouts from consolidation ranges. Crypto trends hard when it breaks out.

**Entry Conditions:**
```
Detect consolidation:
  - 24h price range < 4% (high - low) / low
  - ADX < 25 (no strong trend)

LONG Breakout:
  - price breaks above 24h high
  - volume > 2x 24h average volume
  - RSI > 50

SHORT Breakout:
  - price breaks below 24h low
  - volume > 2x 24h average volume
  - RSI < 50
```

**Exit Conditions:**
```
Exit LONG:
  - price closes below breakout level (failed breakout)
  - OR trailing_stop hit (highest_since_entry - 1.5 * ATR)
  - OR take_profit hit (entry + 5 * ATR)
  - OR RSI > 80 and showing divergence

Exit SHORT:
  - price closes above breakdown level (failed breakdown)
  - OR trailing_stop hit (lowest_since_entry + 1.5 * ATR)
  - OR take_profit hit (entry - 5 * ATR)
  - OR RSI < 20 and showing divergence
```

**Position Sizing:**
```
base_size = allocated_capital * 0.4
leverage = min(8, calculated_for_sl_at_breakout_level)
position_value = base_size * leverage
```

**Parameters (MCL-tunable):**
```typescript
interface MomentumBreakoutParams {
  consolidationMaxRange: number;  // default: 0.04 (4%)
  consolidationPeriodHours: number;  // default: 24
  adxThreshold: number;  // default: 25
  volumeMultiplier: number;  // default: 2
  atrMultiplierTrailingSL: number;  // default: 1.5
  atrMultiplierTP: number;  // default: 5
  rsiOverbought: number;  // default: 80
  rsiOversold: number;  // default: 20
}
```

### 4.4 Mean Reversion Fade Strategy

**Core Logic:** Fade extreme intraday moves expecting snapback to mean. Works best in ranging/choppy markets.

**Entry Conditions:**
```
LONG (fade dump):
  - 1h candle close < -3% from open
  - RSI(14) < 25
  - price touches or pierces lower Bollinger Band (2 std)
  - NOT in strong downtrend (50 EMA > 200 EMA on 4h)

SHORT (fade pump):
  - 1h candle close > +3% from open
  - RSI(14) > 75
  - price touches or pierces upper Bollinger Band (2 std)
  - NOT in strong uptrend (50 EMA < 200 EMA on 4h)
```

**Exit Conditions:**
```
Exit LONG:
  - price reaches 20 EMA (mean)
  - OR RSI > 50 (momentum shifted)
  - OR stop_loss hit (entry - 1.5 * ATR)
  - OR max_hold_time exceeded (4 hours)

Exit SHORT:
  - price reaches 20 EMA (mean)
  - OR RSI < 50 (momentum shifted)
  - OR stop_loss hit (entry + 1.5 * ATR)
  - OR max_hold_time exceeded (4 hours)
```

**Position Sizing:**
```
base_size = allocated_capital * 0.3  // smaller due to counter-trend nature
leverage = min(5, calculated_for_tight_sl)
position_value = base_size * leverage
```

**Parameters (MCL-tunable):**
```typescript
interface MeanReversionParams {
  entryMoveThreshold: number;  // default: 0.03 (3%)
  rsiEntryLong: number;  // default: 25
  rsiEntryShort: number;  // default: 75
  rsiExitLong: number;  // default: 50
  rsiExitShort: number;  // default: 50
  bbPeriod: number;  // default: 20
  bbStdDev: number;  // default: 2
  atrMultiplierSL: number;  // default: 1.5
  maxHoldHours: number;  // default: 4
  trendFilterEnabled: boolean;  // default: true
}
```

### 4.5 Trend Follow Strategy

**Core Logic:** Ride established trends using moving average crossovers with trend strength filter. Let winners run.

**Entry Conditions:**
```
LONG:
  - 20 EMA crosses above 50 EMA (4h timeframe)
  - ADX > 25 (confirmed trend)
  - price > 20 EMA
  - MACD histogram positive and increasing

SHORT:
  - 20 EMA crosses below 50 EMA (4h timeframe)
  - ADX > 25 (confirmed trend)
  - price < 20 EMA
  - MACD histogram negative and decreasing
```

**Exit Conditions:**
```
Exit LONG:
  - 20 EMA crosses below 50 EMA
  - OR ADX drops below 20 (trend exhaustion)
  - OR trailing_stop hit (highest - 2.5 * ATR)
  - OR price closes below 50 EMA twice consecutively

Exit SHORT:
  - 20 EMA crosses above 50 EMA
  - OR ADX drops below 20
  - OR trailing_stop hit (lowest + 2.5 * ATR)
  - OR price closes above 50 EMA twice consecutively
```

**Position Sizing:**
```
base_size = allocated_capital * 0.5
leverage = min(6, calculated_for_wide_trailing_sl)
position_value = base_size * leverage
```

**Parameters (MCL-tunable):**
```typescript
interface TrendFollowParams {
  fastEmaPeriod: number;  // default: 20
  slowEmaPeriod: number;  // default: 50
  adxEntryThreshold: number;  // default: 25
  adxExitThreshold: number;  // default: 20
  atrMultiplierTrailingSL: number;  // default: 2.5
  timeframe: Timeframe;  // default: '4h'
  consecutiveClosesForExit: number;  // default: 2
}
```

### 4.6 Asset Selection Logic

Since the system is asset-agnostic, each strategy scan runs on all available perpetuals. Asset ranking:

```typescript
interface AssetScore {
  symbol: string;
  liquidityScore: number;    // from volume & spread
  volatilityScore: number;   // from ATR/price
  signalStrength: number;    // from strategy
  combinedScore: number;     // weighted combination
}

// Only trade assets meeting minimum criteria
const MIN_24H_VOLUME = 1_000_000;  // $1M
const MAX_SPREAD_PCT = 0.05;       // 0.05%

// Prefer assets where strategy edge is strongest
function rankAssets(strategy: StrategyName, assets: AssetScore[]): AssetScore[] {
  return assets
    .filter(a => a.liquidityScore > MIN_24H_VOLUME)
    .sort((a, b) => b.combinedScore - a.combinedScore);
}
```

---

## 5. Metacognitive Layer Specifications

### 5.1 MCL Cycle Overview

```
Every hour at minute 0:
┌─────────────────────────────────────────────────────────────┐
│                      MCL CYCLE                              │
├─────────────────────────────────────────────────────────────┤
│  1. COLLECT INPUTS (2-3 seconds)                           │
│     - Account state                                         │
│     - Strategy performances (1h, 24h, 7d windows)          │
│     - Recent signals and trades                             │
│     - Market conditions                                     │
│     - System health                                         │
│                                                             │
│  2. SYSTEM EVALUATOR (LLM call ~3-5 seconds)               │
│     - Is system healthy?                                    │
│     - Any anomalies?                                        │
│     - Should we pause?                                      │
│                                                             │
│  3. AGENT EVALUATOR (LLM call ~5-8 seconds)                │
│     - Per-strategy analysis                                 │
│     - What's working, what's not                            │
│     - Regime fit assessment                                 │
│     - Allocation recommendations                            │
│                                                             │
│  4. CONFLICT ARBITRATOR (LLM call ~3-5 seconds)            │
│     - Check for conflicting positions                       │
│     - Resolve allocation sum > 100%                         │
│     - Handle strategy disagreements                         │
│                                                             │
│  5. DECISION ENGINE (deterministic, <100ms)                │
│     - Validate MCL outputs                                  │
│     - Apply constraints                                     │
│     - Generate final allocations                            │
│     - Log decision                                          │
│                                                             │
│  6. APPLY (async)                                          │
│     - Update strategy allocations                           │
│     - Enable/disable strategies                             │
│     - Adjust parameters if needed                           │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 System Evaluator

**Purpose:** Check overall system health, detect anomalies, decide if system should pause.

**Prompt Template:**
```
You are the System Evaluator for an autonomous cryptocurrency trading system.

CURRENT STATE:
- System Status: {{system_status}}
- Trading Enabled: {{trading_enabled}}
- Last MCL Run: {{last_mcl_run}}

ACCOUNT STATE:
- Equity: ${{equity}}
- Peak Equity: ${{peak_equity}}
- Drawdown: {{drawdown_pct}}%
- Available Balance: ${{available_balance}}
- Unrealized P&L: ${{unrealized_pnl}}
- Realized P&L (24h): ${{realized_pnl_24h}}
- Open Positions: {{position_count}}

SYSTEM HEALTH:
{{#each health_checks}}
- {{component}}: {{status}} {{#if details}}({{details}}){{/if}}
{{/each}}

THRESHOLDS:
- Drawdown Warning: -10%
- Drawdown Critical: -15%
- Drawdown Pause: -20%
- Daily Loss Pause: -15%

RECENT ALERTS (last 24h):
{{#each recent_alerts}}
- [{{severity}}] {{title}}: {{message}}
{{/each}}

Evaluate the system and respond in JSON format:
{
  "overall_health": "OK" | "DEGRADED" | "CRITICAL",
  "should_pause": boolean,
  "pause_reason": string | null,
  "risk_level": "NORMAL" | "REDUCED" | "MINIMUM",
  "anomalies_detected": string[],
  "recommendations": string[],
  "confidence": number (0.0 to 1.0)
}

Consider:
1. Is equity trajectory healthy?
2. Are all components functioning?
3. Any concerning patterns in recent alerts?
4. Should we reduce exposure preemptively?
```

### 5.3 Agent Evaluator

**Purpose:** Evaluate each strategy's performance, determine optimal capital allocation.

**Prompt Template:**
```
You are the Agent Evaluator for an autonomous cryptocurrency trading system.

CURRENT ALLOCATIONS:
{{#each current_allocations}}
- {{strategy}}: {{allocation}}%
{{/each}}

STRATEGY PERFORMANCES:

{{#each strategies}}
## {{name}}
### Last 1 Hour:
- Trades: {{perf_1h.total_trades}} ({{perf_1h.winning_trades}}W / {{perf_1h.losing_trades}}L)
- P&L: ${{perf_1h.total_pnl}}
- Consecutive Losses: {{perf_1h.consecutive_losses}}

### Last 24 Hours:
- Trades: {{perf_24h.total_trades}} ({{perf_24h.winning_trades}}W / {{perf_24h.losing_trades}}L)
- P&L: ${{perf_24h.total_pnl}}
- Win Rate: {{perf_24h.win_rate}}%
- Profit Factor: {{perf_24h.profit_factor}}
- Max Drawdown: {{perf_24h.max_drawdown}}%
- Sharpe Ratio: {{perf_24h.sharpe_ratio}}

### Last 7 Days:
- Trades: {{perf_7d.total_trades}} ({{perf_7d.winning_trades}}W / {{perf_7d.losing_trades}}L)
- P&L: ${{perf_7d.total_pnl}}
- Win Rate: {{perf_7d.win_rate}}%
- Profit Factor: {{perf_7d.profit_factor}}
- Max Drawdown: {{perf_7d.max_drawdown}}%

### Current Status:
- Enabled: {{enabled}}
- Open Positions: {{open_positions}}
- Pending Signals: {{pending_signals}}
{{/each}}

MARKET CONDITIONS:
- BTC Trend: {{market.btc_trend}}
- Volatility: {{market.volatility}}
- Dominant Regime: {{market.dominant_regime}}
- Avg Funding Rate: {{market.avg_funding_rate}}%

ACCOUNT CONTEXT:
- Total Equity: ${{equity}}
- Current Drawdown: {{drawdown_pct}}%
- Risk Level (from System Evaluator): {{risk_level}}

EVALUATION RULES:
1. Strategy with 5+ consecutive losses should be DISABLED (requires human approval to re-enable)
2. Total allocations must sum to 100%
3. No strategy can have more than 50% allocation
4. In REDUCED risk mode, prefer lower-risk strategies
5. In MINIMUM risk mode, only keep best-performing strategy at 30% max
6. Weight recent performance (1h, 24h) more than 7d
7. Consider regime fit: momentum/trend work in trends, mean reversion works in ranges

Respond in JSON format:
{
  "strategy_assessments": {
    "funding_signal": {
      "health": "HEALTHY" | "STRUGGLING" | "FAILING",
      "regime_fit": "GOOD" | "NEUTRAL" | "POOR",
      "recommended_allocation": number (0-50),
      "reasoning": string
    },
    // ... same for other strategies
  },
  "disable_strategies": string[],
  "allocation_rationale": string,
  "market_regime_assessment": string,
  "confidence": number (0.0 to 1.0)
}
```

### 5.4 Conflict Arbitrator

**Purpose:** Resolve conflicts between strategies, validate final allocations.

**Prompt Template:**
```
You are the Conflict Arbitrator for an autonomous cryptocurrency trading system.

CURRENT OPEN POSITIONS:
{{#each positions}}
- {{symbol}} {{side}} (Strategy: {{strategy}}, Size: ${{size}}, P&L: {{pnl_pct}}%)
{{/each}}

PENDING SIGNALS (not yet executed):
{{#each pending_signals}}
- {{strategy}}: {{symbol}} {{direction}} (Strength: {{strength}})
{{/each}}

PROPOSED ALLOCATIONS (from Agent Evaluator):
{{#each proposed_allocations}}
- {{strategy}}: {{allocation}}%
{{/each}}

CONFLICT SCENARIOS TO CHECK:

1. OPPOSING SIGNALS: Multiple strategies signaling opposite directions on same asset
   Current conflicts:
   {{#each opposing_signals}}
   - {{symbol}}: {{strategy1}} says {{direction1}}, {{strategy2}} says {{direction2}}
   {{/each}}

2. ALLOCATION OVERFLOW: Proposed allocations sum to {{allocation_sum}}% (must be 100%)

3. POSITION CONFLICTS: Strategy being disabled has open position
   {{#each disabled_with_positions}}
   - {{strategy}} has {{position_count}} open positions
   {{/each}}

4. LEVERAGE OVERFLOW: Combined position leverage would exceed safe limits

RISK CONTEXT:
- Risk Level: {{risk_level}}
- Current Total Leverage: {{current_leverage}}x
- Max Safe Leverage: {{max_safe_leverage}}x

Resolve conflicts and respond in JSON format:
{
  "resolved_allocations": {
    "funding_signal": number,
    "momentum_breakout": number,
    "mean_reversion": number,
    "trend_follow": number
  },
  "signal_resolutions": [
    {
      "symbol": string,
      "chosen_direction": "LONG" | "SHORT" | "NONE",
      "chosen_strategy": string,
      "reasoning": string
    }
  ],
  "position_actions": [
    {
      "symbol": string,
      "action": "KEEP" | "CLOSE",
      "reasoning": string
    }
  ],
  "leverage_cap": number,
  "adjustments_made": string[],
  "confidence": number (0.0 to 1.0)
}
```

### 5.5 Decision Engine

**Purpose:** Validate MCL outputs, apply hard constraints, produce final executable decisions.

```typescript
// src/mcl/decision-engine.ts

interface MCLDecisionEngineInput {
  systemEvaluation: SystemEvaluatorOutput;
  agentEvaluation: AgentEvaluatorOutput;
  conflictResolution: ConflictArbitratorOutput;
  currentState: AccountState;
}

interface MCLDecisionEngineOutput {
  finalAllocations: StrategyAllocation;
  strategiesToDisable: StrategyName[];
  strategiesToEnable: StrategyName[];
  positionsToClose: string[];  // symbols
  leverageCap: number;
  riskLevel: 'NORMAL' | 'REDUCED' | 'MINIMUM';
  shouldPause: boolean;
  pauseReason?: string;
  reasoning: string;
}

function runDecisionEngine(input: MCLDecisionEngineInput): MCLDecisionEngineOutput {
  const { systemEvaluation, agentEvaluation, conflictResolution, currentState } = input;

  // HARD CONSTRAINTS (override MCL)
  
  // 1. Pause on critical conditions
  if (systemEvaluation.should_pause) {
    return {
      finalAllocations: { funding_signal: 0, momentum_breakout: 0, mean_reversion: 0, trend_follow: 0 },
      strategiesToDisable: ['funding_signal', 'momentum_breakout', 'mean_reversion', 'trend_follow'],
      strategiesToEnable: [],
      positionsToClose: currentState.positions.map(p => p.symbol),
      leverageCap: 0,
      riskLevel: 'MINIMUM',
      shouldPause: true,
      pauseReason: systemEvaluation.pause_reason,
      reasoning: `System pause triggered: ${systemEvaluation.pause_reason}`
    };
  }

  // 2. Validate allocations sum to 100%
  let allocations = conflictResolution.resolved_allocations;
  const sum = Object.values(allocations).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.01) {
    // Normalize
    allocations = Object.fromEntries(
      Object.entries(allocations).map(([k, v]) => [k, (v / sum) * 100])
    ) as StrategyAllocation;
  }

  // 3. Cap individual allocations at 50%
  allocations = Object.fromEntries(
    Object.entries(allocations).map(([k, v]) => [k, Math.min(v, 50)])
  ) as StrategyAllocation;

  // Re-normalize after capping
  const cappedSum = Object.values(allocations).reduce((a, b) => a + b, 0);
  if (cappedSum < 100) {
    // Distribute remainder proportionally
    const factor = 100 / cappedSum;
    allocations = Object.fromEntries(
      Object.entries(allocations).map(([k, v]) => [k, v * factor])
    ) as StrategyAllocation;
  }

  // 4. Apply risk level constraints
  let leverageCap = conflictResolution.leverage_cap || 10;
  const riskLevel = systemEvaluation.risk_level;
  
  if (riskLevel === 'REDUCED') {
    leverageCap = Math.min(leverageCap, 5);
    // Reduce all allocations by 30%
    allocations = Object.fromEntries(
      Object.entries(allocations).map(([k, v]) => [k, v * 0.7])
    ) as StrategyAllocation;
  } else if (riskLevel === 'MINIMUM') {
    leverageCap = Math.min(leverageCap, 3);
    // Only keep top strategy at 30%
    const topStrategy = Object.entries(allocations).sort((a, b) => b[1] - a[1])[0][0];
    allocations = {
      funding_signal: 0,
      momentum_breakout: 0,
      mean_reversion: 0,
      trend_follow: 0,
      [topStrategy]: 30
    } as StrategyAllocation;
  }

  // 5. Handle strategy disabling
  const strategiesToDisable = agentEvaluation.disable_strategies || [];
  
  // 6. Positions to close (from disabled strategies)
  const positionsToClose = conflictResolution.position_actions
    ?.filter(p => p.action === 'CLOSE')
    .map(p => p.symbol) || [];

  return {
    finalAllocations: allocations,
    strategiesToDisable,
    strategiesToEnable: [],  // requires human approval
    positionsToClose,
    leverageCap,
    riskLevel,
    shouldPause: false,
    reasoning: buildReasoningSummary(systemEvaluation, agentEvaluation, conflictResolution)
  };
}
```

### 5.6 MCL Anomaly Detection

Detect and reject nonsensical MCL outputs:

```typescript
// src/mcl/anomaly-detector.ts

interface AnomalyCheckResult {
  isValid: boolean;
  anomalies: string[];
}

function checkForAnomalies(
  output: any,
  evaluatorType: 'system' | 'agent' | 'conflict'
): AnomalyCheckResult {
  const anomalies: string[] = [];

  // 1. Check for valid JSON structure
  if (!output || typeof output !== 'object') {
    anomalies.push('Output is not valid JSON object');
    return { isValid: false, anomalies };
  }

  // 2. Check confidence bounds
  if (output.confidence !== undefined) {
    if (output.confidence < 0 || output.confidence > 1) {
      anomalies.push(`Confidence ${output.confidence} outside valid range [0,1]`);
    }
    if (output.confidence < 0.3) {
      anomalies.push(`Very low confidence (${output.confidence}), MCL uncertain`);
    }
  }

  // 3. Check for allocation validity (agent evaluator)
  if (evaluatorType === 'agent' && output.strategy_assessments) {
    const allocations = Object.values(output.strategy_assessments)
      .map((s: any) => s.recommended_allocation || 0);
    
    const sum = allocations.reduce((a: number, b: number) => a + b, 0);
    if (sum > 150) {
      anomalies.push(`Allocation sum ${sum}% exceeds 150%, likely hallucination`);
    }
    
    allocations.forEach((alloc: number, i: number) => {
      if (alloc < 0 || alloc > 100) {
        anomalies.push(`Invalid allocation value: ${alloc}`);
      }
    });
  }

  // 4. Check for contradictions
  if (evaluatorType === 'system') {
    if (output.overall_health === 'OK' && output.should_pause) {
      anomalies.push('Contradiction: health OK but should_pause true');
    }
    if (output.overall_health === 'CRITICAL' && !output.should_pause && output.risk_level === 'NORMAL') {
      anomalies.push('Contradiction: health CRITICAL but no protective action');
    }
  }

  // 5. Check for empty/missing required fields
  const requiredFields: Record<string, string[]> = {
    system: ['overall_health', 'should_pause', 'risk_level'],
    agent: ['strategy_assessments', 'allocation_rationale'],
    conflict: ['resolved_allocations', 'leverage_cap']
  };

  requiredFields[evaluatorType].forEach(field => {
    if (output[field] === undefined || output[field] === null) {
      anomalies.push(`Missing required field: ${field}`);
    }
  });

  return {
    isValid: anomalies.length === 0,
    anomalies
  };
}
```

---

## 6. Hyperliquid API Integration

### 6.1 API Overview

| Endpoint Type | Base URL | Purpose |
|---------------|----------|---------|
| REST Info | https://api.hyperliquid.xyz/info | Market data, account info |
| REST Exchange | https://api.hyperliquid.xyz/exchange | Order execution |
| WebSocket | wss://api.hyperliquid.xyz/ws | Real-time data |

### 6.2 Authentication

Hyperliquid uses Ethereum wallet signatures. You need:
- Private key (keep secure!)
- Wallet address derived from private key

```typescript
// src/hyperliquid/auth.ts
import { ethers } from 'ethers';

export class HyperliquidAuth {
  private wallet: ethers.Wallet;
  
  constructor(privateKey: string) {
    this.wallet = new ethers.Wallet(privateKey);
  }

  get address(): string {
    return this.wallet.address;
  }

  async signL1Action(action: any, nonce: number): Promise<{ r: string; s: string; v: number }> {
    const message = this.constructMessage(action, nonce);
    const signature = await this.wallet.signMessage(message);
    return ethers.utils.splitSignature(signature);
  }

  private constructMessage(action: any, nonce: number): string {
    // Hyperliquid-specific message construction
    const actionHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(JSON.stringify(action))
    );
    return ethers.utils.arrayify(
      ethers.utils.solidityKeccak256(
        ['bytes32', 'uint64'],
        [actionHash, nonce]
      )
    );
  }
}
```

### 6.3 REST API Client

```typescript
// src/hyperliquid/rest-client.ts

import axios, { AxiosInstance } from 'axios';

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';

export class HyperliquidRestClient {
  private client: AxiosInstance;
  private auth: HyperliquidAuth;

  constructor(auth: HyperliquidAuth) {
    this.auth = auth;
    this.client = axios.create({
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ===== INFO ENDPOINTS =====

  async getMeta(): Promise<Meta> {
    const response = await this.client.post(INFO_URL, { type: 'meta' });
    return response.data;
  }

  async getAllMids(): Promise<Record<string, string>> {
    const response = await this.client.post(INFO_URL, { type: 'allMids' });
    return response.data;
  }

  async getAccountState(address?: string): Promise<AccountInfo> {
    const response = await this.client.post(INFO_URL, {
      type: 'clearinghouseState',
      user: address || this.auth.address
    });
    return response.data;
  }

  async getOpenOrders(address?: string): Promise<OpenOrder[]> {
    const response = await this.client.post(INFO_URL, {
      type: 'openOrders',
      user: address || this.auth.address
    });
    return response.data;
  }

  async getUserFills(address?: string): Promise<Fill[]> {
    const response = await this.client.post(INFO_URL, {
      type: 'userFills',
      user: address || this.auth.address
    });
    return response.data;
  }

  async getFundingHistory(coin: string, startTime: number, endTime?: number): Promise<FundingHistory[]> {
    const response = await this.client.post(INFO_URL, {
      type: 'fundingHistory',
      coin,
      startTime,
      endTime: endTime || Date.now()
    });
    return response.data;
  }

  async getCandles(coin: string, interval: string, startTime: number, endTime?: number): Promise<Candle[]> {
    const response = await this.client.post(INFO_URL, {
      type: 'candleSnapshot',
      req: {
        coin,
        interval,
        startTime,
        endTime: endTime || Date.now()
      }
    });
    return response.data;
  }

  // ===== EXCHANGE ENDPOINTS =====

  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    const nonce = Date.now();
    const action = {
      type: 'order',
      orders: [{
        a: order.asset,  // asset index
        b: order.isBuy,
        p: order.price.toString(),
        s: order.size.toString(),
        r: order.reduceOnly || false,
        t: order.orderType || { limit: { tif: 'Gtc' } }
      }],
      grouping: 'na'
    };

    const signature = await this.auth.signL1Action(action, nonce);

    const response = await this.client.post(EXCHANGE_URL, {
      action,
      nonce,
      signature
    });

    return response.data;
  }

  async cancelOrder(coin: string, oid: number): Promise<CancelResponse> {
    const nonce = Date.now();
    const action = {
      type: 'cancel',
      cancels: [{ a: this.coinToAssetIndex(coin), o: oid }]
    };

    const signature = await this.auth.signL1Action(action, nonce);

    const response = await this.client.post(EXCHANGE_URL, {
      action,
      nonce,
      signature
    });

    return response.data;
  }

  async updateLeverage(coin: string, leverage: number, isCross: boolean = true): Promise<any> {
    const nonce = Date.now();
    const action = {
      type: 'updateLeverage',
      asset: this.coinToAssetIndex(coin),
      isCross,
      leverage
    };

    const signature = await this.auth.signL1Action(action, nonce);

    const response = await this.client.post(EXCHANGE_URL, {
      action,
      nonce,
      signature
    });

    return response.data;
  }

  private coinToAssetIndex(coin: string): number {
    // Map coin symbol to asset index (from meta)
    // This should be cached from getMeta()
    return this.assetIndexMap[coin];
  }
}
```

### 6.4 WebSocket Client

```typescript
// src/hyperliquid/ws-client.ts

import WebSocket from 'ws';
import { EventEmitter } from 'events';

const WS_URL = 'wss://api.hyperliquid.xyz/ws';

export class HyperliquidWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private subscriptions: Map<string, any> = new Map();

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        this.resubscribe();
        resolve();
      });

      this.ws.on('message', (data: string) => {
        this.handleMessage(JSON.parse(data));
      });

      this.ws.on('close', () => {
        console.log('WebSocket closed');
        this.handleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });
    });
  }

  private handleMessage(message: any) {
    const { channel, data } = message;

    switch (channel) {
      case 'trades':
        this.emit('trades', data);
        break;
      case 'l2Book':
        this.emit('orderbook', data);
        break;
      case 'candle':
        this.emit('candle', data);
        break;
      case 'userEvents':
        this.emit('userEvents', data);
        break;
      default:
        this.emit('message', message);
    }
  }

  subscribeTrades(coin: string): void {
    const sub = { method: 'subscribe', subscription: { type: 'trades', coin } };
    this.subscriptions.set(`trades:${coin}`, sub);
    this.send(sub);
  }

  subscribeOrderbook(coin: string): void {
    const sub = { method: 'subscribe', subscription: { type: 'l2Book', coin } };
    this.subscriptions.set(`l2Book:${coin}`, sub);
    this.send(sub);
  }

  subscribeCandles(coin: string, interval: string): void {
    const sub = { method: 'subscribe', subscription: { type: 'candle', coin, interval } };
    this.subscriptions.set(`candle:${coin}:${interval}`, sub);
    this.send(sub);
  }

  subscribeUserEvents(address: string): void {
    const sub = { method: 'subscribe', subscription: { type: 'userEvents', user: address } };
    this.subscriptions.set(`userEvents:${address}`, sub);
    this.send(sub);
  }

  private send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private resubscribe(): void {
    for (const sub of this.subscriptions.values()) {
      this.send(sub);
    }
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      setTimeout(() => this.connect(), delay);
    } else {
      this.emit('maxReconnectReached');
    }
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}
```

### 6.5 Historical Data Fetcher

```typescript
// src/data/historical-fetcher.ts

export class HistoricalDataFetcher {
  private client: HyperliquidRestClient;
  private db: Database;

  constructor(client: HyperliquidRestClient, db: Database) {
    this.client = client;
    this.db = db;
  }

  async fetchAllHistoricalData(): Promise<void> {
    const meta = await this.client.getMeta();
    const coins = meta.universe.map(u => u.name);

    console.log(`Fetching historical data for ${coins.length} coins...`);

    for (const coin of coins) {
      await this.fetchCoinHistory(coin);
      await this.fetchFundingHistory(coin);
      // Rate limit: pause between coins
      await sleep(500);
    }

    console.log('Historical data fetch complete');
  }

  private async fetchCoinHistory(coin: string): Promise<void> {
    const intervals = ['1m', '5m', '15m', '1h', '4h', '1d'];
    
    for (const interval of intervals) {
      let startTime = this.getDefaultStartTime(interval);
      const endTime = Date.now();

      while (startTime < endTime) {
        const candles = await this.client.getCandles(coin, interval, startTime, endTime);
        
        if (candles.length === 0) break;

        await this.db.insertCandles(candles.map(c => ({
          symbol: coin,
          timeframe: interval,
          openTime: new Date(c.t),
          open: parseFloat(c.o),
          high: parseFloat(c.h),
          low: parseFloat(c.l),
          close: parseFloat(c.c),
          volume: parseFloat(c.v)
        })));

        startTime = candles[candles.length - 1].t + 1;
        await sleep(100);  // Rate limit
      }

      console.log(`  ${coin} ${interval}: fetched`);
    }
  }

  private async fetchFundingHistory(coin: string): Promise<void> {
    const startTime = Date.now() - 90 * 24 * 60 * 60 * 1000;  // 90 days
    const fundingHistory = await this.client.getFundingHistory(coin, startTime);

    await this.db.insertFundingRates(fundingHistory.map(f => ({
      symbol: coin,
      fundingTime: new Date(f.time),
      fundingRate: parseFloat(f.fundingRate),
      markPrice: parseFloat(f.premium)
    })));

    console.log(`  ${coin} funding: fetched ${fundingHistory.length} records`);
  }

  private getDefaultStartTime(interval: string): number {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    
    // Fetch different amounts based on interval
    switch (interval) {
      case '1m': return now - 7 * day;      // 7 days of 1m
      case '5m': return now - 30 * day;     // 30 days of 5m
      case '15m': return now - 60 * day;    // 60 days of 15m
      case '1h': return now - 90 * day;     // 90 days of 1h
      case '4h': return now - 180 * day;    // 180 days of 4h
      case '1d': return now - 365 * day;    // 365 days of 1d
      default: return now - 30 * day;
    }
  }
}
```

---

## 7. Execution Engine

### 7.1 Order Manager

```typescript
// src/execution/order-manager.ts

export class OrderManager {
  private client: HyperliquidRestClient;
  private riskManager: RiskManager;
  private positionTracker: PositionTracker;
  private db: Database;

  async executeSignal(signal: Signal, allocation: number, equity: number): Promise<TradeResult> {
    // 1. Pre-trade risk checks
    const riskCheck = await this.riskManager.checkPreTrade(signal, allocation, equity);
    if (!riskCheck.approved) {
      return { success: false, reason: riskCheck.reason };
    }

    // 2. Calculate position size
    const positionSize = this.calculatePositionSize(signal, allocation, equity, riskCheck.maxLeverage);

    // 3. Get current price
    const currentPrice = await this.getCurrentPrice(signal.symbol);

    // 4. Determine order type and price
    const orderParams = this.buildOrderParams(signal, positionSize, currentPrice);

    // 5. Set leverage if needed
    await this.client.updateLeverage(signal.symbol, orderParams.leverage);

    // 6. Execute order
    try {
      const result = await this.client.placeOrder(orderParams);
      
      if (result.status === 'ok') {
        // 7. Log trade
        await this.db.insertTrade({
          tradeId: result.response.data.statuses[0].resting?.oid || result.response.data.statuses[0].filled?.oid,
          strategyName: signal.strategyName,
          symbol: signal.symbol,
          side: signal.direction.includes('LONG') ? 'BUY' : 'SELL',
          direction: signal.direction,
          quantity: positionSize.size,
          price: currentPrice,
          leverage: orderParams.leverage,
          executedAt: new Date()
        });

        // 8. Update position tracker
        await this.positionTracker.updatePosition(signal.symbol);

        return { success: true, orderId: result.response.data.statuses[0].resting?.oid };
      } else {
        return { success: false, reason: result.response };
      }
    } catch (error) {
      console.error('Order execution error:', error);
      return { success: false, reason: error.message };
    }
  }

  private calculatePositionSize(
    signal: Signal,
    allocation: number,
    equity: number,
    maxLeverage: number
  ): PositionSizeResult {
    const allocatedCapital = equity * (allocation / 100);
    
    // Strategy-specific sizing
    const strategyConfig = STRATEGY_CONFIGS[signal.strategyName];
    const baseSize = allocatedCapital * strategyConfig.capitalUtilization;
    
    // Calculate leverage based on stop loss distance
    let leverage = maxLeverage;
    if (signal.stopLoss && signal.entryPrice) {
      const slDistance = Math.abs(signal.entryPrice - signal.stopLoss) / signal.entryPrice;
      // Max loss per trade = 8% of equity (from our thresholds)
      const maxLossPerTrade = equity * 0.08;
      const requiredMargin = maxLossPerTrade / slDistance;
      leverage = Math.min(maxLeverage, baseSize / requiredMargin);
    }

    const positionValue = baseSize * leverage;

    return {
      size: positionValue / signal.entryPrice!,
      leverage: Math.floor(leverage),
      marginRequired: baseSize
    };
  }

  private buildOrderParams(signal: Signal, size: PositionSizeResult, currentPrice: number): OrderRequest {
    // Use market order for immediate execution
    // In production, might use limit orders slightly through the book
    return {
      asset: this.getAssetIndex(signal.symbol),
      isBuy: signal.direction.includes('LONG'),
      price: currentPrice,  // For market order, use current price
      size: size.size,
      leverage: size.leverage,
      orderType: { market: {} },  // Market order
      reduceOnly: signal.direction.includes('CLOSE')
    };
  }
}
```

### 7.2 Position Tracker

```typescript
// src/execution/position-tracker.ts

export class PositionTracker {
  private client: HyperliquidRestClient;
  private db: Database;
  private positions: Map<string, Position> = new Map();

  async initialize(): Promise<void> {
    await this.syncPositions();
  }

  async syncPositions(): Promise<void> {
    const accountState = await this.client.getAccountState();
    
    this.positions.clear();
    
    for (const pos of accountState.assetPositions) {
      if (parseFloat(pos.position.szi) !== 0) {
        const position: Position = {
          symbol: pos.position.coin,
          side: parseFloat(pos.position.szi) > 0 ? 'LONG' : 'SHORT',
          size: Math.abs(parseFloat(pos.position.szi)),
          entryPrice: parseFloat(pos.position.entryPx),
          leverage: pos.position.leverage.value,
          liquidationPrice: parseFloat(pos.position.liquidationPx) || undefined,
          unrealizedPnl: parseFloat(pos.position.unrealizedPnl),
          marginUsed: parseFloat(pos.position.marginUsed),
          strategyName: await this.getStrategyForPosition(pos.position.coin),
          openedAt: new Date()  // Would need to track this separately
        };
        
        this.positions.set(pos.position.coin, position);
      }
    }

    // Sync to database
    await this.db.syncPositions([...this.positions.values()]);
  }

  async updatePosition(symbol: string): Promise<void> {
    await this.syncPositions();
  }

  getPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  getAllPositions(): Position[] {
    return [...this.positions.values()];
  }

  getTotalUnrealizedPnl(): number {
    return [...this.positions.values()].reduce((sum, p) => sum + p.unrealizedPnl, 0);
  }

  getTotalMarginUsed(): number {
    return [...this.positions.values()].reduce((sum, p) => sum + p.marginUsed, 0);
  }
}
```

### 7.3 Risk Manager

```typescript
// src/execution/risk-manager.ts

export class RiskManager {
  private db: Database;
  private alertManager: AlertManager;
  private positionTracker: PositionTracker;

  // Thresholds from spec
  private readonly DRAWDOWN_WARNING = -10;
  private readonly DRAWDOWN_CRITICAL = -15;
  private readonly DRAWDOWN_PAUSE = -20;
  private readonly DAILY_LOSS_PAUSE = -15;
  private readonly SINGLE_TRADE_LOSS_ALERT = -8;

  async checkPreTrade(signal: Signal, allocation: number, equity: number): Promise<RiskCheckResult> {
    const checks: string[] = [];

    // 1. Check if trading is enabled
    const systemState = await this.db.getSystemState();
    if (!systemState.tradingEnabled) {
      return { approved: false, reason: 'Trading is paused', maxLeverage: 0 };
    }

    // 2. Check drawdown
    const drawdown = ((equity - systemState.peakEquity) / systemState.peakEquity) * 100;
    if (drawdown <= this.DRAWDOWN_PAUSE) {
      await this.triggerPause('DRAWDOWN', `Drawdown ${drawdown.toFixed(2)}% exceeded -20% threshold`);
      return { approved: false, reason: 'Drawdown pause triggered', maxLeverage: 0 };
    }

    // 3. Check daily loss
    const dailyPnlPct = ((equity - systemState.dailyStartEquity) / systemState.dailyStartEquity) * 100;
    if (dailyPnlPct <= this.DAILY_LOSS_PAUSE) {
      await this.triggerPause('DAILY_LOSS', `Daily loss ${dailyPnlPct.toFixed(2)}% exceeded -15% threshold`);
      return { approved: false, reason: 'Daily loss pause triggered', maxLeverage: 0 };
    }

    // 4. Check existing position conflict
    const existingPosition = this.positionTracker.getPosition(signal.symbol);
    if (existingPosition) {
      // Can't open opposite direction without closing first
      if ((existingPosition.side === 'LONG' && signal.direction === 'OPEN_SHORT') ||
          (existingPosition.side === 'SHORT' && signal.direction === 'OPEN_LONG')) {
        return { approved: false, reason: 'Conflicting position exists', maxLeverage: 0 };
      }
    }

    // 5. Calculate max leverage based on risk level
    let maxLeverage = 10;  // Default
    if (drawdown <= this.DRAWDOWN_CRITICAL) {
      maxLeverage = 3;
      checks.push('Leverage capped to 3x due to critical drawdown');
    } else if (drawdown <= this.DRAWDOWN_WARNING) {
      maxLeverage = 5;
      checks.push('Leverage capped to 5x due to drawdown warning');
    }

    // 6. Check total exposure wouldn't exceed safe limits
    const currentMargin = this.positionTracker.getTotalMarginUsed();
    const newPositionMargin = equity * (allocation / 100) * 0.5;  // Rough estimate
    if (currentMargin + newPositionMargin > equity * 0.8) {
      maxLeverage = Math.min(maxLeverage, 3);
      checks.push('Leverage reduced due to high total exposure');
    }

    return {
      approved: true,
      maxLeverage,
      checks
    };
  }

  async runContinuousChecks(equity: number): Promise<void> {
    const systemState = await this.db.getSystemState();
    
    // Update peak equity
    if (equity > systemState.peakEquity) {
      await this.db.updateSystemState('peak_equity', equity);
    }

    const drawdown = ((equity - systemState.peakEquity) / systemState.peakEquity) * 100;
    const dailyPnlPct = ((equity - systemState.dailyStartEquity) / systemState.dailyStartEquity) * 100;

    // Check thresholds
    if (drawdown <= this.DRAWDOWN_PAUSE) {
      await this.triggerPause('DRAWDOWN', `Drawdown ${drawdown.toFixed(2)}% exceeded -20%`);
    } else if (drawdown <= this.DRAWDOWN_CRITICAL) {
      await this.alertManager.send({
        alertType: 'DRAWDOWN_CRITICAL',
        severity: 'CRITICAL',
        title: 'Critical Drawdown Warning',
        message: `Drawdown at ${drawdown.toFixed(2)}%. System at minimum exposure.`
      });
    } else if (drawdown <= this.DRAWDOWN_WARNING) {
      await this.alertManager.send({
        alertType: 'DRAWDOWN_WARNING',
        severity: 'WARNING',
        title: 'Drawdown Warning',
        message: `Drawdown at ${drawdown.toFixed(2)}%. Exposure reduced.`
      });
    }

    if (dailyPnlPct <= this.DAILY_LOSS_PAUSE) {
      await this.triggerPause('DAILY_LOSS', `Daily loss ${dailyPnlPct.toFixed(2)}% exceeded -15%`);
    }
  }

  private async triggerPause(reason: string, details: string): Promise<void> {
    // 1. Update system state
    await this.db.updateSystemState('trading_enabled', false);
    await this.db.updateSystemState('system_status', 'PAUSED');
    await this.db.updateSystemState('pause_reason', details);

    // 2. Close all positions
    const positions = this.positionTracker.getAllPositions();
    for (const pos of positions) {
      // Close position logic
    }

    // 3. Send alert requiring human action
    await this.alertManager.sendPauseAlert(reason, details);
  }
}
```

---

## 8. Monitoring System

### 8.1 Telegram Bot

```typescript
// src/monitoring/telegram-bot.ts

import TelegramBot from 'node-telegram-bot-api';

export class TradingTelegramBot {
  private bot: TelegramBot;
  private chatId: string;
  private db: Database;
  private systemController: SystemController;

  constructor(token: string, chatId: string) {
    this.bot = new TelegramBot(token, { polling: true });
    this.chatId = chatId;
    this.setupCommands();
  }

  private setupCommands(): void {
    this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
    this.bot.onText(/\/status/, (msg) => this.handleStatus(msg));
    this.bot.onText(/\/positions/, (msg) => this.handlePositions(msg));
    this.bot.onText(/\/report/, (msg) => this.handleReport(msg));
    this.bot.onText(/\/help/, (msg) => this.handleHelp(msg));
    this.bot.onText(/^GO$/i, (msg) => this.handleGo(msg));
    this.bot.onText(/^STOP$/i, (msg) => this.handleStop(msg));
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    await this.bot.sendMessage(msg.chat.id, 
      `🤖 Hyperliquid Trading Bot\n\n` +
      `Commands:\n` +
      `/status - System status\n` +
      `/positions - Open positions\n` +
      `/report - Generate report\n` +
      `/help - Show help\n\n` +
      `Reply GO to resume from pause\n` +
      `Reply STOP to shutdown`
    );
  }

  private async handleStatus(msg: TelegramBot.Message): Promise<void> {
    const state = await this.db.getSystemState();
    const account = await this.systemController.getAccountState();
    
    const statusEmoji = {
      'RUNNING': '✅',
      'PAUSED': '⏸️',
      'ERROR': '❌',
      'STOPPED': '🛑'
    }[state.systemStatus];

    await this.bot.sendMessage(msg.chat.id,
      `${statusEmoji} *System Status*\n\n` +
      `Status: ${state.systemStatus}\n` +
      `Trading: ${state.tradingEnabled ? 'Enabled' : 'Disabled'}\n` +
      `${state.pauseReason ? `Pause Reason: ${state.pauseReason}\n` : ''}` +
      `\n💰 *Account*\n` +
      `Equity: $${account.equity.toFixed(2)}\n` +
      `Available: $${account.availableBalance.toFixed(2)}\n` +
      `Unrealized P&L: $${account.unrealizedPnl.toFixed(2)}\n` +
      `Drawdown: ${account.drawdownPct.toFixed(2)}%\n` +
      `\n📊 *Allocations*\n` +
      Object.entries(state.currentAllocations)
        .map(([s, a]) => `${s}: ${a}%`)
        .join('\n'),
      { parse_mode: 'Markdown' }
    );
  }

  private async handlePositions(msg: TelegramBot.Message): Promise<void> {
    const positions = await this.systemController.getPositions();
    
    if (positions.length === 0) {
      await this.bot.sendMessage(msg.chat.id, '📭 No open positions');
      return;
    }

    const positionText = positions.map(p => 
      `*${p.symbol}* ${p.side}\n` +
      `  Size: ${p.size.toFixed(4)}\n` +
      `  Entry: $${p.entryPrice.toFixed(2)}\n` +
      `  P&L: $${p.unrealizedPnl.toFixed(2)} (${((p.unrealizedPnl / p.marginUsed) * 100).toFixed(2)}%)\n` +
      `  Strategy: ${p.strategyName}`
    ).join('\n\n');

    await this.bot.sendMessage(msg.chat.id,
      `📊 *Open Positions*\n\n${positionText}`,
      { parse_mode: 'Markdown' }
    );
  }

  private async handleGo(msg: TelegramBot.Message): Promise<void> {
    const state = await this.db.getSystemState();
    
    if (state.systemStatus !== 'PAUSED') {
      await this.bot.sendMessage(msg.chat.id, '⚠️ System is not paused');
      return;
    }

    // Generate analysis report
    const analysis = await this.systemController.generatePauseAnalysis();
    
    await this.bot.sendMessage(msg.chat.id,
      `📋 *Analysis Report*\n\n` +
      `Pause Reason: ${state.pauseReason}\n\n` +
      `*What Happened:*\n${analysis.whatHappened}\n\n` +
      `*Root Cause:*\n${analysis.rootCause}\n\n` +
      `*MCL Assessment:*\n${analysis.mclAssessment}\n\n` +
      `Confirm resume? Reply GO again to confirm.`,
      { parse_mode: 'Markdown' }
    );

    // Set confirmation flag
    await this.db.updateSystemState('awaiting_go_confirm', true);
  }

  private async handleStop(msg: TelegramBot.Message): Promise<void> {
    await this.bot.sendMessage(msg.chat.id,
      `⚠️ *Shutdown Requested*\n\n` +
      `This will:\n` +
      `• Close all open positions\n` +
      `• Stop all trading\n` +
      `• Require manual restart\n\n` +
      `Reply STOP again to confirm.`,
      { parse_mode: 'Markdown' }
    );

    await this.db.updateSystemState('awaiting_stop_confirm', true);
  }

  // === Alert Methods ===

  async sendAlert(alert: Alert): Promise<void> {
    const severityEmoji = {
      'INFO': 'ℹ️',
      'WARNING': '⚠️',
      'CRITICAL': '🚨',
      'PAUSE': '🛑'
    }[alert.severity];

    await this.bot.sendMessage(this.chatId,
      `${severityEmoji} *${alert.title}*\n\n${alert.message}`,
      { parse_mode: 'Markdown' }
    );
  }

  async sendPauseAlert(reason: string, details: string, analysis: PauseAnalysis): Promise<void> {
    await this.bot.sendMessage(this.chatId,
      `🛑 *TRADING PAUSED - HUMAN DECISION REQUIRED*\n\n` +
      `*Reason:* ${reason}\n` +
      `*Details:* ${details}\n\n` +
      `*What Happened:*\n${analysis.whatHappened}\n\n` +
      `*Root Cause Analysis:*\n${analysis.rootCause}\n\n` +
      `*MCL Assessment:*\n${analysis.mclAssessment}\n\n` +
      `Reply:\n` +
      `  *GO* - Resume trading\n` +
      `  *STOP* - Shutdown system\n` +
      `  *STATUS* - Get current state`,
      { parse_mode: 'Markdown' }
    );
  }

  async sendDailyReport(report: DailyReport): Promise<void> {
    const pnlEmoji = report.pnlChange >= 0 ? '📈' : '📉';
    
    await this.bot.sendMessage(this.chatId,
      `📊 *DAILY REPORT - ${report.date}*\n\n` +
      `💰 *EQUITY*\n` +
      `  Start: $${report.startEquity.toFixed(2)}\n` +
      `  End: $${report.endEquity.toFixed(2)}\n` +
      `  Change: ${pnlEmoji} $${report.pnlChange.toFixed(2)} (${report.pnlChangePct.toFixed(2)}%)\n` +
      `  Peak: $${report.peakEquity.toFixed(2)}\n` +
      `  Drawdown: ${report.drawdownPct.toFixed(2)}%\n\n` +
      `📈 *STRATEGY PERFORMANCE (24h)*\n` +
      report.strategyPerformances.map(s =>
        `  ${s.name}: ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)} (${s.trades} trades, ${s.wins}W/${s.losses}L)`
      ).join('\n') + `\n\n` +
      `⚙️ *MCL DECISIONS*\n` +
      report.mclDecisions.map(d => `  • ${d}`).join('\n') + `\n\n` +
      `📊 *CURRENT STATE*\n` +
      `  Open positions: ${report.openPositions}\n` +
      `  Allocations: ${Object.entries(report.allocations).map(([k,v]) => `[${k} ${v}%]`).join(' ')}\n` +
      `  System health: ${report.systemHealth}\n\n` +
      `🔗 Dashboard: ${report.dashboardUrl}`,
      { parse_mode: 'Markdown' }
    );
  }
}
```

### 8.2 Dashboard Server

```typescript
// src/monitoring/dashboard-server.ts

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';

export class DashboardServer {
  private app: express.Application;
  private httpServer: any;
  private io: SocketIOServer;
  private db: Database;
  private systemController: SystemController;

  constructor(port: number, db: Database, systemController: SystemController) {
    this.app = express();
    this.httpServer = createServer(this.app);
    this.io = new SocketIOServer(this.httpServer);
    this.db = db;
    this.systemController = systemController;

    this.setupRoutes();
    this.setupWebSocket();
    this.httpServer.listen(port);
  }

  private setupRoutes(): void {
    // Serve static dashboard files
    this.app.use(express.static(path.join(__dirname, 'public')));
    this.app.use(express.json());

    // API endpoints
    this.app.get('/api/status', async (req, res) => {
      const state = await this.db.getSystemState();
      const account = await this.systemController.getAccountState();
      res.json({ state, account });
    });

    this.app.get('/api/positions', async (req, res) => {
      const positions = await this.systemController.getPositions();
      res.json(positions);
    });

    this.app.get('/api/trades', async (req, res) => {
      const limit = parseInt(req.query.limit as string) || 50;
      const trades = await this.db.getRecentTrades(limit);
      res.json(trades);
    });

    this.app.get('/api/performance', async (req, res) => {
      const performance = await this.db.getStrategyPerformances();
      res.json(performance);
    });

    this.app.get('/api/mcl-decisions', async (req, res) => {
      const limit = parseInt(req.query.limit as string) || 24;
      const decisions = await this.db.getRecentMCLDecisions(limit);
      res.json(decisions);
    });

    this.app.get('/api/equity-history', async (req, res) => {
      const hours = parseInt(req.query.hours as string) || 168;  // 7 days default
      const history = await this.db.getEquityHistory(hours);
      res.json(history);
    });

    // Action endpoints
    this.app.post('/api/action/go', async (req, res) => {
      try {
        await this.systemController.resumeTrading();
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/action/stop', async (req, res) => {
      try {
        await this.systemController.stopTrading();
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }

  private setupWebSocket(): void {
    this.io.on('connection', (socket) => {
      console.log('Dashboard client connected');

      // Send initial state
      this.sendFullState(socket);

      socket.on('disconnect', () => {
        console.log('Dashboard client disconnected');
      });
    });
  }

  private async sendFullState(socket: any): Promise<void> {
    const state = await this.db.getSystemState();
    const account = await this.systemController.getAccountState();
    const positions = await this.systemController.getPositions();
    
    socket.emit('fullState', { state, account, positions });
  }

  // Call this when state changes to push updates
  broadcastUpdate(updateType: string, data: any): void {
    this.io.emit(updateType, data);
  }
}
```

### 8.3 Dashboard HTML (MVP)

```html
<!-- src/monitoring/public/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hyperliquid Trading Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="/socket.io/socket.io.js"></script>
</head>
<body class="bg-gray-900 text-white min-h-screen">
  <div class="container mx-auto px-4 py-8">
    <!-- Header -->
    <div class="flex justify-between items-center mb-8">
      <h1 class="text-3xl font-bold">Trading Dashboard</h1>
      <div id="status-badge" class="px-4 py-2 rounded-full bg-green-600">
        RUNNING
      </div>
    </div>

    <!-- Alert Banner (hidden by default) -->
    <div id="alert-banner" class="hidden mb-8 p-4 bg-red-800 rounded-lg">
      <div class="flex justify-between items-center">
        <div>
          <h3 class="text-xl font-bold" id="alert-title">SYSTEM PAUSED</h3>
          <p id="alert-message" class="mt-2"></p>
        </div>
        <div class="space-x-4">
          <button onclick="sendAction('go')" class="px-6 py-2 bg-green-600 rounded hover:bg-green-700">
            GO
          </button>
          <button onclick="sendAction('stop')" class="px-6 py-2 bg-red-600 rounded hover:bg-red-700">
            STOP
          </button>
        </div>
      </div>
    </div>

    <!-- Main Grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      
      <!-- Equity Card -->
      <div class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-4">💰 Equity</h2>
        <div class="text-4xl font-bold" id="equity">$0.00</div>
        <div class="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div class="text-gray-400">Peak</div>
            <div id="peak-equity">$0.00</div>
          </div>
          <div>
            <div class="text-gray-400">Drawdown</div>
            <div id="drawdown">0.00%</div>
          </div>
          <div>
            <div class="text-gray-400">24h P&L</div>
            <div id="daily-pnl">$0.00</div>
          </div>
          <div>
            <div class="text-gray-400">Unrealized</div>
            <div id="unrealized-pnl">$0.00</div>
          </div>
        </div>
      </div>

      <!-- Positions Card -->
      <div class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-4">📊 Open Positions</h2>
        <div id="positions-list" class="space-y-3">
          <div class="text-gray-400">No open positions</div>
        </div>
      </div>

      <!-- Allocations Card -->
      <div class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-4">⚙️ Strategy Allocations</h2>
        <div id="allocations-list" class="space-y-3">
          <!-- Filled by JS -->
        </div>
      </div>

      <!-- Strategy Performance Card (spans 2 cols) -->
      <div class="bg-gray-800 rounded-lg p-6 lg:col-span-2">
        <h2 class="text-xl font-semibold mb-4">📈 Strategy Performance (24h)</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-gray-400 border-b border-gray-700">
                <th class="text-left py-2">Strategy</th>
                <th class="text-right py-2">Trades</th>
                <th class="text-right py-2">Win Rate</th>
                <th class="text-right py-2">P&L</th>
                <th class="text-right py-2">Sharpe</th>
              </tr>
            </thead>
            <tbody id="performance-table">
              <!-- Filled by JS -->
            </tbody>
          </table>
        </div>
      </div>

      <!-- Recent MCL Decisions Card -->
      <div class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-4">🧠 Recent MCL Decisions</h2>
        <div id="mcl-decisions" class="space-y-3 text-sm max-h-64 overflow-y-auto">
          <!-- Filled by JS -->
        </div>
      </div>

    </div>

    <!-- Equity Chart -->
    <div class="mt-8 bg-gray-800 rounded-lg p-6">
      <h2 class="text-xl font-semibold mb-4">📈 Equity Curve (7 days)</h2>
      <canvas id="equity-chart" height="200"></canvas>
    </div>

    <!-- Recent Trades -->
    <div class="mt-8 bg-gray-800 rounded-lg p-6">
      <h2 class="text-xl font-semibold mb-4">📝 Recent Trades</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-gray-400 border-b border-gray-700">
              <th class="text-left py-2">Time</th>
              <th class="text-left py-2">Symbol</th>
              <th class="text-left py-2">Side</th>
              <th class="text-left py-2">Strategy</th>
              <th class="text-right py-2">Size</th>
              <th class="text-right py-2">Price</th>
              <th class="text-right py-2">P&L</th>
            </tr>
          </thead>
          <tbody id="trades-table">
            <!-- Filled by JS -->
          </tbody>
        </table>
      </div>
    </div>

  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    const socket = io();
    let equityChart;

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
      initChart();
      fetchAllData();
    });

    // WebSocket handlers
    socket.on('fullState', (data) => {
      updateUI(data);
    });

    socket.on('accountUpdate', (data) => {
      updateEquity(data);
    });

    socket.on('positionUpdate', (data) => {
      updatePositions(data);
    });

    socket.on('alert', (data) => {
      showAlert(data);
    });

    // Fetch initial data
    async function fetchAllData() {
      const [status, positions, trades, performance, equityHistory] = await Promise.all([
        fetch('/api/status').then(r => r.json()),
        fetch('/api/positions').then(r => r.json()),
        fetch('/api/trades?limit=20').then(r => r.json()),
        fetch('/api/performance').then(r => r.json()),
        fetch('/api/equity-history?hours=168').then(r => r.json())
      ]);

      updateUI({ state: status.state, account: status.account, positions });
      updatePerformanceTable(performance);
      updateTradesTable(trades);
      updateEquityChart(equityHistory);
    }

    function updateUI(data) {
      const { state, account, positions } = data;

      // Status badge
      const badge = document.getElementById('status-badge');
      badge.textContent = state.systemStatus;
      badge.className = `px-4 py-2 rounded-full ${
        state.systemStatus === 'RUNNING' ? 'bg-green-600' :
        state.systemStatus === 'PAUSED' ? 'bg-yellow-600' : 'bg-red-600'
      }`;

      // Show/hide alert banner
      if (state.systemStatus === 'PAUSED') {
        document.getElementById('alert-banner').classList.remove('hidden');
        document.getElementById('alert-message').textContent = state.pauseReason;
      } else {
        document.getElementById('alert-banner').classList.add('hidden');
      }

      // Equity section
      document.getElementById('equity').textContent = `$${account.equity.toFixed(2)}`;
      document.getElementById('peak-equity').textContent = `$${account.peakEquity.toFixed(2)}`;
      document.getElementById('drawdown').textContent = `${account.drawdownPct.toFixed(2)}%`;
      document.getElementById('drawdown').className = account.drawdownPct < -10 ? 'text-red-400' : '';
      document.getElementById('unrealized-pnl').textContent = `$${account.unrealizedPnl.toFixed(2)}`;

      // Positions
      updatePositions(positions);

      // Allocations
      const allocationsHtml = Object.entries(state.currentAllocations)
        .map(([name, alloc]) => `
          <div class="flex justify-between items-center">
            <span>${name}</span>
            <div class="flex items-center">
              <div class="w-24 bg-gray-700 rounded-full h-2 mr-2">
                <div class="bg-blue-500 h-2 rounded-full" style="width: ${alloc}%"></div>
              </div>
              <span>${alloc}%</span>
            </div>
          </div>
        `).join('');
      document.getElementById('allocations-list').innerHTML = allocationsHtml;
    }

    function updatePositions(positions) {
      if (positions.length === 0) {
        document.getElementById('positions-list').innerHTML = 
          '<div class="text-gray-400">No open positions</div>';
        return;
      }

      const html = positions.map(p => `
        <div class="flex justify-between items-center p-2 bg-gray-700 rounded">
          <div>
            <span class="font-semibold">${p.symbol}</span>
            <span class="ml-2 text-sm ${p.side === 'LONG' ? 'text-green-400' : 'text-red-400'}">
              ${p.side}
            </span>
          </div>
          <div class="text-right">
            <div class="${p.unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}">
              $${p.unrealizedPnl.toFixed(2)}
            </div>
            <div class="text-xs text-gray-400">${p.strategyName}</div>
          </div>
        </div>
      `).join('');
      document.getElementById('positions-list').innerHTML = html;
    }

    function updatePerformanceTable(performances) {
      const html = performances.map(p => `
        <tr class="border-b border-gray-700">
          <td class="py-2">${p.strategyName}</td>
          <td class="text-right">${p.totalTrades}</td>
          <td class="text-right">${p.totalTrades > 0 ? ((p.winningTrades / p.totalTrades) * 100).toFixed(1) : 0}%</td>
          <td class="text-right ${p.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}">
            $${p.totalPnl.toFixed(2)}
          </td>
          <td class="text-right">${p.sharpeRatio.toFixed(2)}</td>
        </tr>
      `).join('');
      document.getElementById('performance-table').innerHTML = html;
    }

    function updateTradesTable(trades) {
      const html = trades.map(t => `
        <tr class="border-b border-gray-700">
          <td class="py-2">${new Date(t.executedAt).toLocaleString()}</td>
          <td>${t.symbol}</td>
          <td class="${t.side === 'BUY' ? 'text-green-400' : 'text-red-400'}">${t.side}</td>
          <td>${t.strategyName}</td>
          <td class="text-right">${t.quantity.toFixed(4)}</td>
          <td class="text-right">$${t.price.toFixed(2)}</td>
          <td class="text-right ${t.pnl >= 0 ? 'text-green-400' : 'text-red-400'}">
            ${t.pnl ? `$${t.pnl.toFixed(2)}` : '-'}
          </td>
        </tr>
      `).join('');
      document.getElementById('trades-table').innerHTML = html;
    }

    function initChart() {
      const ctx = document.getElementById('equity-chart').getContext('2d');
      equityChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: 'Equity',
            data: [],
            borderColor: '#3B82F6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            fill: true,
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: false,
              grid: { color: '#374151' }
            },
            x: {
              grid: { color: '#374151' }
            }
          },
          plugins: {
            legend: { display: false }
          }
        }
      });
    }

    function updateEquityChart(history) {
      equityChart.data.labels = history.map(h => 
        new Date(h.snapshotTime).toLocaleDateString()
      );
      equityChart.data.datasets[0].data = history.map(h => h.equity);
      equityChart.update();
    }

    async function sendAction(action) {
      if (action === 'stop' && !confirm('Are you sure you want to stop the system?')) {
        return;
      }

      const response = await fetch(`/api/action/${action}`, { method: 'POST' });
      const result = await response.json();
      
      if (result.success) {
        fetchAllData();
      } else {
        alert(`Action failed: ${result.error}`);
      }
    }

    // Refresh data periodically
    setInterval(fetchAllData, 30000);  // Every 30 seconds
  </script>
</body>
</html>
```

---

## 9. Deployment Configuration

### 9.1 Railway Setup

```yaml
# railway.toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npm run start"
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "on-failure"
restartPolicyMaxRetries = 3

[[services]]
name = "trading-bot"
```

### 9.2 Environment Variables

```bash
# .env.example (DO NOT COMMIT ACTUAL VALUES)

# Hyperliquid
HL_PRIVATE_KEY=your_ethereum_private_key
HL_WALLET_ADDRESS=your_wallet_address

# Anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key

# Telegram
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Database (Railway provides this)
DATABASE_URL=postgresql://user:pass@host:port/db

# Application
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Trading Config
INITIAL_CAPITAL=100
REPORT_TIME_UTC=15:00
MCL_INTERVAL_MINUTES=60
```

### 9.3 Package.json

```json
{
  "name": "hyperliquid-trading-system",
  "version": "1.0.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node-dev src/index.ts",
    "migrate": "node-pg-migrate up",
    "fetch-history": "ts-node scripts/fetch-historical-data.ts",
    "backtest": "ts-node scripts/run-backtest.ts"
  },
  "dependencies": {
    "axios": "^1.6.0",
    "ethers": "^5.7.0",
    "express": "^4.18.0",
    "node-telegram-bot-api": "^0.64.0",
    "pg": "^8.11.0",
    "socket.io": "^4.7.0",
    "ws": "^8.14.0",
    "zod": "^3.22.0",
    "node-cron": "^3.0.0",
    "@anthropic-ai/sdk": "^0.10.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.0",
    "@types/node": "^20.0.0",
    "@types/ws": "^8.5.0",
    "ts-node": "^10.9.0",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.3.0",
    "node-pg-migrate": "^6.2.0"
  }
}
```

### 9.4 TypeScript Config

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 10. Cold Start Protocol

### 10.1 Pre-Launch Checklist

```markdown
## Cold Start Checklist

### Phase 1: Environment Setup
- [ ] Railway project created
- [ ] PostgreSQL addon provisioned
- [ ] Environment variables configured
- [ ] Telegram bot created via BotFather
- [ ] Hyperliquid wallet funded with USDC

### Phase 2: Data Collection
- [ ] Database migrations run
- [ ] Historical candles fetched (all symbols, all timeframes)
- [ ] Historical funding rates fetched (90 days)
- [ ] Verify data completeness (check counts per symbol)

### Phase 3: Backtest Validation
- [ ] Each strategy backtested independently
- [ ] Combined portfolio backtested
- [ ] Sharpe ratio > 0.5 on historical data
- [ ] Max drawdown < 30% on historical
- [ ] No strategy has > 7 consecutive losses historically

### Phase 4: Paper Trading (Optional but Recommended)
- [ ] Run system with real data, simulated orders (24-48h)
- [ ] Verify signal generation works correctly
- [ ] Verify MCL decisions are sensible
- [ ] No errors in logs

### Phase 5: Go-Live
- [ ] Start with 50% of intended capital allocation
- [ ] Monitor first 24h closely
- [ ] Verify first trade executes correctly
- [ ] Verify alerts/reports are working
- [ ] After 48h stable operation, increase to full allocation
```

### 10.2 Historical Data Fetch Script

```typescript
// scripts/fetch-historical-data.ts

import { HyperliquidRestClient, HyperliquidAuth } from '../src/hyperliquid';
import { Database } from '../src/data/database';
import { HistoricalDataFetcher } from '../src/data/historical-fetcher';

async function main() {
  console.log('Starting historical data fetch...');

  const auth = new HyperliquidAuth(process.env.HL_PRIVATE_KEY!);
  const client = new HyperliquidRestClient(auth);
  const db = new Database(process.env.DATABASE_URL!);
  
  await db.connect();
  await db.runMigrations();

  const fetcher = new HistoricalDataFetcher(client, db);
  
  console.log('Fetching all historical data...');
  await fetcher.fetchAllHistoricalData();

  // Verify
  const candleCount = await db.query('SELECT COUNT(*) FROM candles');
  const fundingCount = await db.query('SELECT COUNT(*) FROM funding_rates');
  
  console.log(`\nData fetch complete:`);
  console.log(`  Candles: ${candleCount.rows[0].count}`);
  console.log(`  Funding rates: ${fundingCount.rows[0].count}`);

  await db.disconnect();
}

main().catch(console.error);
```

### 10.3 Backtest Runner

```typescript
// scripts/run-backtest.ts

import { Database } from '../src/data/database';
import { BacktestEngine } from '../src/backtest/engine';
import { FundingSignalStrategy } from '../src/strategies/funding-signal';
import { MomentumBreakoutStrategy } from '../src/strategies/momentum-breakout';
import { MeanReversionStrategy } from '../src/strategies/mean-reversion';
import { TrendFollowStrategy } from '../src/strategies/trend-follow';

async function main() {
  const db = new Database(process.env.DATABASE_URL!);
  await db.connect();

  const engine = new BacktestEngine(db, {
    startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),  // 90 days ago
    endDate: new Date(),
    initialCapital: 100,
    commission: 0.0005  // 0.05% taker fee
  });

  // Backtest each strategy individually
  const strategies = [
    new FundingSignalStrategy(),
    new MomentumBreakoutStrategy(),
    new MeanReversionStrategy(),
    new TrendFollowStrategy()
  ];

  console.log('Running individual strategy backtests...\n');

  for (const strategy of strategies) {
    const result = await engine.run([strategy], { [strategy.name]: 100 });
    
    console.log(`${strategy.name}:`);
    console.log(`  Total Return: ${result.totalReturnPct.toFixed(2)}%`);
    console.log(`  Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);
    console.log(`  Max Drawdown: ${result.maxDrawdownPct.toFixed(2)}%`);
    console.log(`  Win Rate: ${result.winRate.toFixed(1)}%`);
    console.log(`  Profit Factor: ${result.profitFactor.toFixed(2)}`);
    console.log(`  Total Trades: ${result.totalTrades}`);
    console.log(`  Max Consecutive Losses: ${result.maxConsecutiveLosses}`);
    console.log('');
  }

  // Backtest combined portfolio
  console.log('Running combined portfolio backtest...\n');
  
  const combinedResult = await engine.run(strategies, {
    funding_signal: 25,
    momentum_breakout: 25,
    mean_reversion: 25,
    trend_follow: 25
  });

  console.log('Combined Portfolio:');
  console.log(`  Total Return: ${combinedResult.totalReturnPct.toFixed(2)}%`);
  console.log(`  Sharpe Ratio: ${combinedResult.sharpeRatio.toFixed(2)}`);
  console.log(`  Max Drawdown: ${combinedResult.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  Win Rate: ${combinedResult.winRate.toFixed(1)}%`);
  console.log(`  Total Trades: ${combinedResult.totalTrades}`);

  // Validation checks
  console.log('\n--- Validation ---');
  console.log(`Sharpe > 0.5: ${combinedResult.sharpeRatio > 0.5 ? '✅' : '❌'}`);
  console.log(`Max DD < 30%: ${combinedResult.maxDrawdownPct > -30 ? '✅' : '❌'}`);
  console.log(`Max Consec Losses < 7: ${combinedResult.maxConsecutiveLosses < 7 ? '✅' : '❌'}`);

  await db.disconnect();
}

main().catch(console.error);
```

---

## 11. File Structure

```
hyperliquid-trading-system/
├── src/
│   ├── index.ts                    # Main entry point
│   ├── config.ts                   # Configuration loader
│   │
│   ├── hyperliquid/
│   │   ├── auth.ts                 # Wallet authentication
│   │   ├── rest-client.ts          # REST API client
│   │   ├── ws-client.ts            # WebSocket client
│   │   └── types.ts                # Hyperliquid API types
│   │
│   ├── data/
│   │   ├── database.ts             # PostgreSQL connection & queries
│   │   ├── historical-fetcher.ts   # Historical data fetcher
│   │   ├── data-collector.ts       # Real-time data collector
│   │   └── indicator-computer.ts   # Technical indicator calculator
│   │
│   ├── strategies/
│   │   ├── base-strategy.ts        # Abstract strategy class
│   │   ├── funding-signal.ts       # Funding rate strategy
│   │   ├── momentum-breakout.ts    # Momentum breakout strategy
│   │   ├── mean-reversion.ts       # Mean reversion strategy
│   │   └── trend-follow.ts         # Trend following strategy
│   │
│   ├── mcl/
│   │   ├── index.ts                # MCL orchestrator
│   │   ├── system-evaluator.ts     # System health evaluator
│   │   ├── agent-evaluator.ts      # Strategy performance evaluator
│   │   ├── conflict-arbitrator.ts  # Conflict resolver
│   │   ├── decision-engine.ts      # Final decision maker
│   │   ├── anomaly-detector.ts     # MCL output validator
│   │   └── prompts.ts              # LLM prompt templates
│   │
│   ├── execution/
│   │   ├── order-manager.ts        # Order execution
│   │   ├── position-tracker.ts     # Position tracking
│   │   ├── risk-manager.ts         # Risk management
│   │   └── signal-aggregator.ts    # Signal combination
│   │
│   ├── monitoring/
│   │   ├── telegram-bot.ts         # Telegram bot
│   │   ├── dashboard-server.ts     # Dashboard HTTP server
│   │   ├── alert-manager.ts        # Alert dispatching
│   │   ├── report-generator.ts     # Daily report generation
│   │   └── public/
│   │       └── index.html          # Dashboard UI
│   │
│   ├── backtest/
│   │   └── engine.ts               # Backtesting engine
│   │
│   └── types/
│       └── index.ts                # Shared TypeScript types
│
├── scripts/
│   ├── fetch-historical-data.ts    # Data fetch script
│   └── run-backtest.ts             # Backtest runner
│
├── migrations/
│   └── 001_initial.sql             # Database schema
│
├── .env.example                    # Environment template
├── package.json
├── tsconfig.json
├── railway.toml
└── README.md
```

---

## Next Steps

This document provides the complete blueprint. To implement:

1. **Create the Railway project** and provision PostgreSQL
2. **Set up the repository** with the file structure above
3. **Implement in order:**
   - Database schema and migrations
   - Hyperliquid API client
   - Data collector and historical fetcher
   - Individual strategies
   - Execution engine
   - MCL components
   - Monitoring (Telegram + Dashboard)
4. **Run cold start protocol** before going live

Each component has been specified in enough detail for Claude Code to implement directly. Start with data infrastructure, then strategies, then MCL, then monitoring.
