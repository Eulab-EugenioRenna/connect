ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS delete_requested boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS audit_created_at ON audit(created_at DESC,id DESC);
