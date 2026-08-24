# Runbook — GTO Trainer

Betriebshandbuch. Stand: AP1.T1.6 — lokales Setup, Datenbankbetrieb,
Zugangsverwaltung, Frontend, Deployment inkl. Backup/Restore **und Tests/CI**.

---

## 1. Voraussetzungen

| Werkzeug | Version                           | Prüfen mit               |
| -------- | --------------------------------- | ------------------------ |
| Node.js  | 20.19.6 (siehe `.nvmrc`)          | `node -v`                |
| pnpm     | 9.15.9 (via Corepack)             | `pnpm -v`                |
| Git      | ≥ 2.39                            | `git --version`          |
| Docker   | ≥ 24 inkl. Compose v2             | `docker compose version` |
| GNU Make | optional, nur für `make`-Kurzform | `make --version`         |

### Node und pnpm einrichten

```bash
nvm install    # liest .nvmrc
nvm use        # aktiviert 20.19.6
corepack enable
corepack prepare pnpm@9.15.9 --activate
```

> **Hinweis:** Ist die Umgebungsvariable `NODE_ENV=production` gesetzt,
> überspringt `pnpm install` die devDependencies und Build/Lint/Test schlagen
> fehl. Für die lokale Entwicklung `NODE_ENV=development` setzen oder die
> Variable leeren.

---

## 2. Installation

```bash
git clone git@github.com:PhillHH/gtoTrainer.git
cd gtoTrainer
pnpm install
cp .env.example .env
```

Anschließend die `.env` bearbeiten: Der Platzhalter
`__SET_A_STRONG_PASSWORD__` muss an **allen drei** Stellen durch dasselbe
Passwort ersetzt werden (`POSTGRES_PASSWORD`, `DATABASE_URL`,
`TEST_DATABASE_URL`). Das Backend verweigert sonst den Start mit einer
expliziten Meldung. Ein Passwort erzeugen:

```bash
openssl rand -hex 24
```

Vor dem ersten Start prüfen, ob der Datenbank-Port frei ist:

```bash
ss -ltn | grep 55434 || echo "55434 frei"
```

Ist er belegt, in der `.env` `POSTGRES_HOST_PORT` **und** den Port in beiden
Verbindungs-URLs auf einen freien Wert ändern.

---

## 3. Tägliche Kommandos

| Zweck                                  | pnpm                          | make         |
| -------------------------------------- | ----------------------------- | ------------ |
| Dev-Server (alle Workspaces, parallel) | `pnpm dev`                    | `make dev`   |
| Produktions-Build                      | `pnpm build`                  | `make build` |
| Lint + Formatprüfung                   | `pnpm lint`                   | `make lint`  |
| Tests                                  | `pnpm test`                   | `make test`  |
| Formatierung schreiben                 | `pnpm format`                 | —            |
| Nur Typprüfung                         | `pnpm typecheck`              | —            |
| Datenbank starten / stoppen            | `pnpm db:up` / `pnpm db:down` | —            |
| Migrationen einspielen                 | `pnpm db:migrate`             | —            |
| Basisdaten anlegen                     | `pnpm db:seed`                | —            |

Einzelnen Workspace ansprechen:

```bash
pnpm --filter @gto/backend dev
pnpm --filter @gto/frontend build
pnpm --filter @gto/shared test
```

---

## 4. Lokaler Start

### Backend

```bash
pnpm --filter @gto/backend dev
```

Lauscht standardmäßig auf `0.0.0.0:3000`. Konfigurierbar über `PORT` und `HOST`.

Smoke-Test:

```bash
curl -s http://localhost:3000/healthz
# erwartet: {"status":"ok"}
```

### Frontend

```bash
pnpm --filter @gto/frontend dev
```

Vite-Dev-Server auf <http://localhost:5173>.

---

## 4a. Datenbank betreiben

Alle Kommandos laufen aus der Repo-Wurzel.

| Zweck                                    | Befehl             |
| ---------------------------------------- | ------------------ |
| Datenbank starten                        | `pnpm db:up`       |
| Datenbank stoppen                        | `pnpm db:down`     |
| Migration erzeugen (nach Schemaänderung) | `pnpm db:generate` |
| Migrationen einspielen                   | `pnpm db:migrate`  |
| Basisdaten anlegen (idempotent)          | `pnpm db:seed`     |
| Entwicklungs-DB zurücksetzen             | `pnpm db:reset`    |

### Erststart

```bash
pnpm db:up          # startet den Container gto-postgres
docker compose ps   # STATUS muss "Up (healthy)" zeigen
pnpm db:migrate     # erzeugt das Basisschema
pnpm db:seed        # legt die Basis-Konfigurationseinträge an
```

Prüfen, ob das Schema steht:

```bash
docker exec gto-postgres psql -U gto -d gto \
  -c "select table_name from information_schema.tables where table_schema='public' order by table_name;"
```

Erwartet: `config`, `job_queue`, `llm_call_log`, `session`, `user`.

### Stoppen und Daten löschen

```bash
pnpm db:down                       # Container stoppen, Volume bleibt
docker compose down -v             # zusätzlich das Volume gto-pgdata löschen
```

### Seed

`pnpm db:seed` ist **idempotent** — mehrfaches Ausführen erzeugt weder
Duplikate noch Fehler. Es legt die Basis-Konfigurationsschlüssel an und
optional einen initialen Benutzer, wenn in der `.env` **beide** Variablen
gesetzt sind:

```
SEED_USER_USERNAME=admin
SEED_USER_PASSWORD_HASH=<argon2-hash>
```

Es wird bewusst nur ein **fertiger Hash** akzeptiert, nie ein Klartextpasswort.
Das Erzeugen des Hashes und das Passwort-CLI kommen in **AP1.T1.3** — bis dahin
bleibt der Benutzer-Seed in der Regel ungenutzt.

### Reset (nur Entwicklung)

`pnpm db:reset` verwirft das **komplette Schema** und migriert neu. Es ist
doppelt abgesichert und bricht ab, wenn eine der Bedingungen nicht erfüllt ist:

1. `NODE_ENV` darf **nicht** `production` sein.
2. `DB_RESET_CONFIRM=yes` muss gesetzt sein.

```bash
NODE_ENV=development DB_RESET_CONFIRM=yes pnpm db:reset
```

---

## 4b. Zugang verwalten (Auth)

### Passwort setzen oder ändern

```bash
pnpm auth:set-password <benutzername>
```

Legt den Benutzer an, falls es ihn noch nicht gibt, sonst ändert es dessen
Passwort. Das Passwort wird **verdeckt abgefragt** (zweimal, zur Kontrolle).

Für Automatisierung lässt es sich über eine Umgebungsvariable übergeben:

```bash
NEW_PASSWORD='…' pnpm auth:set-password admin
```

> **Das Passwort wird niemals als Kommandozeilen-Argument angenommen.** Es
> stünde sonst in der Shell-History und in der Prozessliste. Wird
> `NEW_PASSWORD` benutzt, gehört die Variable nicht dauerhaft in die `.env`.

Regeln:

- Mindestlänge **12 Zeichen**, reine Leerzeichen werden abgelehnt.
- Nach jeder Änderung werden **alle bestehenden Sessions dieses Benutzers
  invalidiert** — wer angemeldet war, muss sich neu anmelden.

### Login von Hand prüfen

```bash
# 1. CSRF-Token holen (setzt zugleich das Cookie)
CSRF=$(curl -s -c /tmp/c.txt http://127.0.0.1:3010/api/auth/csrf | jq -r .csrfToken)

# 2. Anmelden
curl -i -b /tmp/c.txt -c /tmp/c.txt -X POST http://127.0.0.1:3010/api/auth/login \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"username":"admin","password":"…"}'

# 3. Geschützte Route
curl -b /tmp/c.txt http://127.0.0.1:3010/api/auth/me
```

### Konfiguration

| Variable                          | Default                   | Bedeutung                                            |
| --------------------------------- | ------------------------- | ---------------------------------------------------- |
| `SESSION_TTL_HOURS`               | `168`                     | Lebensdauer einer Session (7 Tage)                   |
| `COOKIE_SECURE`                   | `NODE_ENV==='production'` | `Secure`-Flag der Cookies                            |
| `COOKIE_SAMESITE`                 | `lax`                     | `lax` oder `strict`                                  |
| `ALLOWED_ORIGINS`                 | leer                      | Kommaliste erlaubter Herkünfte; leer = keine Prüfung |
| `LOGIN_RATE_LIMIT_MAX_ATTEMPTS`   | `5`                       | Erlaubte **Fehl**versuche je Fenster                 |
| `LOGIN_RATE_LIMIT_WINDOW_MINUTES` | `15`                      | Länge des Fensters                                   |
| `TOTP_ENABLED`                    | `false`                   | TOTP-Hook (in T1.3 nur vorbereitet)                  |

Das Rate-Limit zählt **nur fehlgeschlagene** Logins und wird nach einem
erfolgreichen Login zurückgesetzt. Der Zähler liegt im Prozessspeicher und ist
nach einem Neustart des Backends leer.

### Ausgesperrt? Sperre aufheben

Backend neu starten — das leert die Zähler. Alternativ das Zeitfenster
abwarten; der `Retry-After`-Header der 429-Antwort nennt die Sekunden.

### Alle Sessions invalidieren

```bash
docker exec gto-postgres psql -U gto -d gto -c "delete from session;"
```

Abgelaufene Sessions werden zusätzlich bei jedem Login mit aufgeräumt; ein
periodischer Lauf kommt mit der Job-Queue in AP2.

---

## 4c. Frontend lokal starten

```bash
pnpm --filter @gto/frontend dev
```

Der Dev-Server läuft auf **<http://localhost:5174>**. Vite bindet dabei auf
`localhost` (IPv6 `[::1]`) — `curl http://127.0.0.1:5174` schlägt fehl,
`curl http://localhost:5174` funktioniert.

| Variable            | Default                 | Bedeutung                                      |
| ------------------- | ----------------------- | ---------------------------------------------- |
| `FRONTEND_PORT`     | `5174`                  | Port des Dev-Servers                           |
| `BACKEND_URL`       | `http://127.0.0.1:3010` | Ziel des `/api`- und `/healthz`-Proxys         |
| `VITE_API_BASE_URL` | leer (gleiche Herkunft) | Nur nötig, wenn **ohne** Proxy gearbeitet wird |

### Warum ein Proxy und kein CORS

