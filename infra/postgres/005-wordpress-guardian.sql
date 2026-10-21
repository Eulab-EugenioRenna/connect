CREATE TABLE wordpress_guardians (
 installation_id uuid PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
 secret_hash text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 heartbeat_at timestamptz,
 status text NOT NULL DEFAULT 'unknown' CHECK(status IN ('unknown','active','missing','paused','error','repaired')),
 last_error text NOT NULL DEFAULT '',
 repairs integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
