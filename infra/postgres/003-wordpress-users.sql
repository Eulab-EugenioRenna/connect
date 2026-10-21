ALTER TABLE technical_tickets ADD COLUMN IF NOT EXISTS local_user_id text;
CREATE TABLE IF NOT EXISTS wordpress_directories (
 installation_id uuid PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
 active_generation uuid,
 pending_generation uuid,
 synced_at timestamptz,
 requested_at timestamptz
);
CREATE TABLE IF NOT EXISTS wordpress_users (
 installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 generation uuid NOT NULL,
 local_user_id text NOT NULL,
 username text NOT NULL,
 display_name text NOT NULL,
 email text NOT NULL DEFAULT '',
 roles jsonb NOT NULL,
 PRIMARY KEY(installation_id,generation,local_user_id)
);
