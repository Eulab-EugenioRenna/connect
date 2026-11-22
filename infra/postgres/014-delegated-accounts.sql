-- Immutable receipt for delegated mirror provisioning. No credentials are stored.
-- Existing administrative/onboarding mappings are deliberately not adopted as receipts.
ALTER TABLE app_local_users ADD COLUMN IF NOT EXISTS mirror_fingerprint text;
