# GTO Trainer

Monorepo für den GTO Trainer: Fastify-Backend, React/Vite-Frontend und ein
geteilter Vertragsort für Typen.

## Schnellstart

```bash
nvm use              # Node-Version aus .nvmrc
corepack enable
pnpm install
cp .env.example .env # Platzhalter ersetzen (siehe RUNBOOK)
pnpm db:up           # Postgres-Container starten
pnpm db:migrate      # Basisschema anlegen
pnpm auth:set-password admin   # Benutzer fuer den Login anlegen
pnpm dev
```

## Struktur

| Pfad               | Paket           | Inhalt                                |
| ------------------ | --------------- | ------------------------------------- |
| `apps/backend`     | `@gto/backend`  | Fastify + TypeScript, `GET /healthz`  |
| `apps/frontend`    | `@gto/frontend` | React + Vite + TypeScript             |
| `packages/shared`  | `@gto/shared`   | Gemeinsame Typen/Verträge             |
| `data/book-source` | —               | Pflicht-Input für AP3 (git-ignoriert) |
| `docs/`            | —               | Architektur, Entscheidungen, Runbook  |

## Kommandos

| Zweck | Befehl       | Kurzform     |
| ----- | ------------ | ------------ |
| Dev   | `pnpm dev`   | `make dev`   |
| Build | `pnpm build` | `make build` |
| Lint  | `pnpm lint`  | `make lint`  |
| Tests | `pnpm test`  | `make test`  |

## Dokumentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Systemübersicht und Monorepo-Struktur
- [docs/INTERFACES.md](docs/INTERFACES.md) — Schnittstellen und Andockpunkte
- [docs/DECISIONS.md](docs/DECISIONS.md) — Architekturentscheidungen (ADR)
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — Setup und Betrieb
- [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) — Arbeitsregeln für den Coding-Agenten
