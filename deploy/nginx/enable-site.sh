#!/usr/bin/env bash
#
# Schaltet den GTO-Trainer-vhost scharf und holt das TLS-Zertifikat.
#
#   sudo ./deploy/nginx/enable-site.sh
#
# Das ist der einzige Schritt des Deployments, der Root braucht (RUNBOOK 8.4
# und 8.5). Er ist bewusst aus `deploy.sh` herausgehalten, damit ein normaler
# Deploy ohne Root auskommt.
#
# Idempotent: Mehrfaches Ausfuehren fuehrt zum selben Ergebnis. Bricht bei
# jedem Fehler ab, statt halb fertig weiterzulaufen.

set -Eeuo pipefail

DOMAIN="${DOMAIN:-gto.growento.com}"
# Adresse fuer die Ablaufwarnungen von Let's Encrypt. Ohne sie registriert
# certbot anonym - dann kommt keine Mail, wenn die Erneuerung klemmt.
EMAIL="${EMAIL:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONF="${DOMAIN}.conf"
AVAILABLE="/etc/nginx/sites-available/${CONF}"
ENABLED="/etc/nginx/sites-enabled/${CONF}"
# Wem die Assets gehoeren; certbot und nginx laufen als root, das Repo nicht.
OWNER="${SUDO_USER:-phillip}"

log()  { printf '[vhost] %s\n' "$*"; }
fail() { printf '[vhost] FEHLER: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail "Bitte als root ausfuehren: sudo $0"

# --- 1. DNS zuerst ----------------------------------------------------------
# Ein Zertifikat "auf Verdacht" anzufordern zaehlt auf das Let's-Encrypt-Limit,
# auch wenn es scheitert. Deshalb wird vorher geprueft.
log "Pruefe DNS fuer ${DOMAIN} ..."
DNS_IP="$(dig +short "${DOMAIN}" | tail -1)"
HOST_IP="$(curl -s -4 --max-time 10 https://ifconfig.me || true)"
[[ -n "$DNS_IP" ]] || fail "Kein A-Record fuer ${DOMAIN}."
if [[ "$DNS_IP" != "$HOST_IP" ]]; then
  fail "DNS zeigt auf ${DNS_IP}, dieser Host ist ${HOST_IP}. Erst DNS richten."
fi
log "DNS und Host stimmen ueberein (${DNS_IP})."

# --- 2. vhost bereitstellen -------------------------------------------------
if [[ ! -f "$AVAILABLE" ]]; then
  log "Kopiere vhost nach ${AVAILABLE} ..."
  cp "${REPO_ROOT}/deploy/nginx/${CONF}" "$AVAILABLE"
elif ! diff -q "$AVAILABLE" "${REPO_ROOT}/deploy/nginx/${CONF}" >/dev/null 2>&1; then
  # Nach dem ersten certbot-Lauf weicht die installierte Fassung ab - sie
  # traegt dann den TLS-Block. Das ist erwartet und kein Grund zu ueberschreiben.
  if grep -q "listen 443" "$AVAILABLE"; then
    log "Installierte Fassung traegt bereits TLS - wird nicht ueberschrieben."
  else
    log "WARNUNG: ${AVAILABLE} weicht von der Repo-Fassung ab (ohne TLS-Block)."
    log "         Bitte von Hand pruefen. Es wird nichts ueberschrieben."
  fi
fi

# --- 3. Assets lesbar machen ------------------------------------------------
STATIC_DIR="$(grep -E '^\s*root\s' "$AVAILABLE" | head -1 | awk '{print $2}' | tr -d ';')"
if [[ -n "$STATIC_DIR" && -d "$STATIC_DIR" ]]; then
  log "Mache ${STATIC_DIR} fuer den Nginx-Worker lesbar ..."
  chmod o+x "/home/${OWNER}"
  chmod -R a+rX "$STATIC_DIR"
else
  log "WARNUNG: Konnte das Asset-Verzeichnis nicht aus dem vhost lesen."
fi

# --- 4. aktivieren ----------------------------------------------------------
log "Aktiviere ${CONF} ..."
ln -sfn "../sites-available/${CONF}" "$ENABLED"

log "Pruefe Nginx-Konfiguration ..."
nginx -t
log "Lade Nginx neu ..."
systemctl reload nginx

log "HTTP-Probe ..."
curl -fsS --max-time 10 "http://${DOMAIN}/healthz" && echo
log "Stufe A steht: ${DOMAIN} ist ueber HTTP erreichbar."

# --- 5. TLS -----------------------------------------------------------------
if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
  log "Zertifikat existiert bereits - certbot wird nicht erneut aufgerufen."
else
  log "Fordere Zertifikat an (certbot --nginx) ..."
  if [[ -n "$EMAIL" ]]; then
    certbot --nginx -d "${DOMAIN}" --redirect --non-interactive --agree-tos \
      -m "$EMAIL" || fail "certbot fehlgeschlagen."
  else
    log "WARNUNG: Keine EMAIL gesetzt - anonyme Registrierung, keine"
    log "         Ablaufwarnungen. Fuer den Dauerbetrieb: EMAIL=... sudo -E $0"
    certbot --nginx -d "${DOMAIN}" --redirect --non-interactive --agree-tos \
      --register-unsafely-without-email || fail "certbot fehlgeschlagen."
  fi
fi

log "HTTPS-Probe ..."
curl -fsS --max-time 10 "https://${DOMAIN}/healthz" && echo

# --- 6. Der Test, der wirklich zaehlt --------------------------------------
# /healthz kommt auch ohne Session durch. Ob sich jemand anmelden kann, haengt
# am Session-Cookie - und das traegt `Secure`, wird ueber http also gar nicht
# erst gespeichert. Genau daran scheitert der Betrieb ueber Stufe A.
log "Pruefe, ob das CSRF-Cookie ueber HTTPS ankommt ..."
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
curl -fsS -c "$JAR" --max-time 10 "https://${DOMAIN}/api/auth/csrf" >/dev/null
if grep -q gto_csrf "$JAR"; then
  log "Cookie wird gesetzt und gespeichert - Anmeldung ist moeglich."
else
  fail "Das CSRF-Cookie kam nicht an. Ohne es ist keine Anmeldung moeglich."
fi

cat <<EOF

[vhost] FERTIG. ${DOMAIN} laeuft ueber HTTPS, das Session-Cookie kommt an.

COOKIE_SECURE steht bereits auf true (Vorgabe der docker-compose.yml) - das
ist ab jetzt richtig und war der Grund, warum die Anmeldung ueber reines HTTP
nicht funktionieren konnte.

Optional noch schaerfer stellen: die erlaubte Origin fuer die CSRF-Pruefung
festnageln. Ohne diesen Schritt laeuft die App bereits.

  cd ${REPO_ROOT}
  grep -q '^ALLOWED_ORIGINS=' .env \
    && sed -i 's|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=https://${DOMAIN}|' .env \
    || echo 'ALLOWED_ORIGINS=https://${DOMAIN}' >> .env
  ./deploy/deploy.sh --no-pull

EOF
