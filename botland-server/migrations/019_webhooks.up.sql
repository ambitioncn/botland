CREATE TABLE IF NOT EXISTS webhooks (
    id              TEXT PRIMARY KEY,
    citizen_id      TEXT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    secret          TEXT NOT NULL,
    events          TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[],
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    retry_max       INT NOT NULL DEFAULT 3,
    timeout_ms      INT NOT NULL DEFAULT 5000,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhooks_citizen ON webhooks (citizen_id, enabled);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              TEXT PRIMARY KEY,
    webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_id        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
    attempt_count   INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    last_error      TEXT,
    request_body    JSONB,
    response_status INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ,
    UNIQUE (webhook_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries (status, next_attempt_at);
