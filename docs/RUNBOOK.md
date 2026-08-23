# Runbook — GTO Trainer

Betriebshandbuch. Stand: AP1.T1.1 — enthält bislang **nur das lokale Setup**.
Deployment, Backup und Restore folgen in AP1.T1.5.

---

## 1. Voraussetzungen

| Werkzeug | Version                           | Prüfen mit       |
| -------- | --------------------------------- | ---------------- |
| Node.js  | 20.19.6 (siehe `.nvmrc`)          | `node -v`        |
| pnpm     | 9.15.9 (via Corepack)             | `pnpm -v`        |
| Git      | ≥ 2.39                            | `git --version`  |
| GNU Make | optional, nur für `make`-Kurzform | `make --version` |

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
```

---

## 3. Tägliche Kommandos

| Zweck                                  | pnpm             | make         |
| -------------------------------------- | ---------------- | ------------ |
| Dev-Server (alle Workspaces, parallel) | `pnpm dev`       | `make dev`   |
| Produktions-Build                      | `pnpm build`     | `make build` |
| Lint + Formatprüfung                   | `pnpm lint`      | `make lint`  |
| Tests                                  | `pnpm test`      | `make test`  |
| Formatierung schreiben                 | `pnpm format`    | —            |
| Nur Typprüfung                         | `pnpm typecheck` | —            |

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

## 5. Tests

```bash
pnpm test
```

Läuft rekursiv über alle Workspaces mit Test-Script:

- `packages/shared` — Verträge und Type-Guards
- `apps/backend` — Routen via `app.inject()`, ohne echten Port

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

| Symptom                                                          | Ursache                                         | Abhilfe                                         |
| ---------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `devDependencies: skipped because NODE_ENV is set to production` | `NODE_ENV=production` in der Shell              | `NODE_ENV=development pnpm install`             |
| `Cannot find module '@gto/shared'`                               | Workspace-Links fehlen oder `dist` nicht gebaut | `pnpm install && pnpm build`                    |
| `tsc` meldet Fehler in `dist/`                                   | veraltete Build-Info                            | `rm -rf **/dist **/*.tsbuildinfo && pnpm build` |
| `make: command not found`                                        | GNU Make nicht installiert                      | die `pnpm`-Kommandos direkt verwenden           |
| Port 3000 belegt                                                 | anderer Prozess                                 | `PORT=3001 pnpm --filter @gto/backend dev`      |

Kompletter Neuaufbau:

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules
rm -rf apps/*/dist packages/*/dist
pnpm install && pnpm build
```

---

## 8. Noch nicht abgedeckt

Die folgenden Abschnitte entstehen in **AP1.T1.5**:

- Docker-Compose-Stack (Backend, Frontend, Postgres)
- Nginx-Vhost auf dem Host inkl. TLS via Certbot
- Deploy-Ablauf und Rollback
- Datenbank-Backup und Restore
- Log- und Healthcheck-Betrieb

Datenbankbetrieb (Migrationen) folgt ab **AP1.T1.2**.
