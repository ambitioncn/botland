-- 005: Unified registration with handle + challenge

-- Add handle to citizens (unique, lowercase)
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS handle VARCHAR(20) UNIQUE;

-- Challenge sessions for identity test
CREATE TABLE IF NOT EXISTS challenges (
    id          TEXT PRIMARY KEY,
    identity    VARCHAR(10) NOT NULL CHECK (identity IN ('human', 'agent')),
    questions   JSONB NOT NULL,
    answers     JSONB,
    score       REAL,
    passed      BOOLEAN DEFAULT FALSE,
    token       TEXT UNIQUE,
    used        BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_challenges_token ON challenges(token) WHERE token IS NOT NULL AND used = FALSE;

-- Backfill handles for existing citizens (use lowercase prefix + id suffix)
UPDATE citizens SET handle = LOWER(LEFT(REPLACE(display_name, ' ', ''), 10)) || '_' || RIGHT(id, 6)
WHERE handle IS NULL;

-- Make handle NOT NULL after backfill
ALTER TABLE citizens ALTER COLUMN handle SET NOT NULL;
