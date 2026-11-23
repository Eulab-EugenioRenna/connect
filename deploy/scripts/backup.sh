#!/bin/sh
# Backup coerente di Connect in produzione: database (schema Connect e Keycloak, pg_dump -Fc)
# e profili WhatsApp del runner. La chiave DATA_ENCRYPTION_KEY sta in .env.production:
# va conservata a parte, senza di lei i dati cifrati del dump non si leggono.
# Esce con errore se un passo fallisce o se il dump non è leggibile: il deploy deve fermarsi.
# Uso: deploy/scripts/backup.sh [etichetta]
set -eu

ENV_FILE="${CONNECT_ENV_FILE:-/srv/connect/.env.production}"
BACKUP_DIR="${CONNECT_BACKUP_DIR:-/srv/connect/backups}"
COMPOSE_FILE="$(cd "$(dirname "$0")/.." && pwd)/compose.production.yml"
LABEL="${1:-manual}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

[ -f "$ENV_FILE" ] || { echo "Manca $ENV_FILE" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

export CONNECT_IMAGE_TAG="${CONNECT_IMAGE_TAG:-backup}"
dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

if ! dc ps --status running --services 2>/dev/null | grep -qx postgres; then
  echo "Database non in esecuzione: primo avvio, nessun dato da salvare."
  exit 0
fi

DB_FILE="$BACKUP_DIR/connect-$STAMP-$LABEL.dump"
WA_FILE="$BACKUP_DIR/connect-$STAMP-$LABEL-profiles.tar.gz"

echo "Dump del database in $DB_FILE"
dc exec -T postgres pg_dump -U connect -d connect -Fc > "$DB_FILE.part"
mv "$DB_FILE.part" "$DB_FILE"
echo "Verifica del dump"
dc exec -T postgres pg_restore --list < "$DB_FILE" > /dev/null
[ -s "$DB_FILE" ] || { echo "Dump vuoto" >&2; exit 1; }

if dc ps --status running --services | grep -qx runner; then
  echo "Archivio dei profili WhatsApp in $WA_FILE"
  dc exec -T runner tar -C / -czf - profiles > "$WA_FILE.part"
  mv "$WA_FILE.part" "$WA_FILE"
fi

chmod 600 "$BACKUP_DIR"/connect-"$STAMP"-*
echo "Backup completato: $DB_FILE ($(du -h "$DB_FILE" | cut -f1))"
