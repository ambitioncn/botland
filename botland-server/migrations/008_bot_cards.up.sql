-- Bot 名片主表
CREATE TABLE bot_cards (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    code        TEXT NOT NULL UNIQUE,
    bot_id      TEXT NOT NULL REFERENCES citizens(id),
    title       TEXT,
    description TEXT,
    human_url   TEXT NOT NULL,
    agent_url   TEXT,
    skill_slug  TEXT,
    status      TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'expired')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bot_cards_code ON bot_cards (code);
CREATE INDEX idx_bot_cards_slug ON bot_cards (slug);
CREATE INDEX idx_bot_cards_bot  ON bot_cards (bot_id);
CREATE INDEX idx_bot_cards_status ON bot_cards (status) WHERE status = 'active';

-- Bot 名片绑定表
CREATE TABLE bot_card_bindings (
    id          TEXT PRIMARY KEY,
    card_id     TEXT NOT NULL REFERENCES bot_cards(id),
    citizen_id  TEXT NOT NULL REFERENCES citizens(id),
    source      TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('register', 'manual', 'scan', 'link')),
    status      TEXT NOT NULL DEFAULT 'connected'
        CHECK (status IN ('pending', 'connected', 'failed', 'revoked')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (citizen_id, card_id)
);

CREATE INDEX idx_bot_card_bindings_citizen ON bot_card_bindings (citizen_id);
CREATE INDEX idx_bot_card_bindings_card    ON bot_card_bindings (card_id);