Der Dev-Server reicht `/api` und `/healthz` an das Backend weiter. Für den
Browser gibt es dadurch nur **eine** Herkunft: Session- und CSRF-Cookies
funktionieren ohne Sonderregeln, und es entspricht dem Zielbetrieb, in dem der
Host-Nginx dasselbe tut ([ADR-0015](./DECISIONS.md)).

### Beide Teile zusammen starten

```bash
# Terminal 1 — Datenbank und Backend
pnpm db:up
PORT=3010 pnpm --filter @gto/backend dev

# Terminal 2 — Frontend
BACKEND_URL=http://127.0.0.1:3010 pnpm --filter @gto/frontend dev
```

> **Ports auf diesem Host prüfen.** 3000, 3001, 5173, 5432, 55432 und 55433
> sind von fremden Diensten belegt. Vor dem Start:
> `ss -ltn | grep <port>`. Belegung ändert sich — die Ports sind deshalb
> überall über Variablen einstellbar und nirgends fest verdrahtet.

### Ersten Benutzer anlegen

Ohne Benutzer ist kein Login möglich (siehe Abschnitt 4b):

```bash
pnpm auth:set-password admin
```

### Typische Fehlerbilder

| Symptom                                            | Ursache                                                       | Abhilfe                                                         |
| -------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| Login meldet Erfolg, danach sofort wieder `/login` | Cookie kam nicht an — `COOKIE_SECURE=true` ohne HTTPS         | lokal `COOKIE_SECURE=false` setzen                              |
| Alle Requests scheitern mit `403 csrf_failed`      | Frontend läuft **ohne** Proxy direkt gegen einen anderen Port | Proxy nutzen (Default) oder `ALLOWED_ORIGINS` am Backend setzen |
| „Das Backend ist nicht erreichbar"                 | Backend läuft nicht oder `BACKEND_URL` zeigt woanders hin     | `curl http://127.0.0.1:3010/healthz` prüfen                     |
| CORS-Fehler in der Browser-Konsole                 | `VITE_API_BASE_URL` auf eine fremde Herkunft gesetzt          | Variable leeren und den Proxy verwenden                         |
| `curl http://127.0.0.1:5174` antwortet nicht       | Vite lauscht auf `[::1]`                                      | `http://localhost:5174` verwenden                               |
| Port belegt beim Start                             | fremder Dienst                                                | `FRONTEND_PORT` bzw. `PORT` auf einen freien Wert setzen        |
| Dunkler Modus bleibt trotz Systemeinstellung hell  | manuelle Wahl liegt in `localStorage`                         | im Browser `gto.theme` löschen oder den Umschalter benutzen     |

---

## 5. Tests

```bash
pnpm test
```

**Voraussetzung:** Der Postgres-Container muss laufen (`pnpm db:up`). Die
Backend-Tests enthalten Integrationstests gegen eine **echte** Datenbank —
nichts ist gemockt.

Läuft rekursiv über alle Workspaces mit Test-Script:

- `packages/shared` — Verträge und Type-Guards
- `apps/backend` — Routen via `app.inject()`, Konfigurations-Validierung und
  DB-Integrationstests
- `apps/frontend` — Komponenten- und Integrationstests (Vitest + Testing
  Library, jsdom). Das Netzwerk ist gemockt — **kein laufendes Backend nötig**

Die Testdatenbank (`TEST_DATABASE_URL`, Default `gto_test`) wird **automatisch**
angelegt, geleert und migriert — kein manueller Schritt nötig. Sie liegt auf
derselben Instanz wie die Entwicklungsdatenbank, aber in einer eigenen Datenbank,
damit Tests keine Entwicklungsdaten löschen.

Die Backend-Tests lösen `@gto/shared` per Vitest-Alias auf die Quellen auf;
`pnpm test` ist deshalb **nicht** von einem vorherigen `pnpm build` abhängig.

---

### 5.1 Smoke-E2E (Browser)

Ein einziger durchgehender Test: **Login → Dashboard**. Er startet Backend und
Frontend selbst — es ist keine manuelle Vorbereitung nötig.

```bash
# einmalig: Browser-Binary holen
pnpm test:e2e:install

# Lauf (Passwort kommt aus der Umgebung, nie aus dem Code)
E2E_PASSWORD='ein-langes-testpasswort' pnpm test:e2e
```

| Variable            | Default          | Bedeutung                               |
| ------------------- | ---------------- | --------------------------------------- |
| `E2E_USERNAME`      | `e2e-smoke-user` | Testbenutzer; wird automatisch angelegt |
| `E2E_PASSWORD`      | — (**Pflicht**)  | Passwort des Testbenutzers              |
| `E2E_DATABASE_URL`  | `DATABASE_URL`   | Datenbank für den Lauf                  |
| `E2E_BACKEND_PORT`  | `3020`           | Backend für den Testlauf                |
| `E2E_FRONTEND_PORT` | `5180`           | Frontend für den Testlauf               |

Die Ports sind bewusst andere als 3010 (laufendes Deployment) und 5174
(Dev-Server), damit ein E2E-Lauf nichts stört.

**Empfehlung lokal:** eine eigene Datenbank verwenden, damit der Testbenutzer
nicht in der Entwicklungsdatenbank landet:

```bash
docker exec gto-postgres psql -U gto -d postgres -c 'create database gto_e2e;'
E2E_DATABASE_URL='postgres://gto:<passwort>@127.0.0.1:55434/gto_e2e' \
E2E_PASSWORD='ein-langes-testpasswort' pnpm test:e2e
```

`e2e/global-setup.ts` migriert die Datenbank (`pnpm db:migrate`) und legt den
Benutzer über das Passwort-CLI aus T1.3 an — dieselben Werkzeuge wie im
Normalbetrieb, kein Sonderweg.

### 5.2 Qualitätsschranke (CI)

`.github/workflows/ci.yml` läuft bei **Push auf `main`** und bei **Pull
Requests**:

| Job       | Schritte                                            |
| --------- | --------------------------------------------------- |
| `quality` | install → **lint** → migrate → **test** → **build** |
| `e2e`     | Chromium installieren → Smoke-E2E                   |

Beide Jobs bekommen einen `postgres:16-alpine`-Service-Container, weil die
Integrationstests gegen eine echte Datenbank laufen. Die dort gesetzten
Zugangsdaten sind reine Wegwerf-Testwerte; im Repository liegen keine
Produktions-Secrets.

Lokal lässt sich dieselbe Kette nachstellen:

```bash
pnpm install && pnpm lint && pnpm test && pnpm build
```

---

## 6. Build-Artefakte

| Workspace         | Ausgabe                                  | Erzeugt von  |
| ----------------- | ---------------------------------------- | ------------ |
| `packages/shared` | `packages/shared/dist/` (JS + `.d.ts`)   | `tsc -b`     |
| `apps/backend`    | `apps/backend/dist/` (JS + `.d.ts`)      | `tsc -b`     |
| `apps/frontend`   | `apps/frontend/dist/` (statische Assets) | `vite build` |

Backend produktiv starten (nach `pnpm build`):

```bash
node apps/backend/dist/server.js
```

---

## 7. Fehlerbehebung

| Symptom                                                                               | Ursache                                                                          | Abhilfe                                                                                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `devDependencies: skipped because NODE_ENV is set to production`                      | `NODE_ENV=production` in der Shell                                               | `NODE_ENV=development pnpm install`                                                                             |
| `Cannot find module '@gto/shared'`                                                    | Workspace-Links fehlen oder `dist` nicht gebaut                                  | `pnpm install && pnpm build`                                                                                    |
| `tsc` meldet Fehler in `dist/`                                                        | veraltete Build-Info                                                             | `rm -rf **/dist **/*.tsbuildinfo && pnpm build`                                                                 |
| `make: command not found`                                                             | GNU Make nicht installiert                                                       | die `pnpm`-Kommandos direkt verwenden                                                                           |
| Port belegt beim Backend-Start                                                        | 3000 und 3001 sind auf diesem Host fremd belegt                                  | freien Port wählen, z. B. `PORT=3010 pnpm --filter @gto/backend dev`                                            |
| `all predefined address pools have been fully subnetted`                              | Dockers Standard-Subnetze sind auf dem Host durch fremde Projekte belegt         | `DOCKER_SUBNET` in der `.env` auf ein freies Subnetz setzen (ADR-0006); **nicht** fremde Netzwerke löschen      |
| `bind: address already in use` bei `pnpm db:up`                                       | `POSTGRES_HOST_PORT` ist belegt                                                  | freien Port suchen (`ss -ltn`), dann `POSTGRES_HOST_PORT` **und** beide Verbindungs-URLs in der `.env` anpassen |
| `DATABASE_URL enthaelt noch den Platzhalter aus .env.example`                         | `.env` kopiert, aber nicht bearbeitet                                            | Platzhalter an allen drei Stellen durch dasselbe Passwort ersetzen                                              |
| `Pflicht-Umgebungsvariable DATABASE_URL fehlt oder ist leer`                          | keine `.env` vorhanden                                                           | `cp .env.example .env` und ausfüllen                                                                            |
| `Postgres ist nicht erreichbar` beim Testlauf                                         | Container läuft nicht                                                            | `pnpm db:up`, danach `docker compose ps` prüfen                                                                 |
| `db:reset ist blockiert: NODE_ENV=production`                                         | `NODE_ENV` steht auf diesem Host oft auf `production`                            | bewusst so — nur mit `NODE_ENV=development` ausführen                                                           |
| `db:reset ist blockiert: Bestaetigung fehlt`                                          | Schutz gegen versehentliches Löschen                                             | `DB_RESET_CONFIRM=yes` setzen                                                                                   |
| `password authentication failed`                                                      | `.env`-Passwort geändert, Volume hat noch das alte                               | `docker compose down -v` (löscht die Daten) und neu aufsetzen                                                   |
| Login liefert 200, aber der nächste Request ist 401 — **Cookie kommt lokal nicht an** | `COOKIE_SECURE=true` ohne HTTPS: der Browser verwirft das Cookie stillschweigend | lokal `COOKIE_SECURE=false` setzen                                                                              |
| Jeder POST antwortet `403 csrf_failed`                                                | Header `x-csrf-token` fehlt oder passt nicht zum Cookie `gto_csrf`               | zuerst `GET /api/auth/csrf`, Wert spiegeln; Requests mit `credentials: 'include'` senden                        |
| `403 csrf_failed` trotz korrektem Token                                               | `ALLOWED_ORIGINS` gesetzt, aufrufende Herkunft fehlt darin                       | Herkunft ergänzen oder Variable leeren                                                                          |
| Login antwortet `429 rate_limited`                                                    | zu viele Fehlversuche für `IP\|benutzername`                                     | `Retry-After` abwarten oder Backend neu starten                                                                 |
| Login scheitert trotz korrektem Passwort bei `TOTP_ENABLED=true`                      | der TOTP-Hook ist bewusst noch nicht implementiert und lehnt dann ab             | `TOTP_ENABLED=false` setzen                                                                                     |
| `Das Passwort muss mindestens 12 Zeichen lang sein`                                   | Passwort-Richtlinie                                                              | längeres Passwort wählen                                                                                        |

