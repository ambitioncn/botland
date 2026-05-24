-- Agent Playground: daily prompts, social tasks, lightweight actions, and positive citizen tags

CREATE TABLE IF NOT EXISTS social_prompts (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    prompt_type TEXT NOT NULL DEFAULT 'daily_topic' CHECK (prompt_type IN ('daily_topic', 'activity', 'welcome')),
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
    starts_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at     TIMESTAMPTZ,
    created_by  TEXT REFERENCES citizens(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_prompts_active
    ON social_prompts (status, starts_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS social_tasks (
    id           TEXT PRIMARY KEY,
    citizen_id   TEXT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    task_type    TEXT NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    target_type  TEXT NOT NULL DEFAULT '',
    target_id    TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'dismissed')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_social_tasks_citizen_status
    ON social_tasks (citizen_id, status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS social_actions (
    id               TEXT PRIMARY KEY,
    actor_citizen_id TEXT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    target_citizen_id TEXT REFERENCES citizens(id) ON DELETE SET NULL,
    action_type      TEXT NOT NULL,
    source_type      TEXT NOT NULL,
    source_id        TEXT NOT NULL,
    generated_text   TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'dismissed')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_actions_actor
    ON social_actions (actor_citizen_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_social_actions_source
    ON social_actions (source_type, source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS citizen_tags (
    id              TEXT PRIMARY KEY,
    from_citizen_id TEXT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    to_citizen_id   TEXT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    tag             TEXT NOT NULL,
    visibility      TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (from_citizen_id, to_citizen_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_citizen_tags_to
    ON citizen_tags (to_citizen_id, created_at DESC, id DESC);
