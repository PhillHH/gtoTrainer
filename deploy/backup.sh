#!/usr/bin/env bash
#
# Sicherung von Datenbank und Datenverzeichnis.
#
#   ./deploy/backup.sh
#
# Erzeugt zwei Dateien mit Zeitstempel im Namen:
#   gto-db-<zeitstempel>.sql.gz     - pg_dump der Datenbank
#   gto-data-<zeitstempel>.tar.gz   - Inhalt von data/ (Buchquellen, Assets)
#
# Ziel ist BACKUP_DIR aus der .env - bewusst AUSSERHALB des Repos, damit
# Sicherungen nie versioniert werden. Alte Sicherungen werden rotiert
# (BACKUP_KEEP Stueck je Typ).
#
# Es steht KEIN Passwort im Skript: Die Zugangsdaten kommen aus der .env bzw.
# aus dem laufenden Container.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '[backup] %s\n' "$*"; }
fail() { printf '[backup] FEHLER: %s\n' "$*" >&2; exit 1; }
trap 'fail "abgebrochen in Zeile $LINENO"' ERR

[[ -f .env ]] || fail ".env fehlt."
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${POSTGRES_USER:?POSTGRES_USER fehlt in .env}"
: "${POSTGRES_DB:?POSTGRES_DB fehlt in .env}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/gto-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
CONTAINER="${POSTGRES_CONTAINER:-gto-postgres}"

docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "Container $CONTAINER laeuft nicht."

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DB_FILE="$BACKUP_DIR/gto-db-$STAMP.sql.gz"
DATA_FILE="$BACKUP_DIR/gto-data-$STAMP.tar.gz"

# --- Datenbank --------------------------------------------------------------
log "Sichere Datenbank '$POSTGRES_DB' nach $DB_FILE ..."
# --clean --if-exists macht den Dump ohne Vorarbeit wieder einspielbar.
docker exec "$CONTAINER" pg_dump \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --clean --if-exists --no-owner --no-privileges \
  | gzip -9 > "$DB_FILE"

[[ -s "$DB_FILE" ]] || fail "Dump ist leer - Sicherung fehlgeschlagen."

# --- Datenverzeichnis -------------------------------------------------------
if [[ -d data ]]; then
  log "Sichere data/ nach $DATA_FILE ..."
  tar -czf "$DATA_FILE" data
else
  log "Kein data/-Verzeichnis vorhanden - ueberspringe."
fi

# --- Rotation ---------------------------------------------------------------
rotate() {
  local pattern="$1"
  local count
  count="$(find "$BACKUP_DIR" -maxdepth 1 -name "$pattern" -type f | wc -l)"
  if (( count > BACKUP_KEEP )); then
    log "Rotation: entferne $(( count - BACKUP_KEEP )) alte Sicherung(en) ($pattern)."
    # Aelteste zuerst loeschen.
    find "$BACKUP_DIR" -maxdepth 1 -name "$pattern" -type f -printf '%T@ %p\n' \
      | sort -n | head -n "$(( count - BACKUP_KEEP ))" | cut -d' ' -f2- \
      | xargs -r rm -f
  fi
}
rotate 'gto-db-*.sql.gz'
rotate 'gto-data-*.tar.gz'

log "Vorhandene Sicherungen:"
ls -lh "$BACKUP_DIR" | tail -n +2

log "ERFOLGREICH: Sicherung abgeschlossen."