Kompletter Neuaufbau:

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules
rm -rf apps/*/dist packages/*/dist
pnpm install && pnpm build
```

---

## 8. Deployment auf dem Server

### 8.1 Überblick

| Bestandteil        | Läuft als                        | Wer richtet ein       |
| ------------------ | -------------------------------- | --------------------- |
| Postgres, Backend  | Docker-Compose-Container         | `deploy/deploy.sh`    |
| Frontend           | statische Dateien im Dateisystem | `deploy/deploy.sh`    |
| Reverse Proxy, TLS | Host-Nginx + Certbot             | **einmalig als root** |

### 8.2 Voraussetzungen (einmalig)

```bash
cp .env.example .env      # danach ausfüllen, siehe Abschnitt 2
```

Mindestens setzen: `POSTGRES_PASSWORD`, `DATABASE_URL`, `BACKEND_HOST_PORT`,
`POSTGRES_HOST_PORT`, `FRONTEND_STATIC_DIR`, `BACKUP_DIR`.
Für den TLS-Betrieb zusätzlich:

```
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://gto.growento.com
```

Vor dem ersten Start prüfen, dass die gewählten Ports frei sind:

```bash
ss -ltn | grep -E ':(3010|55434)' || echo "beide frei"
```

### 8.3 Deployen

```bash
./deploy/deploy.sh              # mit git pull
./deploy/deploy.sh --no-pull    # ohne git pull
```

Das Skript ist **idempotent** und bricht bei jedem Fehler mit Exit-Code ≠ 0 ab.
Ablauf: Sourcen → Images bauen → Datenbank hochfahren → **Migrationen als
eigener Schritt** ([ADR-0017](./DECISIONS.md)) → Backend neu starten → Assets
veröffentlichen → Healthcheck.

Danach prüfen:

```bash
docker compose ps
./deploy/smoke-check.sh
```

### 8.4 Host-Nginx-vhost einspielen (einmalig, **als root**)

> Diese Schritte brauchen Root-Rechte auf dem Host. Sie sind **nicht** Teil
> von `deploy.sh`, damit ein normaler Deploy keine Root-Rechte benötigt.

```bash
# 1. vhost kopieren
sudo cp /home/phillip/gto/deploy/nginx/gto.growento.com.conf \
        /etc/nginx/sites-available/gto.growento.com.conf

# 2. aktivieren
sudo ln -sfn /etc/nginx/sites-available/gto.growento.com.conf \
             /etc/nginx/sites-enabled/gto.growento.com.conf

# 3. Nginx-Worker muss die Assets lesen dürfen
sudo chmod o+x /home/phillip
sudo chmod -R a+rX /home/phillip/gto-static

# 4. testen und übernehmen
sudo nginx -t
sudo systemctl reload nginx

# 5. verifizieren
curl -i http://gto.growento.com/healthz
ls -l /etc/nginx/sites-enabled/ | grep gto
```

Passen `BACKEND_HOST_PORT` oder `FRONTEND_STATIC_DIR` nicht zu den Defaults,
müssen `upstream gto_backend` bzw. `root` in der vhost-Datei angepasst werden.

### 8.5 TLS mit Certbot (Stufe B, **als root**)

Voraussetzung: Der A-Record der Domain zeigt auf die Server-IP.

```bash
# Vorher prüfen — beide Ausgaben müssen übereinstimmen:
dig +short gto.growento.com
curl -s -4 https://ifconfig.me; echo

# Zertifikat ausstellen; certbot ergänzt HTTPS-Block und Redirect selbst
sudo certbot --nginx -d gto.growento.com --redirect

# Ergebnis prüfen
curl -I http://gto.growento.com/          # erwartet: 301 nach https
curl -I https://gto.growento.com/healthz  # erwartet: 200
sudo certbot renew --dry-run              # automatische Erneuerung
```

Nach der Umstellung in der `.env` setzen und neu deployen, damit das
Session-Cookie das `Secure`-Flag trägt:

```
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://gto.growento.com
```

```bash
./deploy/deploy.sh --no-pull
```

> **Zertifikat nie „auf Verdacht" anfordern.** Zeigt die DNS noch nicht auf den
> Server, schlägt die Anfrage fehl und zählt auf das Let's-Encrypt-Limit.

### 8.6 Sicherung

```bash
./deploy/backup.sh
```

Erzeugt in `BACKUP_DIR` (Default `~/gto-backups`, **außerhalb des Repos**):

- `gto-db-<zeitstempel>.sql.gz` — `pg_dump --clean --if-exists`
- `gto-data-<zeitstempel>.tar.gz` — Inhalt von `data/`

Es werden `BACKUP_KEEP` (Default 14) Sicherungen je Typ aufgehoben, ältere
gelöscht. Für den regelmäßigen Lauf genügt ein Cron-Eintrag:

```bash
crontab -e
# täglich 03:30
30 3 * * * ./deploy/backup.sh >> /home/phillip/gto-backups/backup.log 2>&1
```

### 8.7 Wiederherstellung

**Prüflauf** (empfohlen; die produktive Datenbank bleibt unberührt):

```bash
./deploy/restore.sh ~/gto-backups/gto-db-<zeitstempel>.sql.gz
```

Das Skript legt die separate Datenbank `gto_restore_check` an, spielt den Dump
ein und prüft Tabellen und Zeilenzahlen. Weniger als fünf Tabellen ⇒ Abbruch
mit Exit-Code ≠ 0.

**Ernstfall** (überschreibt die produktive Datenbank):

```bash
docker compose stop backend
RESTORE_CONFIRM=yes ./deploy/restore.sh ~/gto-backups/gto-db-<zeitstempel>.sql.gz gto
docker compose start backend
./deploy/smoke-check.sh
```

Prüfdatenbank hinterher entfernen:

```bash
docker exec gto-postgres psql -U gto -d postgres -c 'drop database "gto_restore_check";'
```

### 8.8 Restore-Protokoll (durchgeführt am 2026-08-23)

Der Prüflauf wurde tatsächlich ausgeführt, nicht nur beschrieben:

```
$ ./deploy/backup.sh
[backup] Sichere Datenbank 'gto' nach /home/phillip/gto-backups/gto-db-20260823-201652.sql.gz ...
[backup] Sichere data/ nach /home/phillip/gto-backups/gto-data-20260823-201652.tar.gz ...
-rw-r--r-- 1 phillip phillip 1,2K gto-data-20260823-201652.tar.gz
-rw-r--r-- 1 phillip phillip 2,4K gto-db-20260823-201652.sql.gz
[backup] ERFOLGREICH: Sicherung abgeschlossen.

$ ./deploy/restore.sh /home/phillip/gto-backups/gto-db-20260823-201652.sql.gz
[restore] Ziel-Datenbank: gto_restore_check
[restore] Spiele Dump ein ...
--- Tabellen in gto_restore_check ---
config
job_queue
llm_call_log
session
user
--- Zeilenzahlen ---
config=4 user=1 session=1 job_queue=0 llm_call_log=0
[restore] ERFOLGREICH: Wiederherstellung geprueft (5 Tabellen).
```

Die produktive Datenbank war vorher und nachher unverändert
(`config=4 user=1`).

### 8.9 Fehlerbehebung im Betrieb

| Symptom                                                                  | Ursache                                                      | Abhilfe                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `docker compose` meldet `BACKEND_HOST_PORT fehlt`                        | Variable nicht in der `.env`                                 | aus `.env.example` übernehmen                                                 |
| `bind: address already in use`                                           | gewählter Host-Port inzwischen fremd belegt                  | freien Port suchen (`ss -ltn`), `.env` **und** `upstream` im vhost anpassen   |
| Backend bleibt `health: starting`                                        | Datenbank nicht erreichbar oder Migration fehlt              | `docker compose logs backend`, dann `./deploy/deploy.sh --no-pull`            |
| Login gelingt, Folge-Request ist 401 — **Cookie fehlt hinter dem Proxy** | `COOKIE_SECURE=true`, aber Zugriff über **http** statt https | entweder TLS aktivieren oder für HTTP-Betrieb `COOKIE_SECURE=false` setzen    |
| Alle POSTs `403 csrf_failed`                                             | `ALLOWED_ORIGINS` gesetzt, aber Aufruf-Origin fehlt darin    | Origin ergänzen (`https://gto.growento.com`) oder Variable leeren             |
| Nginx liefert `403 Forbidden` für `/`                                    | www-data darf `FRONTEND_STATIC_DIR` nicht lesen              | `sudo chmod o+x /home/phillip && sudo chmod -R a+rX /home/phillip/gto-static` |
| Direktaufruf `/drills` liefert 404                                       | SPA-Fallback fehlt im vhost                                  | `try_files $uri $uri/ /index.html;` im `location /`-Block prüfen              |
| `pnpm`-Befehle installieren keine devDependencies                        | `NODE_ENV=production` in der Shell                           | `NODE_ENV=development pnpm install`; die Dockerfiles setzen das selbst        |
| `certbot` schlägt fehl                                                   | DNS zeigt nicht auf den Server                               | erst `dig +short gto.growento.com` prüfen, sonst nicht anfordern              |
| Deploy meldet Erfolg, App ist alt                                        | Browser-Cache auf `index.html`                               | vhost setzt `Cache-Control: no-cache` für `index.html` — hart neu laden       |

---

## 9. LLM-Gateway (AP2)

### 9.1 Voraussetzung: Profil B

Das Projekt nutzt **ausschließlich** das Claude-CLI-Profil B unter
`/home/phillip/.claude-b`. Das Default-Profil `/home/phillip/.claude` wird nie
angefasst, und es gibt keinen Rückfall darauf.

Prüfen, ob Profil B eingeloggt ist:

```bash
CLAUDE_CONFIG_DIR=/home/phillip/.claude-b claude -p "Antworte nur mit OK"
# erwartet: OK, Exit-Code 0, keine Login-Aufforderung
```

Kommt `Not logged in · Please run /login`, muss der Login **einmalig
interaktiv** nachgeholt werden:

