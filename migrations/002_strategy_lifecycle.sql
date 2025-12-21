-- Strategy versioning and lifecycle management
-- Supports automated testnet -> mainnet promotion workflow

-- Strategy versions table
CREATE TABLE strategy_versions (
    id SERIAL PRIMARY KEY,
    strategy_name VARCHAR(50) NOT NULL,
    version VARCHAR(20) NOT NULL,
    deployment_state VARCHAR(30) NOT NULL DEFAULT 'development',
    code_hash VARCHAR(64) NOT NULL,
    parameters JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    promoted_at TIMESTAMPTZ,
    UNIQUE(strategy_name, version),
    CONSTRAINT valid_deployment_state CHECK (deployment_state IN (
        'development', 'testnet_pending', 'testnet_active', 'testnet_validated',
        'mainnet_shadow', 'mainnet_active', 'mainnet_paused', 'deprecated'
    ))
);

CREATE INDEX idx_strategy_versions_name ON strategy_versions(strategy_name);
CREATE INDEX idx_strategy_versions_state ON strategy_versions(deployment_state);

-- Strategy deployments table (tracks per-environment deployments)
CREATE TABLE strategy_deployments (
    id SERIAL PRIMARY KEY,
    strategy_version_id INTEGER NOT NULL REFERENCES strategy_versions(id),
    environment VARCHAR(10) NOT NULL,
    state VARCHAR(30) NOT NULL,
    shadow_mode BOOLEAN NOT NULL DEFAULT FALSE,
    deployed_at TIMESTAMPTZ DEFAULT NOW(),
    last_evaluated_at TIMESTAMPTZ,
    performance_metrics JSONB,
    UNIQUE(strategy_version_id, environment),
    CONSTRAINT valid_environment CHECK (environment IN ('testnet', 'mainnet')),
    CONSTRAINT valid_state CHECK (state IN (
        'development', 'testnet_pending', 'testnet_active', 'testnet_validated',
        'mainnet_shadow', 'mainnet_active', 'mainnet_paused', 'deprecated'
    ))
);

CREATE INDEX idx_strategy_deployments_env ON strategy_deployments(environment);
CREATE INDEX idx_strategy_deployments_state ON strategy_deployments(state);

-- Promotion criteria configuration
CREATE TABLE promotion_criteria (
    id SERIAL PRIMARY KEY,
    strategy_name VARCHAR(50),  -- NULL means default criteria for all strategies
    min_testnet_runtime_hours INTEGER NOT NULL DEFAULT 48,
    min_trades INTEGER NOT NULL DEFAULT 20,
    min_sharpe_ratio DECIMAL(5, 2) NOT NULL DEFAULT 0.5,
    max_drawdown_pct DECIMAL(5, 2) NOT NULL DEFAULT -20.0,
    min_win_rate_pct DECIMAL(5, 2) NOT NULL DEFAULT 40.0,
    min_profit_factor DECIMAL(5, 2) NOT NULL DEFAULT 1.2,
    max_consecutive_losses INTEGER NOT NULL DEFAULT 5,
    min_shadow_mode_hours INTEGER NOT NULL DEFAULT 24,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(strategy_name)
);

-- Insert default promotion criteria
INSERT INTO promotion_criteria (strategy_name) VALUES (NULL);

-- Promotion evaluations log
CREATE TABLE promotion_evaluations (
    id SERIAL PRIMARY KEY,
    strategy_version_id INTEGER NOT NULL REFERENCES strategy_versions(id),
    current_state VARCHAR(30) NOT NULL,
    target_state VARCHAR(30) NOT NULL,
    metrics JSONB NOT NULL,
    criteria_used JSONB NOT NULL,
    passed BOOLEAN NOT NULL,
    failed_criteria TEXT[],
    reasoning TEXT,
    evaluated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_promotion_evals_version ON promotion_evaluations(strategy_version_id);
CREATE INDEX idx_promotion_evals_time ON promotion_evaluations(evaluated_at DESC);

-- Rollback events log
CREATE TABLE rollback_events (
    id SERIAL PRIMARY KEY,
    strategy_name VARCHAR(50) NOT NULL,
    from_version VARCHAR(20) NOT NULL,
    to_version VARCHAR(20) NOT NULL,
    reason TEXT NOT NULL,
    automatic BOOLEAN NOT NULL DEFAULT FALSE,
    triggered_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_rollback_events_strategy ON rollback_events(strategy_name);
CREATE INDEX idx_rollback_events_time ON rollback_events(triggered_at DESC);

-- Add environment column to signals table for dual-environment tracking
ALTER TABLE signals ADD COLUMN IF NOT EXISTS environment VARCHAR(10) DEFAULT 'mainnet';
ALTER TABLE signals ADD COLUMN IF NOT EXISTS strategy_version_id INTEGER REFERENCES strategy_versions(id);

-- Add environment column to trades table for dual-environment tracking
ALTER TABLE trades ADD COLUMN IF NOT EXISTS environment VARCHAR(10) DEFAULT 'mainnet';
ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy_version_id INTEGER REFERENCES strategy_versions(id);

-- Initialize strategy versions for existing strategies
INSERT INTO strategy_versions (strategy_name, version, deployment_state, code_hash, parameters) VALUES
    ('funding_signal', '1.0.0', 'mainnet_active', 'initial', '{}'),
    ('momentum_breakout', '1.0.0', 'mainnet_active', 'initial', '{}'),
    ('mean_reversion', '1.0.0', 'mainnet_active', 'initial', '{}'),
    ('trend_follow', '1.0.0', 'mainnet_active', 'initial', '{}');

-- Create deployments for initial versions (both testnet and mainnet ready)
INSERT INTO strategy_deployments (strategy_version_id, environment, state, shadow_mode)
SELECT id, 'mainnet', 'mainnet_active', FALSE FROM strategy_versions WHERE version = '1.0.0';

INSERT INTO strategy_deployments (strategy_version_id, environment, state, shadow_mode)
SELECT id, 'testnet', 'testnet_validated', FALSE FROM strategy_versions WHERE version = '1.0.0';

-- Add system state keys for lifecycle management
INSERT INTO system_state (key, value) VALUES
    ('testnet_enabled', 'true'),
    ('auto_promotion_enabled', 'true'),
    ('promotion_check_interval_hours', '6')
ON CONFLICT (key) DO NOTHING;
