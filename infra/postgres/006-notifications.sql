CREATE TABLE notifications (
 id uuid PRIMARY KEY, subject text NOT NULL, title text NOT NULL, body text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 actor text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
 email_state text NOT NULL DEFAULT 'not_requested' CHECK(email_state IN ('not_requested','sending','accepted','failed','uncertain')),
 UNIQUE(actor,idempotency_key)
);
CREATE INDEX notifications_subject_time ON notifications(subject,created_at DESC,id DESC);