```bash
CLAUDE_CONFIG_DIR=/home/phillip/.claude-b claude   # dann /login
```

Empfehlung aus `docs/ap/AP02.md`: `chmod 700 /home/phillip/.claude-b` — das
Verzeichnis ist aktuell weltlesbar.

### 9.2 Host-Runner starten

Das Backend läuft im Container, die CLI auf dem Host. Die Brücke ist ein
Host-Prozess mit Unix-Domain-Socket ([ADR-0022](./DECISIONS.md)):

```bash
cd /home/phillip/gto
pnpm llm:runner
# [llm-runner] bereit auf /home/phillip/gto-llm-runner/gto-llm.sock (Profil /home/phillip/.claude-b, CLI claude)
```

Im Hintergrund, mit Protokoll:

```bash
nohup pnpm llm:runner > /home/phillip/gto-llm-runner/runner.log 2>&1 &
```

Der Runner läuft als Benutzer `phillip`, **nicht** als root, und legt den
Socket mit Mode `0600` an. Er ist der einzige Prozess, der Profil B kennt.

> **Offen:** Nach einem Reboot startet der Runner nicht von selbst. Ein
> root-freier Weg wäre ein `@reboot`-Eintrag in der Benutzer-Crontab
> (`crontab -e`, `cron` läuft auf dem Host); das ist noch nicht eingerichtet
> und nicht verifiziert. Bis dahin: nach jedem Neustart von Hand starten.

### 9.3 Testaufruf von Hand

**Lokal, ohne Container** (`LLM_TRANSPORT=direct`):

```bash
LLM_LIVE_SMOKE=true LLM_MODEL=claude-haiku-4-5 \
  pnpm --filter @gto/backend exec vitest run test/llm/live-smoke.test.ts
```

Ohne `LLM_LIVE_SMOKE=true` wird der Test übersprungen — in der CI ist die
Variable nicht gesetzt, damit kein Lauf Subscription-Kontingent verbraucht.

**Aus dem laufenden Container** (prüft zugleich den Runner und das Mount):

```bash
docker exec gto-backend node -e '
import("/app/dist/llm/index.js").then(async ({ createClaudeCliProvider }) => {
  const { loadLlmConfig } = await import("/app/dist/config/env.js");
  const res = await createClaudeCliProvider(loadLlmConfig()).complete({
    system: "Antworte mit genau einem Wort.",
    messages: [{ role: "user", content: [{ type: "text", text: "Antworte nur mit OK" }] }],
    model: "claude-haiku-4-5", maxTokens: 1024, timeoutMs: 120000,
  });
  console.log(JSON.stringify({ text: res.text, meta: res.meta }));
}).catch((e) => { console.error("FEHLER:", e.kind, e.message); process.exit(1); });'
```

### 9.4 Provider umschalten per SQL (Notweg)

Welcher Adapter arbeitet, steht in der `config`-Tabelle unter `llm.provider`.
Die Umschaltung wirkt **ab dem nächsten Aufruf** — kein Neustart, keine
Codeänderung. Der vorgesehene Weg ist seit T2.6 die Oberfläche
(Abschnitt 10.5); der folgende SQL-Weg ist der Notweg, wenn sie nicht
erreichbar ist:

```bash
# aktuellen Wert ansehen
docker exec gto-postgres psql -U gto -d gto -c \
  "select key, value from config where key = 'llm.provider';"

# auf den API-Fallback umschalten
docker exec gto-postgres psql -U gto -d gto -c \
  "insert into config (key, value) values ('llm.provider', '\"api\"'::jsonb)
   on conflict (key) do update set value = excluded.value, updated_at = now();"

# zurück auf die Subscription
docker exec gto-postgres psql -U gto -d gto -c \
  "update config set value = '\"cli\"'::jsonb, updated_at = now() where key = 'llm.provider';"
```

Steht dort `null` oder gar nichts, gilt `LLM_PROVIDER` aus der `.env`, sonst
`cli`. Ein anderer Wert als `cli`/`api` führt zu einer klaren Fehlermeldung —
nicht zu einem stillen Rückfall.

### 9.5 API-Schlüssel eintragen

Der Schlüssel wird **nur** gebraucht, wenn `api` der aktive Provider ist. Ohne
ihn läuft das Backend mit `cli` ganz normal weiter.

```bash
# in der git-ignorierten .env (NIE im Repository):
ANTHROPIC_API_KEY=sk-ant-...
```

Danach den Backend-Container neu starten, damit er die Variable sieht:

```bash
docker compose up -d backend
```

Der Schlüssel wird nirgends ausgegeben — weder in Logs noch in
Fehlermeldungen, auch nicht gekürzt.

### 9.6 Live-Smoke ausführen

```bash
cd /home/phillip/gto
LLM_LIVE_SMOKE=true pnpm --filter @gto/backend exec vitest run test/llm/live-smoke.test.ts
```

Ohne `LLM_LIVE_SMOKE=true` werden beide Blöcke übersprungen (so auch in der
CI). Ist kein `ANTHROPIC_API_KEY` gesetzt, wird der API-Teil **übersprungen,
nicht bestanden**, mit der Meldung
`[live-smoke api] UEBERSPRUNGEN: kein ANTHROPIC_API_KEY gesetzt.` samt
Nachhol-Kommando. Jeder Lauf verbraucht Kontingent bzw. Guthaben — deshalb
sparsam und mit `LLM_SMOKE_MODEL=claude-haiku-4-5`.

### 9.7 Typische Fehlerbilder

| Meldung / Symptom                                                      | Ursache                                         | Abhilfe                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `CLAUDE_CONFIG_DIR fehlt oder ist leer`                                | Pflichtvariable nicht gesetzt                   | `.env` aus `.env.example` ergänzen; **kein** Default-Profil verwenden      |
| `Not logged in · Please run /login` (Kategorie `auth`)                 | Profil B nicht eingeloggt oder Token abgelaufen | Abschnitt 9.1                                                              |
| `You've hit your session limit · resets …` (Kategorie `rate_limit`)    | Subscription-Kontingent erschöpft               | bis zur genannten Uhrzeit warten; `LLM_MAX_CONCURRENCY` senken             |
| `Die Claude CLI wurde nicht gefunden` (Kategorie `auth`)               | CLI fehlt oder falscher `LLM_CLI_PATH`          | im Container erwartet: `LLM_TRANSPORT=socket` — die CLI liegt auf dem Host |
| `Der CLI-Runner ist unter … nicht erreichbar` (Kategorie `auth`)       | Host-Runner läuft nicht                         | Abschnitt 9.2                                                              |
| `hat nicht innerhalb des Zeitlimits geantwortet` (Kategorie `timeout`) | Aufruf zu langsam                               | `LLM_TIMEOUT_MS` erhöhen; Vision-Aufrufe brauchen länger als Textaufrufe   |
| `exceeded the N output token maximum` (Kategorie `invalid`)            | `maxTokens` zu klein — die CLI kürzt nicht      | `maxTokens` im Request erhöhen                                             |
| `Die Antwort verletzt das angeforderte Schema` (Kategorie `parse`)     | Antwort passt nicht zum `jsonSchema`            | Schema oder Prompt schärfen; wird bewusst **nicht** wiederholt             |

Fehlerbilder des API-Adapters (Adapter B):

| Meldung / Symptom                                                          | Ursache                                                                                 | Abhilfe                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY fehlt oder ist leer` (Kategorie `auth`)                 | API-Provider aktiv, kein Schlüssel                                                      | Abschnitt 9.5 — oder `llm.provider` auf `cli` zurückstellen (9.4)                   |
| `Anthropic-API hat die Anmeldung abgelehnt (401)` (Kategorie `auth`)       | Schlüssel ungültig oder widerrufen                                                      | neuen Schlüssel in der Console erzeugen                                             |
| `Kontingent erschoepft (429)` (Kategorie `rate_limit`)                     | Rate-Limit oder Guthaben erschöpft                                                      | Der Adapter übernimmt den `retry-after`-Hinweis; sonst `LLM_MAX_CONCURRENCY` senken |
| `Endpunkt oder Modell unbekannt (404)` (Kategorie `invalid`)               | falsche Modell-ID in `LLM_MODEL`                                                        | gültige ID eintragen, z. B. `claude-sonnet-5`                                       |
| `hat die Anfrage abgelehnt (400)` mit Schema-Hinweis (Kategorie `invalid`) | Das JSON-Schema nutzt nicht unterstützte Schlüsselwörter (`minimum`, `$ref`, Rekursion) | Schema vereinfachen (siehe ADR-0024, „Bekannte Grenze")                             |
| `voruebergehend gestoert (5xx)` (Kategorie `transient`)                    | Anthropic-seitige Störung                                                               | wird automatisch wiederholt; hält es an, auf `cli` umschalten (9.4)                 |

Laufendes Protokoll des Runners: `tail -f /home/phillip/gto-llm-runner/runner.log`.

### 9.8 Prompt-Templates: Golden-Dateien aktualisieren

Prompts liegen unter `apps/backend/prompts/`. Jede Änderung an einem Template
macht den zugehörigen Golden-Test rot — das ist beabsichtigt.

```bash
cd /home/phillip/gto

# 1. Template ändern, dann sehen, was sich am gerenderten Prompt ändert:
pnpm --filter @gto/backend exec vitest run test/prompts/golden.test.ts

# 2. Diff prüfen. Erst wenn er der Absicht entspricht:
pnpm prompts:golden

