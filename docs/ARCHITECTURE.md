# Architektur — GTO Trainer

Stand: AP1.T1.2 (Datenbank & Migrationen). Dieses Dokument wird in jedem Task
um die jeweiligen Deltas fortgeschrieben.

## 1. Systemübersicht (Zielarchitektur)

```
   Browser
      │  HTTPS
      ▼
┌──────────────────────────┐
│  Host-Nginx  (+ Certbot) │   TLS-Terminierung, Reverse Proxy
│  läuft bereits auf dem   │   → /        : Frontend (statische Assets)
│  Zielhost                │   → /api/*   : Backend
└──────────┬───────────────┘   → /healthz : Liveness-Probe
           │  HTTP (localhost)
           ▼
┌──────────────────────────────────────────┐
│  Docker-Compose-Stack                    │
│  ┌────────────────┐  ┌────────────────┐  │
│  │ frontend       │  │ backend        │  │
│  │ React + Vite   │  │ Fastify + TS   │  │
│  │ (statisch)     │  │                │  │
│  └────────────────┘  └───────┬────────┘  │
│                              │ TCP       │
│                      ┌───────▼────────┐  │
│                      │ Postgres       │  │
│                      └────────────────┘  │
└──────────────────────────────────────────┘
```

Der Nginx- und Container-Teil für Backend/Frontend ist **Zielbild**, nicht
Ist-Stand: Er entsteht erst in **AP1.T1.5**. Seit **AP1.T1.2** läuft die
Postgres-Komponente jedoch real als Compose-Service; Backend und Frontend laufen
noch direkt auf dem Host und verbinden sich über den veröffentlichten
Datenbank-Port.

## 2. Monorepo-Struktur

```
gtoTrainer/
├── apps/
│   ├── backend/          @gto/backend  — Fastify + TypeScript
│   │   ├── src/app.ts      Routen-Aufbau (testbar, ohne listen)
│   │   ├── src/server.ts   Prozess-Einstieg (listen)
│   │   ├── src/config/     Typisiertes Laden/Validieren der .env
│   │   ├── src/db/         Schema, Pool, Migration, Seed, Reset
│   │   ├── drizzle/        Versionierte SQL-Migrationen (generiert)
│   │   └── test/           Vitest (inkl. DB-Integrationstests)
│   └── frontend/         @gto/frontend — React + Vite + TypeScript
│       ├── index.html
│       └── src/            Platzhalter-App (echtes Layout: T1.4)
├── packages/
│   └── shared/           @gto/shared   — gemeinsame Typen/Verträge
│       ├── src/health.ts   HealthResponse, isHealthResponse
│       └── test/           Vitest
├── data/
│   └── book-source/      Pflicht-Input für AP3 (Inhalt git-ignoriert)
├── docs/
│   ├── ap/               Kanonische Arbeitspakete (nur lesen!)
│   └── status/           Statusberichte je AP
├── docker-compose.yml    Entwicklungs-Stack (T1.2: nur Postgres)
├── .env.example          Vorlage der Konfiguration (echte .env ignoriert)
├── pnpm-workspace.yaml
├── tsconfig.base.json    strikte TS-Basis, von Workspaces geerbt
├── eslint.config.js      Flat Config, monorepo-weit
└── Makefile              Kurzform für dev/build/lint/test
```

### Warum diese Aufteilung

- **`packages/shared` als Vertragsort:** Typen, die Backend und Frontend teilen,
  liegen genau an einer Stelle. Der erste reale Vertrag ist `HealthResponse` —
  das Backend typisiert `/healthz` damit, der Backend-Test prüft die HTTP-Antwort
  per `isHealthResponse()` dagegen. Der Ort ist damit ab Tag 1 in Benutzung und
  nicht nur reserviert.
- **`app.ts` getrennt von `server.ts`:** Die Fastify-Instanz lässt sich im Test
  per `app.inject()` ohne echten Port ansprechen.
- **Backend/Shared als TS-Project-References:** `tsc -b` baut in korrekter
  Reihenfolge und erzeugt Deklarationen. Das Frontend ist ein Blatt und wird
  nur typgeprüft (`tsc --noEmit`), gebaut wird es von Vite.

