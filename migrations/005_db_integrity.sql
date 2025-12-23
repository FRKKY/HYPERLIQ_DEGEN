-- Database integrity improvements
-- Adds missing indexes, FK cascade policies, and constraints

-- ============================================================
-- MISSING INDEXES
-- ============================================================

-- Trades: per-symbol and per-environment queries
CREATE INDEX IF NOT EXISTS idx_trades_symbol_time ON trades(symbol, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_environment_time ON trades(environment, executed_at DESC);

-- Signals: per-symbol and per-environment queries
CREATE INDEX IF NOT EXISTS idx_signals_symbol_time ON signals(symbol, signal_time DESC);
CREATE INDEX IF NOT EXISTS idx_signals_environment_time ON signals(environment, signal_time DESC);

-- Indicators: compound index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_indicators_symbol_timeframe ON indicators(symbol, timeframe, computed_at DESC);

-- System health: composite index for ORDER BY component, check_time DESC
CREATE INDEX IF NOT EXISTS idx_system_health_component_time ON system_health(component, check_time DESC);

-- Strategy allocations: partial index for active allocations (effective_until IS NULL)
CREATE INDEX IF NOT EXISTS idx_strategy_allocations_active ON strategy_allocations(effective_from DESC)
    WHERE effective_until IS NULL;

-- Account snapshots: index for time-range queries
CREATE INDEX IF NOT EXISTS idx_account_snapshots_created_at ON account_snapshots(created_at);

-- Open interest: add unique constraint to prevent duplicates
-- First, remove any duplicates keeping the latest
DELETE FROM open_interest a USING open_interest b
WHERE a.id < b.id AND a.symbol = b.symbol AND a.recorded_at = b.recorded_at;

-- Add unique constraint if not exists (PostgreSQL 9.x+ compatible)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'open_interest_symbol_time_unique'
    ) THEN
        ALTER TABLE open_interest ADD CONSTRAINT open_interest_symbol_time_unique
            UNIQUE (symbol, recorded_at);
    END IF;
END $$;

-- ============================================================
-- FOREIGN KEY CASCADE POLICIES
-- ============================================================
-- When parent records are deleted, set FKs to NULL instead of blocking delete
-- This preserves historical data while allowing cleanup of old decisions/versions

-- strategy_allocations.mcl_decision_id: drop and recreate with ON DELETE SET NULL
ALTER TABLE strategy_allocations DROP CONSTRAINT IF EXISTS strategy_allocations_mcl_decision_id_fkey;
ALTER TABLE strategy_allocations ADD CONSTRAINT strategy_allocations_mcl_decision_id_fkey
    FOREIGN KEY (mcl_decision_id) REFERENCES mcl_decisions(id) ON DELETE SET NULL;

-- signals.strategy_version_id: drop and recreate with ON DELETE SET NULL
ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_strategy_version_id_fkey;
ALTER TABLE signals ADD CONSTRAINT signals_strategy_version_id_fkey
    FOREIGN KEY (strategy_version_id) REFERENCES strategy_versions(id) ON DELETE SET NULL;

-- trades.strategy_version_id: drop and recreate with ON DELETE SET NULL
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_strategy_version_id_fkey;
ALTER TABLE trades ADD CONSTRAINT trades_strategy_version_id_fkey
    FOREIGN KEY (strategy_version_id) REFERENCES strategy_versions(id) ON DELETE SET NULL;

-- strategy_trading_permissions.last_backtest_id: drop and recreate with ON DELETE SET NULL
ALTER TABLE strategy_trading_permissions DROP CONSTRAINT IF EXISTS strategy_trading_permissions_last_backtest_id_fkey;
ALTER TABLE strategy_trading_permissions ADD CONSTRAINT strategy_trading_permissions_last_backtest_id_fkey
    FOREIGN KEY (last_backtest_id) REFERENCES backtest_results(id) ON DELETE SET NULL;

-- strategy_deployments.strategy_version_id: recreate with ON DELETE CASCADE
-- When a strategy version is deleted, its deployments should be deleted too
ALTER TABLE strategy_deployments DROP CONSTRAINT IF EXISTS strategy_deployments_strategy_version_id_fkey;
ALTER TABLE strategy_deployments ADD CONSTRAINT strategy_deployments_strategy_version_id_fkey
    FOREIGN KEY (strategy_version_id) REFERENCES strategy_versions(id) ON DELETE CASCADE;

-- promotion_evaluations.strategy_version_id: recreate with ON DELETE CASCADE
ALTER TABLE promotion_evaluations DROP CONSTRAINT IF EXISTS promotion_evaluations_strategy_version_id_fkey;
ALTER TABLE promotion_evaluations ADD CONSTRAINT promotion_evaluations_strategy_version_id_fkey
    FOREIGN KEY (strategy_version_id) REFERENCES strategy_versions(id) ON DELETE CASCADE;

-- ============================================================
-- DEFAULT VALUES AND CONSTRAINTS
-- ============================================================

-- Ensure positions table has updated_at with proper default
-- This column is used by the UPSERT in syncPositions()
ALTER TABLE positions ALTER COLUMN updated_at SET DEFAULT NOW();

-- Add NOT NULL with default for positions.unrealized_pnl and margin_used
-- First update any NULL values to 0
UPDATE positions SET unrealized_pnl = 0 WHERE unrealized_pnl IS NULL;
UPDATE positions SET margin_used = 0 WHERE margin_used IS NULL;

-- Then add NOT NULL constraints
ALTER TABLE positions ALTER COLUMN unrealized_pnl SET NOT NULL;
ALTER TABLE positions ALTER COLUMN unrealized_pnl SET DEFAULT 0;
ALTER TABLE positions ALTER COLUMN margin_used SET NOT NULL;
ALTER TABLE positions ALTER COLUMN margin_used SET DEFAULT 0;

-- ============================================================
-- INDEXES FOR RETENTION/CLEANUP QUERIES
-- ============================================================

-- These indexes help with data retention policies and cleanup jobs
CREATE INDEX IF NOT EXISTS idx_candles_created_at ON candles(created_at);
CREATE INDEX IF NOT EXISTS idx_funding_rates_created_at ON funding_rates(created_at);
CREATE INDEX IF NOT EXISTS idx_open_interest_created_at ON open_interest(created_at);
CREATE INDEX IF NOT EXISTS idx_market_trades_created_at ON market_trades(created_at);
CREATE INDEX IF NOT EXISTS idx_mcl_decisions_created_at ON mcl_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