# 3. Die geänderten Dateien unter apps/backend/test/prompts/golden/ mit committen.
git diff apps/backend/test/prompts/golden/
```

**Nie** Schritt 2 ausführen, nur um einen roten Test grün zu bekommen — der
Golden-Test ist die einzige Stelle, an der eine ungewollte Prompt-Änderung
auffällt. In der CI ist `UPDATE_GOLDEN` gesperrt: Die Testdatei bricht ab,
wenn beides zusammentrifft.

Wird ein Template inhaltlich geändert, gehört die `version` in den Kopfdaten
erhöht.

### 9.9 Typische Fehlerbilder beim Rendern

Alle Meldungen kommen als `TemplateError` und nennen Template und Datei.

| Meldung                                                       | Ursache                                              | Abhilfe                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `Es fehlen Werte fuer die Platzhalter "x"`                    | Aufruf übergibt einen deklarierten Platzhalter nicht | Wert ergänzen — es gibt bewusst keinen leeren Rückfall            |
| `Unbekannte Platzhalter "x" uebergeben`                       | Tippfehler im Namen oder Wert zu viel                | Namen gegen `placeholders` im Template abgleichen                 |
| `verwendet die Platzhalter "x", deklariert sie aber nicht`    | `{{x}}` im Rumpf fehlt in den Kopfdaten              | in `placeholders` eintragen (auch die aus eingebundenen Partials) |
| `deklariert die Platzhalter "x", verwendet sie aber nirgends` | Platzhalter aus dem Rumpf entfernt, Kopfdaten nicht  | aus `placeholders` streichen                                      |
| `Doppelte Template-Kennung "…"`                               | zwei Dateien mit derselben `id`                      | eine umbenennen; die Kennung spiegelt den Pfad                    |
| `Unbekanntes Template "…"`                                    | Tippfehler beim Abruf oder Datei fehlt im Image      | `PROMPTS_DIR` prüfen (im Container `/app/prompts`)                |
| `bindet das unbekannte Partial "…" ein`                       | `{{> id}}` zeigt ins Leere                           | Kennung prüfen                                                    |
| `Partial-Zyklus erkannt: a -> b -> a`                         | Bausteine binden sich gegenseitig ein                | Verschachtelung auflösen                                          |
| `Kopfdaten fehlen` / `kein gueltiges JSON`                    | `---`-Block fehlt oder JSON ist kaputt               | Kopfdaten reparieren; Komma und Anführungszeichen prüfen          |
| `Template-Verzeichnis "…" ist nicht lesbar`                   | `PROMPTS_DIR` falsch oder Verzeichnis nicht im Image | Compose-Variable und `Dockerfile`-Kopie prüfen                    |

Templates im laufenden Container zählen:

```bash
docker exec gto-backend node -e '
import("/app/dist/prompts/index.js").then(({ TemplateRegistry }) =>
  console.log(TemplateRegistry.load().ids()));'
```

## 10. Job-Worker, Einstellungen und Aufruf-Protokoll (AP2.T2.5/T2.6)

### 10.1 Worker starten, stoppen, beobachten

Der Worker läuft **im Backend-Prozess** ([ADR-0026](./DECISIONS.md)) — es gibt
keinen eigenen Dienst zu starten.

```bash
# Start/Stopp = Start/Stopp des Backends
docker compose up -d backend
docker compose stop backend

# Läuft er?
docker logs gto-backend 2>&1 | grep "Job-Worker"
# → {"msg":"Job-Worker gestartet."}

# Was tut er gerade?
docker logs -f gto-backend 2>&1 | grep -i "job "
```

Abschalten ohne das Backend zu stoppen: `WORKER_ENABLED=false` in der `.env`,
dann `docker compose up -d backend`. Im Log steht dann
`Job-Worker ist per WORKER_ENABLED=false abgeschaltet.`

Queue-Überblick:

```bash
docker exec gto-postgres psql -U gto -d gto -c \
  "select status, count(*) from job_queue group by status;"

docker exec gto-postgres psql -U gto -d gto -c \
  "select left(id::text,8) as id, job_type, status, attempts||'/'||max_attempts as versuche,
          available_at, left(coalesce(last_error,'-'),60) as fehler
     from job_queue order by created_at desc limit 10;"
```

### 10.2 Einen Job von Hand einplanen

```bash
cd /home/phillip/gto

# Referenz-Job: Template plus Platzhalterwerte
pnpm jobs:enqueue task/concept-explanation \
  '{"level":"Einsteiger","concept":"Position am Tisch","context":"…"}'

# Mit vollem Payload (Modell, Token- und Zeitgrenze steuerbar)
pnpm jobs:enqueue --type llm.complete \
  '{"templateId":"task/concept-explanation",
    "values":{"level":"…","concept":"…","context":"…"},
    "model":"claude-haiku-4-5","maxTokens":4096,"timeoutMs":110000}'
```

Der Worker im Container zieht den Job innerhalb von `WORKER_POLL_INTERVAL_MS`
(Default 2 s). Voraussetzung bei aktivem CLI-Provider: Der Host-Runner läuft
(Abschnitt 9.2).

### 10.3 Dead-Letter-Jobs erneut einplanen

```bash
# Welche liegen tot?
docker exec gto-postgres psql -U gto -d gto -c \
  "select left(id::text,8) as id, job_type, attempts, left(last_error,100) as fehler
     from job_queue where status = 'dead' order by finished_at desc;"
```

Erst die Ursache beheben (Meldung in `last_error`), dann erneut einplanen —
über den Endpunkt, angemeldet:

```bash
curl -sS -X POST "https://gto.growento.com/api/jobs/<job-id>/retry" \
  -H "x-csrf-token: $CSRF" -b "gto_session=$SESSION; gto_csrf=$CSRF"
# → {"jobId":"…","status":"queued","attempts":0}
```

Ohne laufenden vhost geht es direkt per SQL:

```bash
docker exec gto-postgres psql -U gto -d gto -c \
  "update job_queue set status='queued', attempts=0, available_at=now(),
          claimed_at=null, finished_at=null
     where id='<job-id>' and status='dead';"
```

`attempts` wird dabei zurückgesetzt — sonst wäre der Job nach einem Versuch
sofort wieder tot.

### 10.4 SSE hinter dem Host-Nginx

Der Statuskanal `GET /api/jobs/events` ist ein offen bleibender Strom. Der
vhost im Repo hat dafür eine eigene `location` mit `proxy_buffering off`
(`deploy/nginx/gto.growento.com.conf`).

> **Root-Schritt für den Nutzer:** Der vhost ist seit AP1 ohnehin nicht
> eingespielt. Wer ihn einspielt (Abschnitt 8.4), bekommt die SSE-Sektion
> automatisch mit. Ist er bereits installiert, muss die **aktualisierte** Datei
> neu kopiert und Nginx neu geladen werden — sonst puffert Nginx den Strom und
> im Browser kommt nichts an, bis der Server die Verbindung schließt.

| Fehlerbild                                                 | Ursache                              | Abhilfe                                                   |
| ---------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| Statuszeile aktualisiert sich nie, Verbindung bleibt offen | Nginx puffert                        | SSE-`location` aus dem Repo einspielen, `nginx -s reload` |
| Verbindung bricht nach ~60 s ab                            | `proxy_read_timeout` zu kurz         | Wert der SSE-`location` (3600s) übernehmen                |
| 401 beim Verbinden                                         | keine Session                        | neu anmelden — die Route ist auth-geschützt               |
| „Es sind bereits 50 Statuskanaele offen"                   | Verbindungen wurden nicht abgemeldet | Backend neu starten; im Frontend die Abmeldung prüfen     |

Ohne Nginx direkt gegen den Container testen:

```bash
curl -N -H "Cookie: gto_session=$SESSION" http://127.0.0.1:3010/api/jobs/events
# → ": verbunden" und danach "event: job" je Statusaenderung
```

### 10.5 Provider und Modell umschalten (Oberfläche)

Seit T2.6 ist das der vorgesehene Weg — **Einstellungen → Provider und Modell**:

- Provider (CLI/API), Modell, Timeout, gleichzeitige Aufrufe, Versuche.
- **Speichern** wirkt ab dem nächsten Aufruf, ohne Neustart.
- Ungültige Werte lehnt der Server ab und markiert das betroffene Feld.
- **Testaufruf ausführen** setzt einen echten, minimalen Aufruf ab und zeigt
  Provider, Modell, Dauer und die Antwort — im Fehlerfall die Kategorie und
  einen Hinweis, was zu tun ist. Der Aufruf kostet echtes Kontingent; zwischen
  zwei Tests liegen mindestens zehn Sekunden.

Der SQL-Weg aus Abschnitt 9.4 bleibt gültig, ist aber nur noch nötig, wenn die
Oberfläche nicht erreichbar ist. Was tatsächlich gilt, zeigt:

```bash
docker exec gto-postgres psql -U gto -d gto -c \
  "select key, value from config where key like 'llm.%' order by key;"
```

Steht dort nichts, gilt die `.env` (`LLM_PROVIDER`, `LLM_MODEL`, …). Ein
unbrauchbarer Wert in der Tabelle wird ignoriert und die Oberfläche weist das
Feld als „Default" aus.

### 10.6 Aufruf-Protokoll ansehen und aufräumen

In der Oberfläche: **Einstellungen → Letzte KI-Aufrufe**, mit Statusfilter und
Detailansicht für Prompt und Antwort.

Auf der Kommandozeile:

```bash
docker exec gto-postgres psql -U gto -d gto -c \
  "select left(id::text,8) as id, provider, model, status, duration_ms, total_tokens, created_at
     from llm_call_log order by created_at desc limit 10;"

# Wie groß ist die Tabelle inzwischen?
docker exec gto-postgres psql -U gto -d gto -c \
  "select count(*) as eintraege, pg_size_pretty(pg_total_relation_size('llm_call_log')) as groesse
     from llm_call_log;"
```

Prompt und Antwort sind auf `LLM_LOG_MAX_CHARS` (Default 20 000 Zeichen)
gekürzt, Bilder stehen nie im Klartext darin ([ADR-0028](./DECISIONS.md)). Bei
Bedarf aufräumen — **vorher sichern**, das Protokoll ist die Grundlage jeder
Fehlersuche:

```bash
# Alles aelter als 30 Tage entfernen
docker exec gto-postgres psql -U gto -d gto -c \
  "delete from llm_call_log where created_at < now() - interval '30 days';"

# Erledigte Jobs aufraeumen (Dead-Letter bewusst NICHT)
docker exec gto-postgres psql -U gto -d gto -c \
  "delete from job_queue where status = 'done' and finished_at < now() - interval '30 days';"
