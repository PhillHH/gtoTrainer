# Runbook — GTO Trainer

Betriebshandbuch. Stand: AP1.T1.2 — lokales Setup **und Datenbankbetrieb**.
Deployment, Backup und Restore folgen in AP1.T1.5.

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

Die Testdatenbank (`TEST_DATABASE_URL`, Default `gto_test`) wird **automatisch**
angelegt, geleert und migriert — kein manueller Schritt nötig. Sie liegt auf
derselben Instanz wie die Entwicklungsdatenbank, aber in einer eigenen Datenbank,
damit Tests keine Entwicklungsdaten löschen.

Die Backend-Tests lösen `@gto/shared` per Vitest-Alias auf die Quellen auf;
`pnpm test` ist deshalb **nicht** von einem vorherigen `pnpm build` abhängig.

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

| Symptom                                                          | Ursache                                                                  | Abhilfe                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `devDependencies: skipped because NODE_ENV is set to production` | `NODE_ENV=production` in der Shell                                       | `NODE_ENV=development pnpm install`                                                                             |
| `Cannot find module '@gto/shared'`                               | Workspace-Links fehlen oder `dist` nicht gebaut                          | `pnpm install && pnpm build`                                                                                    |
| `tsc` meldet Fehler in `dist/`                                   | veraltete Build-Info                                                     | `rm -rf **/dist **/*.tsbuildinfo && pnpm build`                                                                 |
| `make: command not found`                                        | GNU Make nicht installiert                                               | die `pnpm`-Kommandos direkt verwenden                                                                           |
| Port 3000 belegt                                                 | anderer Prozess                                                          | `PORT=3001 pnpm --filter @gto/backend dev`                                                                      |
| `all predefined address pools have been fully subnetted`         | Dockers Standard-Subnetze sind auf dem Host durch fremde Projekte belegt | `DOCKER_SUBNET` in der `.env` auf ein freies Subnetz setzen (ADR-0006); **nicht** fremde Netzwerke löschen      |
| `bind: address already in use` bei `pnpm db:up`                  | `POSTGRES_HOST_PORT` ist belegt                                          | freien Port suchen (`ss -ltn`), dann `POSTGRES_HOST_PORT` **und** beide Verbindungs-URLs in der `.env` anpassen |
| `DATABASE_URL enthaelt noch den Platzhalter aus .env.example`    | `.env` kopiert, aber nicht bearbeitet                                    | Platzhalter an allen drei Stellen durch dasselbe Passwort ersetzen                                              |
| `Pflicht-Umgebungsvariable DATABASE_URL fehlt oder ist leer`     | keine `.env` vorhanden                                                   | `cp .env.example .env` und ausfüllen                                                                            |
| `Postgres ist nicht erreichbar` beim Testlauf                    | Container läuft nicht                                                    | `pnpm db:up`, danach `docker compose ps` prüfen                                                                 |
| `db:reset ist blockiert: NODE_ENV=production`                    | `NODE_ENV` steht auf diesem Host oft auf `production`                    | bewusst so — nur mit `NODE_ENV=development` ausführen                                                           |
| `db:reset ist blockiert: Bestaetigung fehlt`                     | Schutz gegen versehentliches Löschen                                     | `DB_RESET_CONFIRM=yes` setzen                                                                                   |
| `password authentication failed`                                 | `.env`-Passwort geändert, Volume hat noch das alte                       | `docker compose down -v` (löscht die Daten) und neu aufsetzen                                                   |

Kompletter Neuaufbau:

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules
rm -rf apps/*/dist packages/*/dist
pnpm install && pnpm build
```

---

## 8. Noch nicht abgedeckt

Die folgenden Abschnitte entstehen in **AP1.T1.5**:

- Backend- und Frontend-Container im Compose-Stack (Postgres läuft seit T1.2)
- Nginx-Vhost auf dem Host inkl. TLS via Certbot
- Deploy-Ablauf und Rollback
- Datenbank-Backup und Restore
- Log- und Healthcheck-Betrieb

Login und Passwort-CLI folgen in **AP1.T1.3**.
