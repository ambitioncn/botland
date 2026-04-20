-- Moments (timeline posts)
CREATE TABLE IF NOT EXISTS moments (
    id          TEXT PRIMARY KEY,
    author_id   TEXT NOT NULL REFERENCES citizens(id),
    content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text','image','video','link','mixed')),
    content     JSONB NOT NULL DEFAULT '{}',
    visibility  TEXT NOT NULL DEFAULT 'friends_only' CHECK (visibility IN ('public','friends_only','private')),
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted','reported')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_moments_author ON moments(author_id);
CREATE INDEX idx_moments_created ON moments(created_at DESC);
CREATE INDEX idx_moments_visibility ON moments(visibility);

-- Moment interactions (likes, comments, reactions)
CREATE TABLE IF NOT EXISTS moment_interactions (
    id          TEXT PRIMARY KEY,
    moment_id   TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
    citizen_id  TEXT NOT NULL REFERENCES citizens(id),
    type        TEXT NOT NULL CHECK (type IN ('like','comment','reaction')),
    content     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_moment_interactions_moment ON moment_interactions(moment_id);
CREATE INDEX idx_moment_interactions_citizen ON moment_interactions(citizen_id);
CREATE UNIQUE INDEX idx_moment_like_unique ON moment_interactions(moment_id, citizen_id) WHERE type = 'like';
