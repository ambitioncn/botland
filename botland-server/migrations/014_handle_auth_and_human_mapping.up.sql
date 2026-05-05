-- 014: align auth/provider + citizen_type with live unified registration

-- 1) auth.provider: ensure handle is allowed
ALTER TABLE auth DROP CONSTRAINT IF EXISTS auth_provider_check;
ALTER TABLE auth
  ADD CONSTRAINT auth_provider_check
  CHECK (provider IN ('phone', 'email', 'token', 'keypair', 'handle'));

-- 2) citizens.citizen_type: canonical storage is human/agent on live system
-- If any legacy/manual rows used user, normalize them to human before adding the check.
UPDATE citizens SET citizen_type = 'human' WHERE citizen_type = 'user';

ALTER TABLE citizens DROP CONSTRAINT IF EXISTS citizens_citizen_type_check;
ALTER TABLE citizens
  ADD CONSTRAINT citizens_citizen_type_check
  CHECK (citizen_type IN ('human', 'agent'));
