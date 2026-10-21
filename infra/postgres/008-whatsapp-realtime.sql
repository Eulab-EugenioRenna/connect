-- Single-use, encrypted credentials for WebSocket authentication (30 seconds).
CREATE TABLE wa_stream_tickets (
 ticket_hash text PRIMARY KEY,
 installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 actor text NOT NULL,
 principal_cipher text NOT NULL,
 origin text,
 expires_at timestamptz NOT NULL
);
CREATE INDEX wa_stream_tickets_expiry ON wa_stream_tickets(expires_at);

CREATE INDEX events_installation_created ON events(installation_id,created_at,id);
