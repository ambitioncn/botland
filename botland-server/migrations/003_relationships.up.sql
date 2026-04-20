CREATE TABLE relationships (
    id              TEXT PRIMARY KEY,
    citizen_a_id    TEXT NOT NULL REFERENCES citizens(id),
    citizen_b_id    TEXT NOT NULL REFERENCES citizens(id),
    label_a_to_b    TEXT,
    label_b_to_a    TEXT,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'blocked', 'ended')),
    initiated_by    TEXT NOT NULL REFERENCES citizens(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (citizen_a_id, citizen_b_id),
    CHECK (citizen_a_id < citizen_b_id)
);

CREATE INDEX idx_relationships_a ON relationships (citizen_a_id);
CREATE INDEX idx_relationships_b ON relationships (citizen_b_id);

CREATE TABLE friend_requests (
    id          TEXT PRIMARY KEY,
    from_id     TEXT NOT NULL REFERENCES citizens(id),
    to_id       TEXT NOT NULL REFERENCES citizens(id),
    greeting    TEXT,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_friend_requests_to ON friend_requests (to_id, status);
CREATE INDEX idx_friend_requests_from ON friend_requests (from_id);
