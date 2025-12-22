-- Backtest validation: Strategies must pass backtest before live trading
-- This ensures agents work with collected data first before trading

-- Backtest results storage
CREATE TABLE backtest_results (
    id SERIAL PRIMARY KEY,
    strategy_name VARCHAR(50) NOT NULL,
    strategy_version VARCHAR(20) NOT NULL DEFAULT '1.0.0',
    backtest_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    data_start_date TIMESTAMPTZ NOT NULL,
    data_end_date TIMESTAMPTZ NOT NULL,
    initial_capital DECIMAL(20, 2) NOT NULL,
    final_equity DECIMAL(20, 2) NOT NULL,
    total_return_pct DECIMAL(10, 4) NOT NULL,
    sharpe_ratio DECIMAL(10, 4) NOT NULL,
    max_drawdown_pct DECIMAL(10, 4) NOT NULL,
    win_rate_pct DECIMAL(10, 4) NOT NULL,
    profit_factor DECIMAL(10, 4) NOT NULL,
    total_trades INTEGER NOT NULL,
    winning_trades INTEGER NOT NULL,
    losing_trades INTEGER NOT NULL,
    max_consecutive_losses INTEGER NOT NULL,
    avg_trade_pnl DECIMAL(20, 8),
    avg_win DECIMAL(20, 8),
    avg_loss DECIMAL(20, 8),
    candles_used INTEGER,
    validation_passed BOOLEAN NOT NULL DEFAULT FALSE,
    validation_errors TEXT[],
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_backtest_results_strategy ON backtest_results(strategy_name, backtest_date DESC);
CREATE INDEX idx_backtest_results_passed ON backtest_results(strategy_name, validation_passed);

-- Backtest validation criteria (minimum requirements for live trading)
-- Tightened thresholds for statistical confidence and risk management
CREATE TABLE backtest_validation_criteria (
    id SERIAL PRIMARY KEY,
    strategy_name VARCHAR(50),  -- NULL means default criteria for all strategies
    min_data_days INTEGER NOT NULL DEFAULT 180,          -- 6 months minimum for regime coverage
    min_trades INTEGER NOT NULL DEFAULT 100,             -- Statistical significance
    min_sharpe_ratio DECIMAL(5, 2) NOT NULL DEFAULT 1.0, -- Institutional standard
    max_drawdown_pct DECIMAL(5, 2) NOT NULL DEFAULT -15.0, -- Tight risk control
    min_win_rate_pct DECIMAL(5, 2) NOT NULL DEFAULT 40.0,  -- Reasonable for trend-following
    min_profit_factor DECIMAL(5, 2) NOT NULL DEFAULT 1.5,  -- Must be clearly profitable
    max_consecutive_losses INTEGER NOT NULL DEFAULT 7,     -- Manifesto requirement
    min_return_pct DECIMAL(5, 2) NOT NULL DEFAULT 0.0,     -- Must be profitable
    require_fresh_backtest_days INTEGER NOT NULL DEFAULT 7,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(strategy_name)
);

-- Insert default validation criteria
INSERT INTO backtest_validation_criteria (strategy_name) VALUES (NULL);

-- Strategy trading permissions (tracks which strategies are validated for live trading)
CREATE TABLE strategy_trading_permissions (
    id SERIAL PRIMARY KEY,
    strategy_name VARCHAR(50) NOT NULL UNIQUE,
    trading_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    last_validated_at TIMESTAMPTZ,
    last_backtest_id INTEGER REFERENCES backtest_results(id),
    validation_expires_at TIMESTAMPTZ,
    disabled_reason TEXT,
    auto_revalidate BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_strategy_permissions_enabled ON strategy_trading_permissions(trading_enabled);

-- Initialize permissions for existing strategies (disabled by default until backtested)
INSERT INTO strategy_trading_permissions (strategy_name, trading_enabled, disabled_reason) VALUES
    ('funding_signal', FALSE, 'Awaiting initial backtest validation'),
    ('momentum_breakout', FALSE, 'Awaiting initial backtest validation'),
    ('mean_reversion', FALSE, 'Awaiting initial backtest validation'),
    ('trend_follow', FALSE, 'Awaiting initial backtest validation')
ON CONFLICT (strategy_name) DO NOTHING;

-- Add system state for backtest validation
INSERT INTO system_state (key, value) VALUES
    ('require_backtest_validation', 'true'),
    ('backtest_validation_mode', '"strict"')  -- strict, warn, or disabled
ON CONFLICT (key) DO NOTHING;
