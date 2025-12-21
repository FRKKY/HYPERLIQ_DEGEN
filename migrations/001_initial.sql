-- Market data: OHLCV candles
CREATE TABLE candles (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    timeframe VARCHAR(10) NOT NULL,
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
    parameters JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(symbol, timeframe, computed_at, indicator_name, parameters)
);

-- Strategy signals
CREATE TABLE signals (
    id SERIAL PRIMARY KEY,
    strategy_name VARCHAR(50) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    signal_time TIMESTAMPTZ NOT NULL,
    direction VARCHAR(10) NOT NULL,
    strength DECIMAL(5, 4),
    entry_price DECIMAL(20, 8),
    stop_loss DECIMAL(20, 8),
    take_profit DECIMAL(20, 8),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_signals_strategy_time ON signals(strategy_name, signal_time DESC);

-- Executed trades
CREATE TABLE trades (
    id SERIAL PRIMARY KEY,
    trade_id VARCHAR(100) UNIQUE,
    strategy_name VARCHAR(50) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(10) NOT NULL,
    direction VARCHAR(20) NOT NULL,
    quantity DECIMAL(20, 8) NOT NULL,
    price DECIMAL(20, 8) NOT NULL,
    fee DECIMAL(20, 8),
    leverage INTEGER,
    executed_at TIMESTAMPTZ NOT NULL,
    order_type VARCHAR(20),
    pnl DECIMAL(20, 8),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trades_strategy_time ON trades(strategy_name, executed_at DESC);

-- Current positions
CREATE TABLE positions (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL UNIQUE,
    side VARCHAR(10) NOT NULL,
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

-- MCL decisions log (create this first since it's referenced by strategy_allocations)
CREATE TABLE mcl_decisions (
    id SERIAL PRIMARY KEY,
    decision_time TIMESTAMPTZ NOT NULL,
    decision_type VARCHAR(50) NOT NULL,
    inputs JSONB NOT NULL,
    outputs JSONB NOT NULL,
    reasoning TEXT,
    confidence DECIMAL(5, 4),
    llm_model VARCHAR(50),
    tokens_used INTEGER,
    latency_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mcl_decisions_time ON mcl_decisions(decision_time DESC);

-- Strategy allocations (from MCL)
CREATE TABLE strategy_allocations (
    id SERIAL PRIMARY KEY,
    effective_from TIMESTAMPTZ NOT NULL,
    effective_until TIMESTAMPTZ,
    allocations JSONB NOT NULL,
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
    consecutive_losses INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_perf_strategy_period ON strategy_performance(strategy_name, period_end DESC);

-- System health logs
CREATE TABLE system_health (
    id SERIAL PRIMARY KEY,
    check_time TIMESTAMPTZ NOT NULL,
    component VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Alerts log
CREATE TABLE alerts (
    id SERIAL PRIMARY KEY,
    alert_time TIMESTAMPTZ NOT NULL,
    alert_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    title VARCHAR(200) NOT NULL,
    message TEXT,
    acknowledged BOOLEAN DEFAULT FALSE,
    acknowledged_at TIMESTAMPTZ,
    action_taken VARCHAR(50),
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
    ('current_allocations', '{"funding_signal": 25, "momentum_breakout": 25, "mean_reversion": 25, "trend_follow": 25}'),
    ('peak_equity', '100.0'),
    ('daily_start_equity', '100.0'),
    ('daily_pnl', '0.0'),
    ('awaiting_go_confirm', 'false'),
    ('awaiting_stop_confirm', 'false');
