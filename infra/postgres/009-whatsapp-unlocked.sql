CREATE TABLE wa_contacts (
 archive_id uuid NOT NULL REFERENCES wa_archives(id) ON DELETE CASCADE,
 chat_id text NOT NULL,
 profile jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(archive_id,chat_id)
);
CREATE TABLE wa_operations (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
 idempotency_key text NOT NULL,
 request_hash text NOT NULL,
 actor text NOT NULL,
 authorization_cipher text NOT NULL,
 command jsonb NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','cancelled','uncertain')),
 result jsonb,
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(installation_id,idempotency_key)
);
CREATE INDEX wa_operations_pending ON wa_operations(session_id,state);
CREATE TABLE wa_voice_ivr (
 id uuid PRIMARY KEY,
 archive_id uuid NOT NULL REFERENCES wa_archives(id) ON DELETE CASCADE,
 actor text NOT NULL,
 call_id text NOT NULL,
 idempotency_key text NOT NULL,
 definition jsonb NOT NULL,
 revision integer NOT NULL,
 turn integer NOT NULL DEFAULT 0,
 result jsonb NOT NULL,
 initial_response jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 UNIQUE(archive_id,idempotency_key),
 UNIQUE(archive_id,call_id)
);
CREATE TABLE wa_voice_turns (
 session_id uuid NOT NULL REFERENCES wa_voice_ivr(id) ON DELETE CASCADE,
 idempotency_key text NOT NULL,
 request_hash text NOT NULL,
 response jsonb NOT NULL,
 PRIMARY KEY(session_id,idempotency_key)
);
