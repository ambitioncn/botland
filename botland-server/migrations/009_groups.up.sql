-- Groups
CREATE TABLE groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    avatar_url  TEXT,
    description TEXT,
    owner_id    TEXT NOT NULL REFERENCES citizens(id),
    max_members INT NOT NULL DEFAULT 200,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disbanded')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_groups_owner ON groups (owner_id);
CREATE INDEX idx_groups_status ON groups (status);

-- Group members
CREATE TABLE group_members (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    citizen_id  TEXT NOT NULL REFERENCES citizens(id),
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    nickname    TEXT,
    muted       BOOLEAN NOT NULL DEFAULT FALSE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, citizen_id)
);

CREATE INDEX idx_group_members_group ON group_members (group_id);
CREATE INDEX idx_group_members_citizen ON group_members (citizen_id);

-- Group messages (separate from message_relay)
CREATE TABLE group_messages (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups(id),
    sender_id   TEXT NOT NULL REFERENCES citizens(id),
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_group_messages_group_time ON group_messages (group_id, created_at DESC);
CREATE INDEX idx_group_messages_sender ON group_messages (sender_id);
