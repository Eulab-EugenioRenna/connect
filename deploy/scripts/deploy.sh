#!/bin/sh
# Deploy di Connect su Proxmox (profilo P1, §14 del modello EULAB).
# Usato a mano al primo giro e poi dal workflow GitHub "deploy" sul runner self-hosted.
# Uso: deploy/scripts/deploy.sh <tag-immagine>   (tag = commit)
# Ritorno indietro: rilanciare con il tag precedente (/srv/connect/previous-tag); se le
# migrazioni hanno cambiato dati, ripristinare il backup fatto prima del deploy.
set -eu

TAG="${1:?Specificare il tag immagine (commit)}"
ENV_FILE="${CONNECT_ENV_FILE:-/srv/connect/.env.production}"
HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$HERE/../compose.production.yml"
STATE_DIR="${CONNECT_STATE_DIR:-/srv/connect}"

[ -f "$ENV_FILE" ] || { echo "Manca $ENV_FILE (vedi deploy/scripts/init-env.sh)" >&2; exit 1; }
perm="$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")"
[ "$perm" = "600" ] || { echo "$ENV_FILE deve avere permessi 600 (ora $perm)" >&2; exit 1; }
for key in POSTGRES_PASSWORD REDIS_PASSWORD DATA_ENCRYPTION_KEY MIGRATION_ENCRYPTION_KEY OIDC_CLIENT_SECRET \
  OIDC_IDENTITY_ADMIN_SECRET KEYCLOAK_ADMIN_PASSWORD EULAB_ADMIN_PASSWORD; do
  grep -Eq "^$key=[0-9a-f]{64}$" "$ENV_FILE" || { echo "$key: serve un segreto casuale di 32 byte in esadecimale" >&2; exit 1; }
done
for key in EULAB_ADMIN_EMAIL CONNECT_BIND_IP NPM_TRUSTED_CIDR; do
  grep -Eq "^$key=.+" "$ENV_FILE" || { echo "Variabile obbligatoria vuota: $key" >&2; exit 1; }
done
grep -Eq '^NPM_TRUSTED_CIDR=(0\.0\.0\.0/0|::/0)$' "$ENV_FILE" && { echo "NPM_TRUSTED_CIDR troppo aperto" >&2; exit 1; }

export CONNECT_IMAGE_TAG="$TAG"
dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

echo "== 1/5 Configurazione"
dc config --quiet

echo "== 2/5 Immagini $TAG"
if [ "${CONNECT_SKIP_PULL:-0}" = 1 ]; then echo "Download saltato (CONNECT_SKIP_PULL=1, solo per prove)"; else dc pull; fi

echo "== 3/5 Backup prima delle migrazioni"
"$HERE/backup.sh" "pre-$TAG"

echo "== 4/5 Avvio: migrazioni, Keycloak, bootstrap SSO, API, runner, web"
dc up -d --remove-orphans

echo "== 5/5 Controllo di salute"
probe() { dc exec -T web wget -q -S -O /dev/null --header "Host: $1" "http://127.0.0.1$2" 2>&1 | awk '/HTTP\//{c=$2} END{print c+0}'; }
ok=0
for i in $(seq 1 80); do
  admin="$(probe connect.eulab.cloud /admin/ || true)"
  api="$(probe connect.eulab.cloud /v1/health || true)"
  oidc="$(probe auth.eulab.cloud /sso/realms/eulab/.well-known/openid-configuration || true)"
  if [ "$admin" = 200 ] && [ "$api" = 200 ] && [ "$oidc" = 200 ]; then ok=1; break; fi
  sleep 5
done
dc ps
if [ "$ok" != 1 ]; then
  echo "Controllo fallito: admin=$admin api=$api oidc=$oidc" >&2
  dc logs --tail 60 bootstrap api keycloak >&2 || true
  exit 1
fi

mkdir -p "$STATE_DIR"
prev="$(cat "$STATE_DIR/current-tag" 2>/dev/null || echo nessuno)"
echo "$prev" > "$STATE_DIR/previous-tag"
echo "$TAG" > "$STATE_DIR/current-tag"
echo "Deploy riuscito: $TAG (precedente: $prev). /admin/=200 /v1/health=200 oidc=200"
