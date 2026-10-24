-- Assistenza all'attivazione e migrazione da account locali.
-- La sorgente/deployment e' registrata da EULAB prima che esistano app, cliente o
-- installazione. Le password transitorie vivono cifrate con una chiave distinta
-- e vengono cancellate alla conclusione, al rifiuto o alla scadenza.

-- Il segreto server dell'installazione deve essere recuperabile dal backend
-- autorizzato della sorgente. L'hash esistente resta autorevole per /v1/access;
-- la copia cifrata non e' leggibile dal pannello amministrativo.
ALTER TABLE installations ADD COLUMN IF NOT EXISTS secret_cipher text;

CREATE TABLE IF NOT EXISTS connect_sources (
 id text PRIMARY KEY,
 app_id text NOT NULL,
 name text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('development','staging','production')),
 origins jsonb NOT NULL DEFAULT '[]'::jsonb,
 catalog_url text,
 oidc_callbacks jsonb NOT NULL DEFAULT '[]'::jsonb,
 deployment_identity text NOT NULL DEFAULT '',
 secret_hash text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 rotated_at timestamptz
);

CREATE TABLE IF NOT EXISTS source_installation_bindings (
 source_id text NOT NULL REFERENCES connect_sources(id) ON DELETE CASCADE,
 installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 app_id text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_id,installation_id)
);
CREATE INDEX IF NOT EXISTS source_installation_bindings_installation ON source_installation_bindings(installation_id);

-- Associazione esplicita fra azienda locale e cliente Connect, autorizzata
-- dalla sorgente. Non viene mai dedotta dall'email o dal nome azienda.
CREATE TABLE IF NOT EXISTS source_tenant_bindings (
 source_id text NOT NULL REFERENCES connect_sources(id) ON DELETE CASCADE,
 local_tenant_id text NOT NULL,
 customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 app_id text NOT NULL,
 local_name text NOT NULL DEFAULT '',
 local_slug text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_id,local_tenant_id)
);
CREATE INDEX IF NOT EXISTS source_tenant_bindings_customer ON source_tenant_bindings(customer_id);

-- Corrispondenza personale autorizzata: cliente/app/installazione + ID locale.
-- Ruolo e permessi locali sono evidenza per il revisore; l'autorizzazione
-- effettiva resta quella di licenze, appartenenze, assegnazioni e revoche.
CREATE TABLE IF NOT EXISTS app_local_users (
 source_id text NOT NULL REFERENCES connect_sources(id) ON DELETE CASCADE,
 installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 app_id text NOT NULL,
 local_tenant_id text NOT NULL,
 local_user_id text NOT NULL,
 subject text NOT NULL REFERENCES identities(subject),
 email text NOT NULL,
 email_normalized text NOT NULL,
 first_name text NOT NULL DEFAULT '',
 last_name text NOT NULL DEFAULT '',
 role text NOT NULL,
 permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_id,installation_id,local_user_id),
 UNIQUE(source_id,installation_id,subject)
);
CREATE INDEX IF NOT EXISTS app_local_users_email ON app_local_users(source_id,email_normalized);
CREATE INDEX IF NOT EXISTS app_local_users_subject ON app_local_users(subject);

CREATE TABLE IF NOT EXISTS onboarding_practices (
 id uuid PRIMARY KEY,
 source_id text NOT NULL REFERENCES connect_sources(id),
 app_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('migration','activation')),
 local_tenant_id text,
 tenant_name text NOT NULL DEFAULT '',
 tenant_slug text NOT NULL DEFAULT '',
 state text NOT NULL CHECK(state IN ('pending','approved','migrating','completed','rejected','expired','failed')),
 plan jsonb,
 target_customer_id uuid REFERENCES customers(id),
 target_installation_id uuid REFERENCES installations(id),
 checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
 safe_error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_practice_tenant ON onboarding_practices(source_id,app_id,local_tenant_id) WHERE kind='migration';
CREATE INDEX IF NOT EXISTS onboarding_practices_state ON onboarding_practices(state,updated_at DESC);

CREATE TABLE IF NOT EXISTS onboarding_requests (
 id uuid PRIMARY KEY,
 practice_id uuid NOT NULL REFERENCES onboarding_practices(id) ON DELETE CASCADE,
 source_id text NOT NULL REFERENCES connect_sources(id),
 app_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('migration','activation')),
 state text NOT NULL CHECK(state IN ('pending','approved','migrating','completed','rejected','expired','failed')),
 idempotency_key text NOT NULL,
 request_hash text NOT NULL,
 consent_version text NOT NULL,
 local_tenant_id text,
 local_user_id text,
 email text NOT NULL,
 email_normalized text NOT NULL,
 first_name text NOT NULL DEFAULT '',
 last_name text NOT NULL DEFAULT '',
 role text NOT NULL DEFAULT '',
 permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
 company_name text NOT NULL DEFAULT '',
 identity_subject text,
 password_cipher text,
 password_expires_at timestamptz,
 password_deleted_at timestamptz,
 password_consumed_at timestamptz,
 checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
 safe_error text NOT NULL DEFAULT '',
 action_required text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 approved_at timestamptz,
 completed_at timestamptz,
 UNIQUE(source_id,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_requests_person ON onboarding_requests(practice_id,email_normalized);
CREATE INDEX IF NOT EXISTS onboarding_requests_email ON onboarding_requests(source_id,app_id,email_normalized);
CREATE INDEX IF NOT EXISTS onboarding_requests_state ON onboarding_requests(state,updated_at DESC);
CREATE INDEX IF NOT EXISTS onboarding_requests_password_expiry ON onboarding_requests(password_expires_at) WHERE password_cipher IS NOT NULL;
