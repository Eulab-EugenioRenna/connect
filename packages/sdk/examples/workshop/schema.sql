CREATE TABLE IF NOT EXISTS workshop_accounts (
 tenant_id text NOT NULL, id text NOT NULL, email text NOT NULL,
 first_name text NOT NULL,last_name text NOT NULL,
 password_salt text,password_hash text,
 connect_subject text,connect_installation text,
 PRIMARY KEY(tenant_id,id),UNIQUE(connect_installation,connect_subject)
);
CREATE TABLE IF NOT EXISTS workshop_projects (
 id text PRIMARY KEY,tenant_id text NOT NULL,name text NOT NULL
);
