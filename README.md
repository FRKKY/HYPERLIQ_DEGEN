# HYPERLIQ_DEGEN

Autonomous perpetual futures trading system on Hyperliquid DEX with a self-improving metacognitive layer.

## Overview

This system implements a fully autonomous trading bot with:

- **4 Trading Strategies**: Funding Signal, Momentum Breakout, Mean Reversion, Trend Follow
- **Metacognitive Layer (MCL)**: Uses Claude AI for hourly self-evaluation and capital allocation
- **Risk Management**: Automatic drawdown protection, daily loss limits, position limits
- **Monitoring**: Telegram bot + Web dashboard for real-time monitoring

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Hyperliquid wallet with USDC
- Anthropic API key
- Telegram bot token

### Installation

```bash
# Install dependencies
npm install

# Copy environment file and configure
cp .env.example .env
# Edit .env with your credentials

# Build the project
npm run build

# Run database migrations
npm run migrate

# Fetch historical data (optional but recommended)
npm run fetch-history

# Run backtests (optional)
npm run backtest

# Start the trading system
npm start
```

## Configuration

Create a `.env` file with the following variables:

```bash
# Hyperliquid
HL_PRIVATE_KEY=your_ethereum_private_key
HL_WALLET_ADDRESS=your_wallet_address

# Anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key

# Telegram
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Database
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

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      METACOGNITIVE LAYER                         │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │   System    │ │    Agent    │ │   Conflict  │                │
│  │  Evaluator  │ │  Evaluator  │ │  Arbitrator │                │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘                │
│         └────────────────┼───────────────┘                       │
│                          ▼                                       │
│                   Decision Engine                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                      OPERATIONAL LAYER                           │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐        │
│  │  Funding  │ │ Momentum  │ │ Mean Rev  │ │   Trend   │        │
│  │  Signal   │ │ Breakout  │ │   Fade    │ │  Follow   │        │
│  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘        │
│        └─────────────┴─────────────┴─────────────┘               │
│                          │                                       │
│                Signal Aggregator                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                      EXECUTION LAYER                             │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐          │
│  │    Order      │ │   Position    │ │     Risk      │          │
│  │   Manager     │ │   Tracker     │ │   Manager     │          │
│  └───────────────┘ └───────────────┘ └───────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

## Strategies

| Strategy | Edge Source | Hold Time |
|----------|-------------|-----------|
| Funding Signal | Funding rate mean reversion | 1-8 hours |
| Momentum Breakout | Trend continuation | 4-48 hours |
| Mean Reversion | Overextension snapback | 15min-4 hours |
| Trend Follow | Established trend riding | 1-7 days |

## Risk Thresholds

| Event | Threshold | Behavior |
|-------|-----------|----------|
| Drawdown warning | -10% | Reduce exposure |
| Drawdown critical | -15% | Minimum exposure |
| Drawdown pause | -20% | Pause + close all |
| Daily loss limit | -15% | Pause until next day |
| Single trade loss | -8% | Alert only |

## Telegram Commands

- `/status` - System status
- `/positions` - Open positions
- `/report` - Generate report
- `/help` - Show help
- `GO` - Resume from pause
- `STOP` - Shutdown system

## API Endpoints

- `GET /health` - Health check
- `GET /api/status` - System status
- `GET /api/positions` - Open positions
- `GET /api/trades` - Recent trades
- `GET /api/performance` - Strategy performance
- `GET /api/mcl-decisions` - MCL decision history
- `POST /api/action/go` - Resume trading
- `POST /api/action/stop` - Stop trading

## File Structure

```
src/
├── index.ts                    # Main entry point
├── config.ts                   # Configuration loader
├── hyperliquid/                # Hyperliquid API client
├── data/                       # Data layer
├── strategies/                 # Trading strategies
├── mcl/                        # Metacognitive layer
├── execution/                  # Order execution
├── monitoring/                 # Telegram & dashboard
├── backtest/                   # Backtesting engine
└── types/                      # TypeScript types
```

## Cold Start Checklist

1. Environment setup (Railway/database/API keys)
2. Database migrations
3. Historical data fetch
4. Backtest validation
5. Paper trading (24-48h recommended)
6. Go live with 50% allocation
7. Full allocation after 48h stable

## License

MIT
