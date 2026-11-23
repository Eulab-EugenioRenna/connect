#!/bin/sh
# Crea /srv/connect/.env.production con segreti nuovi generati sul server (mai stampati).
# Non sovrascrive un file esistente. Uso: deploy/scripts/init-env.sh <ip-connect> <cidr-npm> <email-admin>
set -eu
ENV_FILE="${CONNECT_ENV_FILE:-/srv/connect/.env.production}"
IP="${1:?IP privato di Connect}"; CIDR="${2:?IP/CIDR di Nginx Proxy Manager}"; EMAIL="${3:?email amministratore}"
[ -e "$ENV_FILE" ] && { echo "$ENV_FILE esiste già: non lo tocco." >&2; exit 0; }
mkdir -p "$(dirname "$ENV_FILE")"; chmod 700 "$(dirname "$ENV_FILE")"
s() { openssl rand -hex 32; }
umask 077
cat > "$ENV_FILE" <<ENV
POSTGRES_PASSWORD=$(s)
REDIS_PASSWORD=$(s)
DATA_ENCRYPTION_KEY=$(s)
MIGRATION_ENCRYPTION_KEY=$(s)
OIDC_CLIENT_SECRET=$(s)
OIDC_IDENTITY_ADMIN_SECRET=$(s)
KEYCLOAK_ADMIN=eulab-operator
KEYCLOAK_ADMIN_PASSWORD=$(s)
EULAB_ADMIN_USERNAME=admin
EULAB_ADMIN_EMAIL=$EMAIL
EULAB_ADMIN_NAME=Amministratore EULab
EULAB_ADMIN_PASSWORD=$(s)
ONBOARDING_PASSWORD_TTL_SECONDS=86400
CONNECT_BIND_IP=$IP
CONNECT_HTTP_PORT=8088
NPM_TRUSTED_CIDR=$CIDR
RUNNER_CAPACITY=2
SMTP_HOST=
SMTP_PORT=587
SMTP_FROM=
SMTP_USER=
SMTP_PASSWORD=
SMTP_SECURITY=starttls
ENV
chmod 600 "$ENV_FILE"
echo "$ENV_FILE creato (600). Segreti non stampati. Salvare una copia di DATA_ENCRYPTION_KEY fuori dal server."
