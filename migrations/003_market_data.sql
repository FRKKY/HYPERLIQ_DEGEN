-- Migration: Add market_trades and orderbook_snapshots tables
-- For storing real-time WebSocket data

-- Market trades table (individual trades from WebSocket)
CREATE TABLE IF NOT EXISTS market_trades (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(4) NOT NULL,  -- BUY or SELL
    price DECIMAL(20,8) NOT NULL,
    size DECIMAL(20,8) NOT NULL,
    trade_time TIMESTAMP NOT NULL,
    tx_hash VARCHAR(66),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(symbol, trade_time, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_market_trades_symbol_time ON market_trades(symbol, trade_time DESC);
CREATE INDEX IF NOT EXISTS idx_market_trades_time ON market_trades(trade_time DESC);

-- Orderbook snapshots table (periodic L2 snapshots)
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    snapshot_time TIMESTAMP NOT NULL,
    bids JSONB NOT NULL,  -- Top 10 bid levels
    asks JSONB NOT NULL,  -- Top 10 ask levels
    spread DECIMAL(20,8),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orderbook_symbol_time ON orderbook_snapshots(symbol, snapshot_time DESC);

-- Add partitioning hint for market_trades (high volume table)
COMMENT ON TABLE market_trades IS 'High-volume table - consider partitioning by trade_time for production';

-- Liquidations table (extracted from user events)
CREATE TABLE IF NOT EXISTS liquidations (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(5) NOT NULL,  -- LONG or SHORT
    size DECIMAL(20,8) NOT NULL,
    price DECIMAL(20,8) NOT NULL,
    liquidation_time TIMESTAMP NOT NULL,
    user_address VARCHAR(42),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_liquidations_symbol_time ON liquidations(symbol, liquidation_time DESC);
CREATE INDEX IF NOT EXISTS idx_liquidations_time ON liquidations(liquidation_time DESC);