```

## 11. Buchimport (AP3.T3.1)

### 11.1 Voraussetzung: die Buchquellen liegen bereit

`data/book-source/` ist git-ignorierter **Pflicht-Input des Nutzers**. Kein
Agent und kein Skript legt die Dateien an.

```bash
ls data/book-source/
# erwartet: die Buch-Markdown-Datei (*.md) und die Bilder pXXXX_YY.jpeg
# Die Bilder duerfen flach liegen ODER in genau einem Unterverzeichnis.
```

Fehlt etwas, bricht der Import **vor jeder Verarbeitung** ab und sagt, was:

```
[book:import] Abbruch - Vorbedingung nicht erfuellt.
Buchquellen-Verzeichnis fehlt: /home/phillip/gto/data/book-source existiert nicht. …
Buchquellen-Verzeichnis ist leer: … enthaelt ausser der README nichts. …
Buch-Markdown fehlt: in … liegt keine *.md-Datei (ausser der README). …
Bilddateien fehlen: weder in … noch in einem Unterverzeichnis liegen Bilder …
```

Was tun: die Quellen nach `data/book-source/` legen (Struktur siehe
`data/book-source/README.md` und INTERFACES Abschnitt 5), dann erneut starten.
Es gibt bewusst keinen Fallback und keine Beispieldaten.

### 11.2 Trockenlauf — analysieren, ohne zu schreiben

```bash
pnpm book:import --dry-run
```

Braucht **keine** laufende Datenbank. Liest die Quellen, zerlegt sie, schreibt
den Report und rührt Postgres nicht an. Der richtige erste Schritt nach dem
Ablegen neuer Quellen.

### 11.3 Import ausführen

```bash
pnpm db:up          # Postgres muss laufen
pnpm db:migrate     # einmalig, legt book_chapter/book_section/book_asset an
pnpm book:import
```

Weitere Schalter: `--source <verzeichnis>` (abweichende Quelle),
`--out <datei>` (abweichender Reportpfad).

Der Lauf ist **idempotent**: Ein zweiter Import über unveränderte Quellen legt
nichts an, ändert nichts und löscht nichts (alle Zeilen „unverändert").
Er setzt außerdem **keinen KI-Aufruf** ab — `llm_call_log` wächst nicht.

### 11.4 Den Report lesen

Terminal-Kurzfassung plus `data/reports/book-import.md` (git-ignoriert, weil er
Buchinhalt enthält).

| Abschnitt             | Worauf zu achten ist                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Zählstände            | **3 Teile, 14 Kapitel.** Andere Zahlen heißen: die Struktur wurde nicht erkannt, nicht „das Buch ist so". |
| Assets je Typ         | `hand_range` ist die Zahl, die T3.3 verarbeitet. Sie sollte etwa der Hälfte aller Bilder entsprechen.     |
| Unterschriften        | „ohne erkennbare Struktur" und „unsichere Klassifikationen" — beides ist Handarbeit für T3.3.             |
| Datenbank-Wirkung     | Beim zweiten Lauf müssen alle Zeilen in „unverändert" stehen.                                             |
| Fehlende Bilddateien  | Markdown verweist auf ein Bild, das nicht da ist → Quelle unvollständig.                                  |
| Verwaiste Bilddateien | Bild liegt da, wird aber nirgends referenziert → meist ein Exportfehler.                                  |
| Nummerierung          | Lücken je Etikett (`Hand Range`, `Table`, …). „keine" heißt: nichts übersehen.                            |
| Strukturmeldungen     | Leer ist gut. `chapter-count`, `part-count`, `toc-missing` sind echte Befunde.                            |

### 11.5 Zahlen von Hand nachsehen

```bash
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select part_number, chapter_number, title from book_chapter order by chapter_number"

# Was geht in T3.3 durch die Vision-Pipeline?
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select asset_type, count(*) from book_asset where removed_at is null group by asset_type"

# Unsichere Faelle ansehen
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select relative_path, classification_rule from book_asset
   where classification_confidence = 'uncertain' order by ordinal limit 20"
```

### 11.6 Typische Fehlerbilder

| Symptom                                          | Ursache                                                | Abhilfe                                                                 |
| ------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `Mehrdeutige Bildablage: N Unterverzeichnisse …` | mehr als ein bildhaltiges Unterverzeichnis             | überzählige Verzeichnisse entfernen oder Bilder zusammenlegen           |
| `Mehrdeutige Buchquelle: N Markdown-Dateien`     | zweite `*.md` im Quellverzeichnis                      | nur die Buch-Markdown dort belassen                                     |
| Report meldet `chapter-count`                    | Kapitelstruktur nicht vollständig erkannt              | Inhaltsverzeichnis der Quelle prüfen (`# CONTENTS`, `**PART n)`-Zeilen) |
| viele „verwaiste Bilddateien"                    | Export hat Bilder erzeugt, die im Text nicht vorkommen | Quelle neu exportieren oder als bekannt hinnehmen                       |
| `relation "book_chapter" does not exist`         | Migration `0002` nicht eingespielt                     | `pnpm db:migrate`                                                       |

## 12. Konzept-Taxonomie (AP3.T3.2)

### 12.1 Voraussetzungen

```bash
# Die Buchstruktur muss importiert sein (Abschnitt 11).
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select count(*) from book_section"     # erwartet: > 0

# Der Host-Runner muss laufen (Abschnitt 9.2) - sonst scheitert jeder
# CLI-Aufruf mit Kategorie auth.
# Der Job-Worker laeuft im Backend-Prozess (ADR-0026):
docker compose ps backend
```

Die Generierung kostet **echtes Kontingent**: ein Aufruf je Kapitelteil, für
dieses Buch 53 Aufrufe mit je ~4 000 Token Eingabe. Vorher Modell und
`llm.max_concurrency` in den Einstellungen prüfen (Abschnitt 10.5).

> **Zeitgrenzen vorher hochsetzen — sonst laufen alle Aufrufe ins Timeout.**
> Ein Aufruf braucht bei Sonnet deutlich mehr als die 120 s aus der
> Standardkonfiguration. **Drei** Stellen müssen passen, und
> die Einstellungen-Seite allein genügt nicht:
>
> | Stelle                                | Wirkung                                                                     |
> | ------------------------------------- | --------------------------------------------------------------------------- |
> | `llm.timeout_ms` (Einstellungen / DB) | Zeitgrenze, die der Adapter mitschickt                                      |
> | `LLM_TIMEOUT_MS` des **Host-Runners** | **deckelt** jede Anfrage (`maxTimeoutMs`) — unabhängig von der DB           |
> | `WORKER_STALE_AFTER_MS` des Backends  | muss über der Zeitgrenze liegen, sonst wird ein laufender Job erneut geholt |
>
> ```bash
> # 1. Einstellung in der Datenbank (oder über die Einstellungen-Seite)
> docker exec -i gto-postgres psql -U gto -d gto -c \
>   "update config set value='600000'::jsonb where key='llm.timeout_ms'"
>
> # 2. Host-Runner mit demselben Wert NEU starten (Abschnitt 9.2)
> LLM_TIMEOUT_MS=600000 pnpm llm:runner
>
> # 3. .env: WORKER_STALE_AFTER_MS deutlich darüber, dann Backend neu erzeugen
> docker compose up -d backend
> ```
>
> **Ausgabegrenze der CLI: sie steht im Code, nicht in der Umgebung.** Die
> Claude CLI bricht ab, wenn die Antwort ihr Token-Limit reißt
> (`API Error: Claude's response exceeded the N output token maximum`) —
> Kategorie `invalid`, und `invalid` ist **nicht wiederholbar**, es hilft also
> kein Retry.
>
> Maßgeblich ist das `maxTokens` des jeweiligen Job-Typs: Der CLI-Adapter setzt
> daraus je Aufruf `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
> (`apps/backend/src/llm/invocation.ts`) und **überschreibt damit, was in der
> Umgebung des Host-Runners steht**. Wer die Grenze anheben will, ändert sie im
> Job-Typ, nicht beim Runner:
>
> | Job-Typ           | `maxTokens` | Datei                                  |
> | ----------------- | ----------: | -------------------------------------- |
> | `concept.extract` |      16 384 | `src/jobs/handlers/concept-extract.ts` |
> | `chart.digitize`  |      32 768 | `src/jobs/handlers/chart-digitize.ts`  |
>
> Für die Chart-Digitalisierung aus T3.3 ist zusätzlich eine Zeitgrenze von
> **1 800 000 ms** nötig, nicht 600 000 (ADR-0033).
>
> ```bash
> LLM_TIMEOUT_MS=1800000 pnpm llm:runner
> ```
>
> **Reihenfolge beachten:** Den Runner _vor_ dem Einplanen der Jobs neu
> starten. Wer ihn mittendrin neu startet, macht das Socket kurz unerreichbar —
> das ergibt Kategorie `auth`, und `auth` ist nicht wiederholbar: Alle
> wartenden Jobs landen sofort im Dead-Letter (Abschnitt 10.3).

### 12.2 Trockenlauf: wie viele Jobs entstehen?

```bash
pnpm concepts:generate --plan
# je Kapitel: Sektionen, Zeichen, Anzahl Teillaeufe - schreibt nichts
```

Ein Job verarbeitet **einen Kapitelteil** (Zeichenbudget 15 000). Lange
Kapitel zerfallen in mehrere Teile; jeder Teil ist einzeln wiederholbar.

### 12.3 Generierung starten

```bash
pnpm concepts:generate                # alle 14 Kapitel
pnpm concepts:generate --chapter 7    # nur ein Kapitel nachziehen
```

Die Jobs landen in der Queue; der Worker arbeitet sie **nacheinander** ab und
gibt je Teillauf eine Zeile ins Serverprotokoll:

```bash
docker logs -f gto-backend | grep Konzepte
# Konzepte Kapitel 7 Teil 1: 9 neu, 2 Dubletten, 0 verworfen, …
```

Bei `rate_limit` legt die Queue den Job automatisch wieder vor — der Lauf
bleibt stehen, geht aber nicht verloren. Fortschritt beobachten:

```bash
pnpm concepts:generate --report
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select status, count(*) from job_queue where job_type='concept.extract' group by status"
```

### 12.4 Chart-Zuordnung nachziehen

```bash
pnpm concepts:generate --charts
```

Verknüpft `hand_range`-Assets mit Konzepten über die gemeinsame Sektion.
**Ohne KI-Aufruf**, beliebig oft wiederholbar (legt keine Dubletten an). Nach
jedem Generierungslauf einmal ausführen.

### 12.5 Review durchführen

Oberfläche: **Konzepte** in der Hauptnavigation.

1. **Auffälligkeiten oben** zuerst abarbeiten — sie stehen bewusst über der
   Liste:
   - _Offene Voraussetzung_ — das Modell hat einen Titel genannt, zu dem es
     kein Konzept gibt. Entweder das Konzept fehlt (nachtragen) oder der
     Verweis war falsch (im Formular korrigieren).
   - _Zyklus_ — sollte nicht vorkommen; der Import speichert solche Kanten gar
     nicht erst. Taucht einer auf, wurde von Hand in die Datenbank geschrieben.
   - _Ohne Sektion_ — das Konzept hängt an keinem Buchtext. AP5 könnte dazu
     nichts laden.
   - _Kapitel ohne Konzepte_ — Teillauf fehlgeschlagen; mit
     `--chapter <n>` nachziehen.
2. **Bearbeiten** öffnet Titel, Kurzdefinition, Themenbereich, Level und
   Voraussetzungen. Eine Voraussetzung, die einen Zyklus schlösse, wird mit
   Begründung abgelehnt.
3. **Bestätigen** einzeln oder je Kapitel (`draft` → `approved`). Erst
   `approved` ist für AP4 verbindlich.

### 12.6 Konzepte nachträglich korrigieren

```bash
# Was steht drin?
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select c.title, c.topic_area, c.state, b.chapter_number
   from concept c join book_chapter b on b.id = c.chapter_id
   order by b.chapter_number, c.ordinal"

