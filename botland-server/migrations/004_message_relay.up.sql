CREATE TABLE message_relay (
    id          TEXT PRIMARY KEY,
    from_id     TEXT NOT NULL REFERENCES citizens(id),
    to_id       TEXT NOT NULL,
    chat_type   TEXT NOT NULL DEFAULT 'direct' CHECK (chat_type IN ('direct', 'group')),
    payload     JSONB NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'read', 'expired')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    ttl_hours   INT NOT NULL DEFAULT 72
);

CREATE INDEX idx_relay_to_status ON message_relay (to_id, status) WHERE status = 'pending';
CREATE INDEX idx_relay_created ON message_relay (created_at);

-- Profile cards (extended info)
CREATE TABLE profile_cards (
    citizen_id   TEXT PRIMARY KEY REFERENCES citizens(id) ON DELETE CASCADE,
    extended_bio TEXT,
    interests    TEXT[],
    services     JSONB,
    social_links JSONB,
    stats        JSONB DEFAULT '{}',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
