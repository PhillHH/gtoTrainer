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

## 9. Noch nicht abgedeckt

- Der Host-Nginx-vhost und das TLS-Zertifikat sind vorbereitet, aber noch nicht
  eingespielt: Beides erfordert Root auf dem Host (Abschnitte 8.4 und 8.5).