## 3. Laufzeit-Komponenten (Ist-Stand nach T1.2)

| Komponente | Technik                 | Zustand nach T1.2                                |
| ---------- | ----------------------- | ------------------------------------------------ |
| Backend    | Fastify 5, Node 20, ESM | Startbar, `GET /healthz`; DB-Anbindung vorhanden |
| Frontend   | React 18, Vite 6        | Baubar, Platzhalter-Inhalt                       |
| Shared     | TypeScript              | `HealthResponse` + Type-Guard                    |
| Datenbank  | Postgres 16 (Compose)   | Läuft, Basisschema migriert (5 Tabellen)         |
| DB-Zugriff | Drizzle ORM + `pg`-Pool | Schema, Migration, Seed, Reset                   |
| Auth       | —                       | folgt in T1.3                                    |
| Deployment | —                       | folgt in T1.5                                    |
| CI         | —                       | folgt in T1.6                                    |

## 3a. Datenbank-Komponente (neu in T1.2)

**Ablageort der Compose-Datei:** `docker-compose.yml` in der **Repo-Wurzel**.
In T1.2 enthält sie ausschließlich den Service `postgres`; die Container für
Backend und Frontend kommen in T1.5 in dieselbe Datei.

| Aspekt      | Festlegung                                                                   |
| ----------- | ---------------------------------------------------------------------------- |
| Image       | `postgres:16-alpine`                                                         |
| Container   | `gto-postgres`                                                               |
| Persistenz  | Benanntes Volume `gto-pgdata`                                                |
| Healthcheck | `pg_isready`, Intervall 5 s, 10 Versuche                                     |
| Host-Port   | `${POSTGRES_HOST_PORT}`, Default **55434**, gebunden an `127.0.0.1`          |
| Netzwerk    | `gto-net` mit explizitem Subnetz `${DOCKER_SUBNET}` (Default `10.89.0.0/24`) |

### Portkonvention

Der Host ist mit fremden Diensten belegt. Verbindliche Regel: **kein Port wird
hart verdrahtet**, jeder veröffentlichte Port kommt aus einer Umgebungsvariablen
und wird vor dem Start geprüft (`ss -ltn | grep <port>`).

| Dienst          | Variable             | Default | Grund                                |
| --------------- | -------------------- | ------- | ------------------------------------ |
| Postgres (Host) | `POSTGRES_HOST_PORT` | 55434   | 5432, 55432, 55433 sind fremd belegt |
| Backend         | `PORT`               | 3001    | 3000 ist fremd belegt (siehe T1.1)   |

Begründung und verworfene Alternativen: [ADR-0005](./DECISIONS.md) und
[ADR-0006](./DECISIONS.md).

### Datenfluss beim Datenbankzugriff

```
Backend-Code
   │  typisierte Query (Drizzle)
   ▼
apps/backend/src/db/client.ts   createDb() -> pg.Pool + Drizzle
   │  SQL über den Connection-Pool
   ▼
127.0.0.1:${POSTGRES_HOST_PORT}
   ▼
Container gto-postgres  ->  Volume gto-pgdata
```

Der Pool wird bei `SIGTERM`/`SIGINT` über `registerShutdownHandlers()`
geschlossen, damit keine Verbindungen verwaisen.

## 4. Querschnitts-Entscheidungen

- **Node 20.19.6**, fixiert in `.nvmrc`; `engines.node >= 20.19.0`.
- **pnpm Workspaces** als Monorepo-Mechanik, Version über `packageManager`
  (Corepack) gepinnt.
- **TypeScript strikt** — `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride` in `tsconfig.base.json`, von allen Workspaces geerbt.
- **ESM durchgehend** (`"type": "module"`), relative Importe mit `.js`-Endung.

Begründungen siehe [DECISIONS.md](./DECISIONS.md).

## 5. Offene Architektur-Punkte

- Session-/Auth-Modell (T1.3)
- API-Client und Routing im Frontend (T1.4)
- Container-Topologie, Nginx-Vhost, Backup/Restore (T1.5)
- Ingestion-Pipeline für `data/book-source/` (AP3)
