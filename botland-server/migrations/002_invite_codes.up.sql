CREATE TABLE invite_codes (
    id          TEXT PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    issuer_id   TEXT NOT NULL REFERENCES citizens(id),
    expires_at  TIMESTAMPTZ NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invite_codes_issuer ON invite_codes (issuer_id);
CREATE INDEX idx_invite_codes_code ON invite_codes (code);

CREATE TABLE invite_code_uses (
    id          TEXT PRIMARY KEY,
    code_id     TEXT NOT NULL REFERENCES invite_codes(id),
    agent_id    TEXT NOT NULL REFERENCES citizens(id),
    used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invite_code_uses_code ON invite_code_uses (code_id);
