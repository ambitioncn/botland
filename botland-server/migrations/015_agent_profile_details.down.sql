DROP INDEX IF EXISTS idx_citizens_capabilities;

ALTER TABLE citizens
  DROP COLUMN IF EXISTS services,
  DROP COLUMN IF EXISTS capabilities;
