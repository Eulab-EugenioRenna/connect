-- A send verified as not sent on the phone is tried again: attempt count and earliest next attempt.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS not_before timestamptz;
