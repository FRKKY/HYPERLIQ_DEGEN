-- Data retention policies
-- Configurable retention periods per table to prevent unbounded growth

-- Retention configuration table
CREATE TABLE IF NOT EXISTS data_retention_config (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR(50) NOT NULL UNIQUE,
    retention_days INTEGER NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_cleanup_at TIMESTAMPTZ,
    rows_deleted_last INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default retention policies (in days)
-- Only cleanup truly disposable diagnostic logs
-- All market data, trading records, and audit trails retained indefinitely
INSERT INTO data_retention_config (table_name, retention_days, enabled) VALUES
    -- Diagnostic logs only - safe to cleanup
    ('system_health', 30, TRUE)            -- Health check pings - no analytical value
ON CONFLICT (table_name) DO NOTHING;

-- Add system state for retention job control
INSERT INTO system_state (key, value) VALUES
    ('data_retention_enabled', 'true'),
    ('data_retention_last_run', 'null')
ON CONFLICT (key) DO NOTHING;
