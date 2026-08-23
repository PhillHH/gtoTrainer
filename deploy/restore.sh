#!/usr/bin/env bash
#
# Wiederherstellung aus einer Sicherung.
#
#   ./deploy/restore.sh <dump.sql.gz> [zieldatenbank]
#
# Ohne Zielangabe wird in die Pruefdatenbank "gto_restore_check" eingespielt -
# die produktive Datenbank bleibt dabei unangetastet. Das ist der empfohlene
# Weg, um eine Sicherung zu VERIFIZIEREN.
#
# Soll wirklich die produktive Datenbank ueberschrieben werden, muss der Name
# explizit angegeben UND RESTORE_CONFIRM=yes gesetzt werden.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '[restore] %s\n' "$*"; }
fail() { printf '[restore] FEHLER: %s\n' "$*" >&2; exit 1; }
trap 'fail "abgebrochen in Zeile $LINENO"' ERR

DUMP="${1:-}"
[[ -n "$DUMP" ]] || fail "Aufruf: ./deploy/restore.sh <dump.sql.gz> [zieldatenbank]"
[[ -f "$DUMP" ]] || fail "Datei nicht gefunden: $DUMP"

[[ -f .env ]] || fail ".env fehlt."
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${POSTGRES_USER:?POSTGRES_USER fehlt in .env}"
: "${POSTGRES_DB:?POSTGRES_DB fehlt in .env}"
CONTAINER="${POSTGRES_CONTAINER:-gto-postgres}"
TARGET_DB="${2:-gto_restore_check}"

docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "Container $CONTAINER laeuft nicht."

# Schutz: die produktive Datenbank nur mit ausdruecklicher Bestaetigung.
if [[ "$TARGET_DB" == "$POSTGRES_DB" && "${RESTORE_CONFIRM:-no}" != "yes" ]]; then
  fail "Ziel ist die PRODUKTIVE Datenbank '$POSTGRES_DB'. Zum Ueberschreiben RESTORE_CONFIRM=yes setzen."
fi

[[ "$TARGET_DB" =~ ^[a-zA-Z0-9_]+$ ]] || fail "Unzulaessiger Datenbankname: $TARGET_DB"

psql_run() {
  docker exec -i "$CONTAINER" psql --username "$POSTGRES_USER" "$@"
}

log "Ziel-Datenbank: $TARGET_DB (Quelle: $DUMP)"

# Zieldatenbank frisch anlegen.
log "Lege Ziel-Datenbank neu an ..."
psql_run --dbname postgres -v ON_ERROR_STOP=1 -c "drop database if exists \"$TARGET_DB\";" >/dev/null
psql_run --dbname postgres -v ON_ERROR_STOP=1 -c "create database \"$TARGET_DB\";" >/dev/null

log "Spiele Dump ein ..."
gunzip -c "$DUMP" | psql_run --dbname "$TARGET_DB" -v ON_ERROR_STOP=1 --quiet >/dev/null

# --- Pruefung ---------------------------------------------------------------
log "Pruefe Ergebnis ..."
echo "--- Tabellen in $TARGET_DB ---"
psql_run --dbname "$TARGET_DB" -tAc \
  "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name;"

echo "--- Zeilenzahlen ---"
psql_run --dbname "$TARGET_DB" -tAc \
  "select 'config='||(select count(*) from config)
        ||' user='||(select count(*) from \"user\")
        ||' session='||(select count(*) from session)
        ||' job_queue='||(select count(*) from job_queue)
        ||' llm_call_log='||(select count(*) from llm_call_log);"

TABLE_COUNT="$(psql_run --dbname "$TARGET_DB" -tAc \
  "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';" | tr -d '[:space:]')"

[[ "$TABLE_COUNT" == "5" ]] || fail "Erwartet 5 Tabellen, gefunden: $TABLE_COUNT"

log "ERFOLGREICH: Wiederherstellung geprueft ($TABLE_COUNT Tabellen)."
if [[ "$TARGET_DB" == "gto_restore_check" ]]; then
  log "Hinweis: Pruefdatenbank '$TARGET_DB' bleibt bestehen. Entfernen mit:"
  log "  docker exec $CONTAINER psql -U $POSTGRES_USER -d postgres -c 'drop database \"$TARGET_DB\";'"
fi
