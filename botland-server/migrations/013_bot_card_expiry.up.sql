ALTER TABLE bot_cards
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE bot_cards
SET expires_at = COALESCE(expires_at, created_at + INTERVAL '30 minutes')
WHERE expires_at IS NULL;

ALTER TABLE bot_cards
    ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bot_cards_expires_at ON bot_cards (expires_at);
