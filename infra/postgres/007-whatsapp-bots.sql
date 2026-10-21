-- One explicit bot configuration per installation + linked number archive.
CREATE TABLE wa_bots (
 archive_id uuid PRIMARY KEY REFERENCES wa_archives(id) ON DELETE CASCADE,
 definition jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false,
 actor text NOT NULL,
 technical_admin boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wa_bot_conversations (
 archive_id uuid NOT NULL REFERENCES wa_bots(archive_id) ON DELETE CASCADE,
 chat_id text NOT NULL,
 revision integer NOT NULL,
 state jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(archive_id,chat_id)
);
ALTER TABLE outbox ADD COLUMN bot_archive_id uuid REFERENCES wa_bots(archive_id) ON DELETE CASCADE;
ALTER TABLE outbox ADD COLUMN bot_revision integer;
