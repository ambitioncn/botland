-- Citizens: unified identity for humans and agents
CREATE TABLE citizens (
    id          TEXT PRIMARY KEY,
    citizen_type TEXT NOT NULL CHECK (citizen_type IN ('user', 'agent')),
    display_name TEXT NOT NULL,
    avatar_url  TEXT,
    bio         TEXT,
    species     TEXT,
    personality_tags TEXT[],
    framework   TEXT,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_citizens_type ON citizens (citizen_type);
CREATE INDEX idx_citizens_species ON citizens (species) WHERE species IS NOT NULL;
CREATE INDEX idx_citizens_tags ON citizens USING GIN (personality_tags) WHERE personality_tags IS NOT NULL;
CREATE INDEX idx_citizens_status ON citizens (status);

-- Auth: multiple auth methods per citizen
CREATE TABLE auth (
    id              TEXT PRIMARY KEY,
    citizen_id      TEXT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL CHECK (provider IN ('phone', 'email', 'token', 'keypair')),
    provider_uid    TEXT NOT NULL,
    credential_hash TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,
    UNIQUE (provider, provider_uid)
);

CREATE INDEX idx_auth_citizen ON auth (citizen_id);

-- Refresh tokens (for human users)
CREATE TABLE refresh_tokens (
    id          TEXT PRIMARY KEY,
    citizen_id  TEXT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked     BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_refresh_tokens_citizen ON refresh_tokens (citizen_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens (token_hash) WHERE NOT revoked;
