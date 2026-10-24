-- A recovery key remains reserved even after completion. No password/fingerprint is stored.
CREATE TABLE IF NOT EXISTS onboarding_password_recoveries (
 source_id text NOT NULL REFERENCES connect_sources(id),
 idempotency_key text NOT NULL,
 request_id uuid NOT NULL REFERENCES onboarding_requests(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_id,idempotency_key)
);
