#!/usr/bin/env bash
#
# Deploy des GTO Trainers auf dem Zielhost.
#
#   ./deploy/deploy.sh [--no-pull]
#
# Ablauf: Sourcen holen -> Images bauen -> Migrationen -> Container neu
# starten -> Frontend-Assets veroeffentlichen -> Healthcheck.
#
# Idempotent: Mehrfaches Ausfuehren fuehrt zum selben Ergebnis. Bricht bei
# jedem Fehler mit Exit-Code != 0 ab (kein stilles Weiterlaufen).
#
# Der Host-Nginx wird hier NICHT angefasst - das ist eine einmalige,
# root-pflichtige Einrichtung (siehe docs/RUNBOOK.md, Abschnitt 9).

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] FEHLER: %s\n' "$*" >&2; exit 1; }

trap 'fail "abgebrochen in Zeile $LINENO"' ERR

PULL=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    *) fail "Unbekannte Option: $arg (erlaubt: --no-pull)" ;;
  esac
done

# --- Konfiguration ----------------------------------------------------------
[[ -f .env ]] || fail ".env fehlt. Anlegen mit: cp .env.example .env (dann ausfuellen)"

# .env laden, ohne bestehende Prozessvariablen zu ueberschreiben.
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${BACKEND_HOST_PORT:?BACKEND_HOST_PORT fehlt in .env}"
: "${FRONTEND_STATIC_DIR:?FRONTEND_STATIC_DIR fehlt in .env}"

command -v docker >/dev/null || fail "docker nicht gefunden"
docker compose version >/dev/null 2>&1 || fail "docker compose (v2) nicht gefunden"

# --- 1. Sourcen -------------------------------------------------------------
if [[ "$PULL" -eq 1 ]]; then
  if [[ -d .git ]]; then
    log "Hole aktuellen Stand (git pull --ff-only) ..."
    git pull --ff-only
  else
    log "Kein Git-Repository - ueberspringe pull."
  fi
else
  log "--no-pull gesetzt: ueberspringe git pull."
fi

# --- 2. Images bauen --------------------------------------------------------
log "Baue Backend-Image ..."
docker compose build backend

log "Baue Frontend-Assets ..."
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
docker build -f apps/frontend/Dockerfile --target assets \
  --output "type=local,dest=$STAGING" .
[[ -f "$STAGING/dist/index.html" ]] || fail "Frontend-Build lieferte keine index.html"

# --- 3. Datenbank starten ---------------------------------------------------
log "Starte Datenbank ..."
docker compose up -d postgres

log "Warte auf gesunde Datenbank ..."
for _ in $(seq 1 60); do
  status="$(docker inspect --format '{{.State.Health.Status}}' gto-postgres 2>/dev/null || echo starting)"
  [[ "$status" == "healthy" ]] && break
  sleep 2
done
[[ "${status:-}" == "healthy" ]] || fail "Datenbank wurde nicht healthy"

# --- 4. Migrationen ---------------------------------------------------------
# Einmaliger Lauf VOR dem Start des Backends (siehe ADR-0017). Idempotent:
# Drizzle fuehrt Buch in drizzle.__drizzle_migrations.
log "Spiele Migrationen ein ..."
docker compose run --rm --no-deps backend node dist/db/cli-migrate.js

# --- 5. Backend (neu) starten ----------------------------------------------
log "Starte Backend ..."
docker compose up -d --force-recreate backend

# --- 6. Frontend-Assets veroeffentlichen ------------------------------------
log "Veroeffentliche Frontend-Assets nach $FRONTEND_STATIC_DIR ..."
# Verzeichnistausch statt Kopieren in den laufenden Bestand: So bleiben keine
# alten, gehashten Assets liegen, und es gibt kein Zeitfenster, in dem die
# index.html schon neu, die Assets aber noch alt sind.
NEW_DIR="${FRONTEND_STATIC_DIR}.new"
OLD_DIR="${FRONTEND_STATIC_DIR}.old"
rm -rf "$NEW_DIR" "$OLD_DIR"
cp -a "$STAGING/dist" "$NEW_DIR"
# Der Nginx-Worker (www-data) muss lesen duerfen.
chmod -R a+rX "$NEW_DIR"
if [[ -d "$FRONTEND_STATIC_DIR" ]]; then
  mv "$FRONTEND_STATIC_DIR" "$OLD_DIR"
fi
mv "$NEW_DIR" "$FRONTEND_STATIC_DIR"
rm -rf "$OLD_DIR"

# --- 7. Healthcheck ---------------------------------------------------------
log "Pruefe /healthz auf 127.0.0.1:${BACKEND_HOST_PORT} ..."
healthy=0
for _ in $(seq 1 30); do
  # Fehler waehrend des Hochfahrens sind normal - erst der letzte Versuch zaehlt.
  if curl -fsS "http://127.0.0.1:${BACKEND_HOST_PORT}/healthz" 2>/dev/null | grep -q '"ok"'; then
    healthy=1
    break
  fi
  sleep 2
done
[[ "$healthy" -eq 1 ]] || fail "/healthz antwortet nicht mit status ok"

log "Containerstatus:"
docker compose ps --format 'table {{.Name}}\t{{.Status}}'

log "ERFOLGREICH: Deployment abgeschlossen."
