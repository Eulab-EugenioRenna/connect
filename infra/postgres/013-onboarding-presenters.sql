-- Technical presentation credentials are not licenses, identities or integrations.
CREATE TABLE onboarding_presenters (
 id uuid PRIMARY KEY, name text NOT NULL, secret_hash text NOT NULL,
 deployment_identity text NOT NULL, verified_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
 verified_app_id text REFERENCES applications(id), enabled boolean NOT NULL DEFAULT true,
 expires_at timestamptz NOT NULL, bound_source_id text UNIQUE REFERENCES connect_sources(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE connect_sources ADD COLUMN presenter_id uuid UNIQUE REFERENCES onboarding_presenters(id);
ALTER TABLE connect_sources ADD COLUMN integration_approved boolean NOT NULL DEFAULT true;
ALTER TABLE connect_sources ADD COLUMN approved_app_id text REFERENCES applications(id);
ALTER TABLE connect_sources ADD COLUMN verified_origins jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE connect_sources ADD COLUMN verified_app_id text REFERENCES applications(id);
ALTER TABLE connect_sources ADD COLUMN configuration_cipher text;
ALTER TABLE onboarding_practices ADD COLUMN configuration_cipher text;
