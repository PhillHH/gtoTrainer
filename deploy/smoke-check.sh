#!/usr/bin/env bash
#
# Smoke-Check gegen eine laufende Instanz.
#
#   ./deploy/smoke-check.sh [basis-url]
#
# Ohne Argument wird http://127.0.0.1:${BACKEND_HOST_PORT} geprueft (Backend
# direkt). Mit Argument laesst sich der Weg ueber den Host-Nginx pruefen, z. B.
#   ./deploy/smoke-check.sh https://gto.growento.com
#
# Bewusst nur ein Erreichbarkeits-Check. Ein Browser-E2E-Test gehoert in T1.6.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '[smoke] %s\n' "$*"; }
fail() { printf '[smoke] FEHLER: %s\n' "$*" >&2; exit 1; }

BASE="${1:-}"
if [[ -z "$BASE" ]]; then
  [[ -f .env ]] || fail ".env fehlt und keine Basis-URL angegeben."
  set -a; # shellcheck disable=SC1091
  source .env; set +a
  BASE="http://127.0.0.1:${BACKEND_HOST_PORT:?BACKEND_HOST_PORT fehlt}"
fi

log "Pruefe $BASE ..."

# 1. /healthz muss 200 und status ok liefern.
code="$(curl -s -o /tmp/smoke-health.json -w '%{http_code}' "$BASE/healthz")"
[[ "$code" == "200" ]] || fail "/healthz lieferte HTTP $code (erwartet 200)"
grep -q '"ok"' /tmp/smoke-health.json || fail "/healthz lieferte keinen status ok: $(cat /tmp/smoke-health.json)"
log "OK  /healthz -> HTTP 200 $(cat /tmp/smoke-health.json)"

# 2. Geschuetzte Route muss ohne Session 401 liefern (Auth greift wirklich).
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/me")"
[[ "$code" == "401" ]] || fail "/api/auth/me lieferte HTTP $code (erwartet 401)"
log "OK  /api/auth/me ohne Session -> HTTP 401"

# 3. CSRF-Endpunkt muss ein Token liefern.
code="$(curl -s -o /tmp/smoke-csrf.json -w '%{http_code}' "$BASE/api/auth/csrf")"
[[ "$code" == "200" ]] || fail "/api/auth/csrf lieferte HTTP $code (erwartet 200)"
grep -q 'csrfToken' /tmp/smoke-csrf.json || fail "/api/auth/csrf lieferte kein Token"
log "OK  /api/auth/csrf -> HTTP 200 mit Token"

rm -f /tmp/smoke-health.json /tmp/smoke-csrf.json
log "ERFOLGREICH: Smoke-Check bestanden."
