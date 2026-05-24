-- Tieba-style communities / posts / floor replies

CREATE TABLE communities (
    id              TEXT PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT,
    avatar_url      TEXT,
    cover_url       TEXT,
    owner_id        TEXT NOT NULL REFERENCES citizens(id),
    visibility      TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted', 'private')),
    post_permission TEXT NOT NULL DEFAULT 'members' CHECK (post_permission IN ('everyone', 'members', 'moderators')),
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
    member_count    INT NOT NULL DEFAULT 0,
    post_count      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_communities_status_updated ON communities (status, updated_at DESC, id DESC);
CREATE INDEX idx_communities_owner ON communities (owner_id, created_at DESC);
CREATE INDEX idx_communities_name ON communities (name);

CREATE TABLE community_members (
    id            TEXT PRIMARY KEY,
    community_id  TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    citizen_id    TEXT NOT NULL REFERENCES citizens(id),
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'moderator', 'member')),
    state         TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'muted', 'banned')),
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ,
    UNIQUE (community_id, citizen_id)
);

CREATE INDEX idx_community_members_community ON community_members (community_id, role, joined_at DESC);
CREATE INDEX idx_community_members_citizen ON community_members (citizen_id, joined_at DESC, community_id);

CREATE TABLE community_posts (
    id             TEXT PRIMARY KEY,
    community_id   TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    author_id      TEXT NOT NULL REFERENCES citizens(id),
    title          TEXT NOT NULL,
    content        JSONB NOT NULL,
    post_type      TEXT NOT NULL DEFAULT 'discussion' CHECK (post_type IN ('discussion', 'question', 'announcement')),
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted', 'hidden')),
    is_pinned      BOOLEAN NOT NULL DEFAULT FALSE,
    is_featured    BOOLEAN NOT NULL DEFAULT FALSE,
    reply_count    INT NOT NULL DEFAULT 0,
    last_reply_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_community_posts_community_recent
    ON community_posts (community_id, is_pinned DESC, last_reply_at DESC NULLS LAST, created_at DESC, id DESC)
    WHERE status = 'active';
CREATE INDEX idx_community_posts_community_new
    ON community_posts (community_id, created_at DESC, id DESC)
    WHERE status = 'active';
CREATE INDEX idx_community_posts_author ON community_posts (author_id, created_at DESC);
CREATE INDEX idx_community_posts_featured
    ON community_posts (community_id, is_featured, created_at DESC, id DESC)
    WHERE status = 'active';

CREATE TABLE community_replies (
    id            TEXT PRIMARY KEY,
    post_id       TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    community_id  TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    author_id     TEXT NOT NULL REFERENCES citizens(id),
    floor_no      INT NOT NULL,
    content       JSONB NOT NULL,
    reply_to_id   TEXT REFERENCES community_replies(id),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted', 'hidden')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (post_id, floor_no)
);

CREATE INDEX idx_community_replies_post_floor ON community_replies (post_id, floor_no ASC, id ASC);
CREATE INDEX idx_community_replies_author ON community_replies (author_id, created_at DESC);
CREATE INDEX idx_community_replies_community_time ON community_replies (community_id, created_at DESC);

CREATE TABLE community_reactions (
    id          TEXT PRIMARY KEY,
    target_type TEXT NOT NULL CHECK (target_type IN ('post', 'reply')),
    target_id   TEXT NOT NULL,
    citizen_id  TEXT NOT NULL REFERENCES citizens(id),
    emoji       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (target_type, target_id, citizen_id, emoji)
);

CREATE INDEX idx_community_reactions_target ON community_reactions (target_type, target_id);
CREATE INDEX idx_community_reactions_citizen ON community_reactions (citizen_id, created_at DESC);

CREATE TABLE community_moderation_logs (
    id            TEXT PRIMARY KEY,
    community_id  TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    actor_id      TEXT NOT NULL REFERENCES citizens(id),
    action        TEXT NOT NULL,
    target_type   TEXT NOT NULL,
    target_id     TEXT NOT NULL,
    reason        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_community_mod_logs_community_time ON community_moderation_logs (community_id, created_at DESC);
CREATE INDEX idx_community_mod_logs_actor_time ON community_moderation_logs (actor_id, created_at DESC);
