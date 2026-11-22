-- Additive only. Existing manual/bot outbox and webhook credentials are untouched.
CREATE TABLE IF NOT EXISTS automation_delegations (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 app_id text NOT NULL REFERENCES applications(id),
 actor text NOT NULL,
 purpose text NOT NULL,
 channel text NOT NULL CHECK(channel IN ('whatsapp','application_notification','email')),
 functions jsonb NOT NULL CHECK(jsonb_typeof(functions)='array'),
 archive_id uuid REFERENCES wa_archives(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 1,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 idempotency_key text NOT NULL,
 request_hash text NOT NULL,
 credential_hash text NOT NULL,
 credential_cipher text NOT NULL,
 UNIQUE(installation_id,actor,idempotency_key),
 CHECK ((channel='whatsapp' AND archive_id IS NOT NULL) OR (channel<>'whatsapp' AND archive_id IS NULL))
);
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS delegation_id uuid REFERENCES automation_delegations(id);
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS delegation_revision integer;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS delegation_purpose text;
CREATE INDEX IF NOT EXISTS outbox_delegation ON outbox(delegation_id);
-- Historical endpoints deliberately have no recovery receipt/owner.
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS actor text;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS webhook_creation_receipt ON webhook_endpoints(installation_id,actor,idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Separate receipts avoid changing the existing event envelope/table layout.
CREATE TABLE IF NOT EXISTS wa_message_event_receipts (
 message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 kind text NOT NULL,
 event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 PRIMARY KEY(message_id,kind)
);

-- Adopt only already-delivered ordinary events as receipts; preserve every original field.
INSERT INTO wa_message_event_receipts(message_id,kind,event_id)
 SELECT DISTINCT ON (m.id,e.kind) m.id,e.kind,e.id
 FROM events e JOIN wa_sessions s ON s.id=e.session_id
 JOIN messages m ON m.archive_id=s.archive_id AND m.provider_id=e.payload->>'providerId'
 WHERE e.kind='message.received'
 ORDER BY m.id,e.kind,e.created_at,e.id
 ON CONFLICT(message_id,kind) DO NOTHING;