# Verteilung je Themenbereich (die Achsen des Skill-Ratings in AP4)
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select topic_area, count(*) from concept group by topic_area order by 2 desc"

# Ein Konzept wieder auf draft setzen (Notweg; normal geht das ueber die UI)
docker exec -i gto-postgres psql -U gto -d gto -c \
  "update concept set state='draft' where title = 'Pot Odds'"
```

Ein **erneuter** Generierungslauf legt kein bereits vorhandenes Konzept noch
einmal an (Dubletten-Erkennung über den normalisierten Titel). Wer wirklich
neu beginnen will, leert die Tabellen — dabei gehen bestätigte Korrekturen
verloren:

```bash
docker exec -i gto-postgres psql -U gto -d gto -c \
  "truncate table concept_chart, concept_section, concept_prerequisite, concept cascade"
```

### 12.7 Typische Fehlerbilder

| Symptom                                     | Ursache                                       | Abhilfe                                                        |
| ------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| Jobs gehen sofort auf `dead`, kein Aufruf   | Backend kennt den Job-Typ nicht (alter Stand) | `docker compose build backend && docker compose up -d backend` |
| `Kapitel N existiert nicht`                 | Buchimport fehlt                              | `pnpm book:import` (Abschnitt 11)                              |
| Alle Aufrufe scheitern mit Kategorie `auth` | Host-Runner läuft nicht                       | Abschnitt 9.2                                                  |
| Viele Konzepte „ohne Sektion"               | Modell hat Sektionsschlüssel nicht übernommen | Betroffenes Kapitel mit `--chapter` neu laufen lassen          |
| Gesamtzahl deutlich unter 120               | Zerlegung zu grob                             | Zielanzahl im Template schärfen, Kapitel neu laufen lassen     |
| `Die Antwort war kein JSON`                 | Antwort abgeschnitten (`maxTokens` zu knapp)  | `maxTokens` im Job-Typ erhöhen                                 |

## 13. Chart-Digitalisierung (AP3.T3.3)

### 13.1 Voraussetzungen

Dieselben drei Zeitgrenzen wie bei der Konzept-Generierung (Abschnitt 12.1) —
ein Vision-Aufruf über ein 13×13-Raster dauert **1 bis 3 Minuten** und
erzeugt bis zu 50 000 Tokens:

```bash
# 1. Zeitgrenze in der Datenbank
docker exec -i gto-postgres psql -U gto -d gto -c \
  "update config set value='1800000'::jsonb where key='llm.timeout_ms'"

# 2. Host-Runner mit derselben Grenze neu starten (die Ausgabegrenze kommt
#    je Aufruf aus dem Job-Typ, nicht von hier)
LLM_TIMEOUT_MS=1800000 pnpm llm:runner

# 3. WORKER_STALE_AFTER_MS in der .env deutlich darüber, dann Backend erneuern
docker compose up -d backend
```

> **Reihenfolge:** erst Runner, dann Jobs einplanen. Ein Runner-Neustart
> mitten im Lauf macht das Socket kurz unerreichbar; das ergibt Kategorie
> `auth`, und `auth` ist nicht wiederholbar — alle wartenden Jobs landen sofort
> im Dead-Letter.

Außerdem muss der Buchimport gelaufen sein (Abschnitt 11) — die Chart-Bilder
kommen aus `data/book-source/`, die Auswahl aus `book_asset`.

> **Der Container braucht die Buchbilder.** Der Job-Worker läuft im
> Backend-Container (ADR-0026), die Bilder liegen auf dem Host. Compose hängt
> `data/book-source/` deshalb **read-only** nach `/app/data/book-source` ein und
> setzt `BOOK_SOURCE_DIR` darauf. Fehlt das, landen alle Chart-Jobs mit
> `ConfigError: Repo-Wurzel nicht gefunden` im Dead-Letter. Nach einer Änderung
> an `docker-compose.yml` den Container neu erzeugen:
>
> ```bash
> docker compose up -d backend
> docker exec gto-backend ls /app/data/book-source | head -3   # muss Bilder zeigen
> ```

### 13.2 Trockenlauf und Kostenschätzung

```bash
pnpm charts:digitize --dry-run
# hand_range-Assets gesamt / bereits digitalisiert / unsicher übersprungen
# in diesem Lauf: N
# Schätzung: ~N×12 000 Tokens, ~N×1,5 Minuten
```

Der Trockenlauf setzt **keinen** Aufruf ab und plant nichts ein. Er ist vor
jedem größeren Lauf Pflicht — 348 Charts sind der größte Massenlauf des
Projekts.

### 13.3 Kalibrierung — verbindlich vor dem Massenlauf

```bash
pnpm charts:calibrate --model claude-haiku-4-5 --model claude-sonnet-5
```

Digitalisiert die Stichprobe aus
`apps/backend/test/chart/fixtures/calibration-reference.json` mit **jedem**
Modell und misst gegen von Hand geprüfte Sollwerte: Vollständigkeitsquote,
Trefferquote der Referenzzellen, Abweichung gegen die Caption-Prozente, Dauer,
Tokens.

Der Lauf schreibt **nicht** in `range_chart` — er entscheidet nur die
Modellwahl. Ergebnis unter `data/reports/chart-calibration/ergebnis.md`
(git-ignoriert). Die getroffene Wahl steht als [ADR-0033](./DECISIONS.md).

**Ein Massenlauf ohne vorherige Kalibrierung ist ein Fehler**, auch wenn er
technisch durchläuft: Ein falsches Modell schreibt falsche Frequenzen in die
Datenbank, und die gelten ab da als Wahrheit.

### 13.4 Massenlauf in Chargen

```bash
pnpm charts:digitize --limit 10            # erste Charge, Ergebnis sichten
pnpm charts:digitize --status
pnpm charts:digitize --limit 50            # hochfahren
pnpm charts:digitize                       # Rest
```

Weitere Eingrenzungen: `--chapter <n>`, `--asset <uuid>` (mehrfach),
`--model <id>` (überschreibt die Einstellung für diesen Lauf).

Der Worker arbeitet die Jobs **nacheinander** ab (ADR-0026); bei 1–3 Minuten je
Chart dauert der Vollausbau entsprechend lange. Das ist gewollt: Ein Job je
Chart heißt, dass ein Abbruch höchstens den laufenden Chart verliert.

Fortschritt beobachten:

```bash
docker logs -f gto-backend | grep Chart
# Chart Hand Range 96 (p0307_01.jpeg): 169/169 Zellen, vollstaendig, 0 unsichere Stellen …
pnpm charts:digitize --status
```

Im Frontend läuft der Fortschritt über den SSE-Kanal aus T2.5
(`GET /api/jobs/events`, Abschnitt 10.4).

### 13.5 Fortsetzen nach Abbruch oder Kontingentgrenze

**Nichts weiter zu tun als den Lauf erneut zu starten.**

```bash
pnpm charts:digitize
```

`selectCandidates()` wählt nur Assets **ohne** Chart-Datensatz. Ein durch ein
Session- oder Wochenlimit gestoppter Lauf setzt damit genau dort fort, wo er
aufhörte; für bereits Erledigtes wird kein Kontingent verbrannt.

Ein `rate_limit`-Fehler beendet die Charge **nicht**: Der betroffene Job geht
mit Backoff zurück in die Queue (Abschnitt 10). Wer die Charge wirklich
anhalten will, stoppt den Worker:

```bash
docker compose stop backend      # Jobs bleiben in der Queue liegen
docker compose start backend     # macht weiter
```

Einen einzelnen Chart neu lesen lassen:

```bash
pnpm charts:digitize --asset <uuid> --redo
```

### 13.6 Ergebnis lesen

```bash
# Zustandsverteilung - in T3.3 gibt es nur raw und failed
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select state, count(*) from range_chart group by state"

# Unvollstaendige Matrizen mit Grund
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select a.file_name, c.cell_count, left(c.failure_reason, 80)
   from range_chart c join book_asset a on a.id = c.asset_id
   where c.state = 'failed' order by a.ordinal"

# Ein Chart im Detail
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select hand, action_kind, sizing, percent from range_chart_cell
   where chart_id = '<uuid>' and hand in ('AA','AJs','72o') order by hand"
```

**In diesem Task steht kein Chart auf `approved`.** Die Freigabe hängt an der
Validierung aus T3.4 — vorher sind die Zahlen ungeprüfte Modellausgabe.

### 13.7 Typische Fehlerbilder

| Symptom                                                | Ursache                                        | Abhilfe                                                        |
| ------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------- |
| Alle Jobs `dead`, Kategorie `invalid`, „8192 output"   | CLI-Ausgabegrenze zu niedrig                   | Runner mit `CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000` neu starten   |
| Jobs `dead` mit `kein verarbeitbares hand_range`       | Asset ist `table`/`diagram` oder unsicher      | richtig so — nur `hand_range`/`certain` wird verarbeitet       |
| Viele Charts `failed`, `cell_count` < 169              | Modell liest die Matrix nicht vollständig      | Modell wechseln (`--model`), Kalibrierung wiederholen          |
| Charts mit `cell_count = 0` und Hinweis in `uncertain` | Bild ist ein Strukturraster ohne Aktionsfarben | korrekt — 41 der 348 Bilder tragen keine Frequenzen            |
| Lauf bricht mit `rate_limit` ab                        | Session- oder Wochenlimit                      | nichts tun; Queue legt wieder vor, sonst später erneut starten |
| `llm_call_log` wächst stark                            | Bilder werden **nicht** protokolliert          | Prompt-Kürzung greift (ADR-0028); nur Textteil wächst          |

## 14. Chart-Validierung und Review (AP3.T3.4)

### 14.1 Validierung starten

Die drei Prüfungen sind deterministischer Code — **kein Kontingent, kein
Runner, keine Wartezeit**. Sie laufen auf dem Host gegen die Datenbank:

```bash
cd apps/backend
pnpm charts:validate              # alle raw/validated Charts pruefen
pnpm charts:validate --status     # nur Zaehlstaende, ohne zu schreiben
pnpm charts:validate --limit 20   # Teillauf
```

Der Lauf ist wiederholbar. `approved`, `unusable` und `failed` bleiben
unangetastet — eine Freigabe wird nicht zurückgenommen.

Einzelne Heuristiken abschalten (etwa, um die Warnungslage zu vergleichen):

```bash
pnpm charts:validate --no-monotonie --no-ausreisser
```

Das ändert nur, was gemeldet wird. Ob ein Chart als bestanden gilt, hängt
ausschließlich an `error`-Befunden.

### 14.2 Zweitdurchlauf auslösen

Verarbeitet **ausschließlich** Charts mit mindestens einem `error`-Befund. Der
Job prüft das selbst noch einmal und verweigert sich sonst — ein Tippfehler im
Aufruf kostet kein Kontingent.

```bash
# Voraussetzung: Host-Runner laeuft mit angehobener Zeitgrenze (13.1)
pnpm charts:validate --recheck        # alle beanstandeten
pnpm charts:validate --recheck 5      # hoechstens 5
```

Fortschritt verfolgen:

```bash
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select status, count(*) from job_queue where job_type='chart.recheck' group by status"
```

Rechnen Sie mit **3 bis 6 Minuten je Chart**. Nach dem Zweitdurchlauf laufen
die Prüfungen automatisch erneut; das Ergebnis steht in `chart_recheck`:

```bash
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select a.caption_number, r.cells_agreed, r.cells_changed, r.cells_protected, r.decision
     from chart_recheck r join range_chart c on c.id=r.chart_id
     join book_asset a on a.id=c.asset_id order by 1"
