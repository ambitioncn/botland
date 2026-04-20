CREATE TABLE IF NOT EXISTS push_tokens (
    id SERIAL PRIMARY KEY,
    citizen_id TEXT NOT NULL REFERENCES citizens(id),
    token TEXT NOT NULL,
    platform TEXT DEFAULT 'expo',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(citizen_id, token)
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_citizen ON push_tokens(citizen_id);
