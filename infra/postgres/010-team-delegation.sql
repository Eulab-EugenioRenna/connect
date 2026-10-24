-- Revoca dell'accesso a una singola applicazione per un cliente.
-- L'identità globale, l'appartenenza al cliente e il collegamento locale restano invariati:
-- la revoca riguarda solo la coppia cliente/applicazione.
CREATE TABLE IF NOT EXISTS app_access_revocations (
 customer_id uuid NOT NULL REFERENCES customers(id),
 app_id text NOT NULL REFERENCES applications(id),
 subject text NOT NULL REFERENCES identities(subject),
 revoked_at timestamptz NOT NULL DEFAULT now(),
 revoked_by text NOT NULL,
 PRIMARY KEY(customer_id,app_id,subject)
);
CREATE INDEX IF NOT EXISTS app_access_revocations_subject ON app_access_revocations(subject,customer_id,app_id);