```

> **Wenn alle Recheck-Jobs sofort mit `UnknownJobTypeError` sterben:** Der
> Backend-Container läuft noch mit einem Build ohne den Job-Typ.
> `docker compose up -d --build backend`, tote Jobs löschen, neu einplanen.
> Ein Backend-Neustart ist gefahrlos, solange keine Jobs laufen — anders als
> ein Runner-Neustart (13.1).

### 14.3 Review durchführen

`/charts` im Frontend, angemeldet. Links das Original-Bild, rechts die gelesene
Matrix als 13×13-Raster; beanstandete Zellen sind umrandet, korrigierte
gestrichelt. Unter den Befunden steht die Gegenüberstellung „gelesen
(combo-gewichtet)" gegen „Bildunterschrift".

**Was beim Sichten tatsächlich weiterhilft:** Viele Chart-Bilder tragen unten
eine **Legende mit Prozentwerten** („Call 59.65 % / Fold 40.35 %"), auch wenn
die Buch-Unterschrift keine nennt. Diese Zahl gegen die Spalte „gelesen"
halten — das ist die verlässlichste Einzelprüfung, die ein Mensch hier machen
kann, und sie deckt Fälle auf, die `caption-match` nicht sehen kann.

Eine Zelle korrigieren: im Raster anklicken, Aktionen als je eine Zeile
`art [sizing] prozent` eintragen, speichern. Die Korrektur wird als `manual`
mit Zeitpunkt vermerkt, danach läuft die Prüfung automatisch erneut. Weder ein
späterer Validierungslauf noch ein Zweitdurchlauf überschreibt sie.

Freigabe einzeln über **Freigeben**, oder für alle geprüften Charts über **Alle
geprüften freigeben**.

> **Die Sammelfreigabe ist der Ausnahmefall.** `validated` heißt nur, dass die
> automatischen Prüfungen nichts gefunden haben — und `caption-match` greift
> nur bei Charts, deren Unterschrift Prozentwerte nennt (am aktuellen Bestand:
> 6 von 25). Wer alles auf einmal freigibt, erklärt ungeprüfte Zahlen zur
> Wahrheit. Das ist genau Risiko R2.

### 14.4 Chart als unbrauchbar markieren

Im Detail unter **Unbrauchbar**: Begründung eintragen, markieren. Die Begründung
ist Pflicht — ein leeres Feld lehnt das Backend mit `400` ab. Das ist der von
der DoD zugelassene Rest, und er muss benannt sein, nicht nur gezählt.

Typischer Fall aus dem ersten Lauf: HR 31 — das Modell hat die Legende
vertauscht und rote Zellen durchgängig als `call` gelesen. Weil die
Unterscheidung im Datensatz nicht mehr enthalten ist, hilft keine zellweise
Korrektur; das Chart braucht eine erneute Digitalisierung.

### 14.5 Zählstände und Approved-Quote

```bash
pnpm charts:validate --status
```

Die Quote bezieht sich auf **alle** `hand_range`-Assets, nicht auf die bereits
digitalisierten — sonst sähe ein halb gelaufener Massenlauf gut aus.

Zustandsverteilung direkt aus der Datenbank:

```bash
docker exec -i gto-postgres psql -U gto -d gto -c \
  "select state, count(*) from range_chart group by state order by state"

docker exec -i gto-postgres psql -U gto -d gto -c \
  "select check, severity, count(*) from chart_finding group by 1,2 order by 1,2"
```

## 15. Content-API prüfen (AP3.T3.5)

Alle Endpunkte sind auth-geschützt und **nur lesend** — ein Prüflauf kann nichts
kaputt machen und kostet kein Kontingent.

### 15.1 Anmelden und Endpunkte abklopfen

```bash
B=http://127.0.0.1:3010
curl -s -c cj.txt "$B/api/auth/csrf" > /dev/null
TOK=$(grep gto_csrf cj.txt | awk '{print $7}')
curl -s -b cj.txt -c cj.txt -X POST "$B/api/auth/login" \
  -H 'content-type: application/json' -H "x-csrf-token: $TOK" \
  -d '{"username":"<benutzer>","password":"<passwort>"}'

# Kapitel, Sektionen, eine einzelne Sektion
curl -s -b cj.txt "$B/api/content/chapters" | head -c 400
curl -s -b cj.txt "$B/api/content/chapters/7/sections" | head -c 400
curl -s -b cj.txt "$B/api/content/sections/ch07/bet-sizing" | head -c 400

# Konzepte und Lernpfad
curl -s -b cj.txt "$B/api/content/concepts?chapter=3"
curl -s -b cj.txt "$B/api/content/concepts/learning-path"

# Charts und eine einzelne Zelle
curl -s -b cj.txt "$B/api/content/charts?chapter=1"
curl -s -b cj.txt "$B/api/content/charts/<uuid>/cells/AKs"

# Spot-Suche
curl -s -b cj.txt "$B/api/content/spots?position=CO&stack=40"
```

> **Schnelltest des Zugriffsschutzes:** Dieselben Pfade **ohne** `-b cj.txt`
> müssen alle `401` liefern — auch der Bildabruf.
>
> ```bash
> curl -s -o /dev/null -w '%{http_code}\n' "$B/api/content/chapters"
> ```

### 15.2 Bilder und Caching prüfen

```bash
# Header ansehen
curl -s -D - -o /dev/null -b cj.txt "$B/api/content/assets/<asset-uuid>/image"

# Bedingter Abruf: muss 304 ohne Nutzlast liefern
ETAG=$(curl -s -D - -o /dev/null -b cj.txt "$B/api/content/assets/<asset-uuid>/image" \
       | grep -i '^etag' | tr -d '\r' | cut -d' ' -f2-)
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
  -b cj.txt -H "if-none-match: $ETAG" "$B/api/content/assets/<asset-uuid>/image"
```

Erwartet: `304 0`.

### 15.3 Typische Fehlerbilder

| Symptom                                                               | Ursache                                                                   | Abhilfe                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `404 "Die Bilddatei liegt auf diesem Server nicht vor"`               | Quellverzeichnis nicht eingehängt oder Datei fehlt                        | `BOOK_SOURCE_DIR` prüfen, Abschnitt 13; Mount in `docker-compose.yml`    |
| `404 "Dieses Asset gibt es nicht"` bei einer offensichtlich echten ID | Kennung ist keine UUID (Tippfehler, Pfad statt ID)                        | ID aus `bookAsset.id` bzw. aus `imageUrl` einer Antwort nehmen           |
| `400 "Der hinterlegte Pfad ist nicht zulässig"`                       | `book_asset.relative_path` verlässt das Bildverzeichnis — **Datenfehler** | Zeile prüfen; Import aus T3.1 wiederholen                                |
| Chartliste leer, obwohl Charts existieren                             | keines ist `approved`                                                     | `pnpm charts:validate --status` (Abschnitt 14.5)                         |
| Chart per ID nicht auffindbar (`404`)                                 | Chart ist nicht freigegeben                                               | absichtlich; nur die Review-Ansicht darf `includeUnapproved=true` setzen |
| Konzeptliste fast leer                                                | Vorgabe ist `state=approved`, und T3.2 hat kaum freigegeben               | `?state=draft` zeigt den Entwurfsbestand                                 |
| `400` mit `allowed`-Liste                                             | Filterwert außerhalb der geschlossenen Menge                              | Wert aus `allowed` nehmen                                                |

### 15.4 Leeres Suchergebnis deuten

Die Spot-Suche liefert nie eine stumme Leermenge. Zwei Felder sagen, was los
ist:

```bash
curl -s -b cj.txt "$B/api/content/spots?position=BN&stack=200" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["explanation"]); print(d["coverage"])'
```

- `explanation` nennt die nachweisliche Ursache — etwa „200bb (±5) liegt
  außerhalb des abgedeckten Bereichs von 15 bis 40 bb".
- `coverage` zeigt, was der freigegebene Bestand überhaupt hergibt: Positionen,
  Stacktiefen, Spielformen, Zahl der durchsuchten Charts.

Steht dort `chartsSearched: 0`, ist noch kein Chart freigegeben — dann fehlt
nicht die Suche, sondern die Freigabe (Abschnitt 14).

Bei einem Treffer mit niedriger Punktzahl weist `explanation` ausdrücklich
darauf hin. `missed` am einzelnen Treffer sagt, welches Kriterium nicht saß —
meist „keine Stacktiefe in der Unterschrift", weil das Buch sie nicht zu jedem
Chart nennt.

## 16. Noch nicht abgedeckt

- Der Host-Nginx-vhost und das TLS-Zertifikat sind vorbereitet, aber noch nicht
  eingespielt: Beides erfordert Root auf dem Host (Abschnitte 8.4 und 8.5).
- Der Host-Runner startet nach einem Reboot nicht automatisch (Abschnitt 9.2).
- Die SSE-`location` im vhost ist vorbereitet, aber wie der ganze vhost noch
  nicht eingespielt (Abschnitt 10.4, Root nötig).
