CREATE TABLE IF NOT EXISTS event_log (
    id           TEXT PRIMARY KEY,
    citizen_id   TEXT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    event_key    TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    acked_at     TIMESTAMPTZ,
    UNIQUE (citizen_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_event_log_citizen_id ON event_log (citizen_id, id);
CREATE INDEX IF NOT EXISTS idx_event_log_citizen_created ON event_log (citizen_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_event_log_citizen_acked ON event_log (citizen_id, acked_at) WHERE acked_at IS NULL;
