# Architektur — GTO Trainer

Stand: AP1.T1.1 (Projektgerüst). Dieses Dokument wird in jedem Task um die
jeweiligen Deltas fortgeschrieben.

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

Der Compose-/Nginx-Teil ist **Zielbild**, nicht Ist-Stand: Docker Compose,
Nginx-Konfiguration und Deployment entstehen erst in **AP1.T1.5**, die
Datenbank in **AP1.T1.2**. Nach AP1.T1.1 existiert ausschließlich das
lauffähige Code-Gerüst.

## 2. Monorepo-Struktur

```
gtoTrainer/
├── apps/
│   ├── backend/          @gto/backend  — Fastify + TypeScript
│   │   ├── src/app.ts      Routen-Aufbau (testbar, ohne listen)
│   │   ├── src/server.ts   Prozess-Einstieg (listen)
│   │   └── test/           Vitest
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

## 3. Laufzeit-Komponenten (Ist-Stand nach T1.1)

| Komponente | Technik                 | Zustand nach T1.1                   |
| ---------- | ----------------------- | ----------------------------------- |
| Backend    | Fastify 5, Node 20, ESM | Startbar, eine Route `GET /healthz` |
| Frontend   | React 18, Vite 6        | Baubar, Platzhalter-Inhalt          |
| Shared     | TypeScript              | `HealthResponse` + Type-Guard       |
| Datenbank  | —                       | folgt in T1.2                       |
| Auth       | —                       | folgt in T1.3                       |
| Deployment | —                       | folgt in T1.5                       |
| CI         | —                       | folgt in T1.6                       |

## 4. Querschnitts-Entscheidungen

- **Node 20.19.6**, fixiert in `.nvmrc`; `engines.node >= 20.19.0`.
- **pnpm Workspaces** als Monorepo-Mechanik, Version über `packageManager`
  (Corepack) gepinnt.
- **TypeScript strikt** — `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride` in `tsconfig.base.json`, von allen Workspaces geerbt.
- **ESM durchgehend** (`"type": "module"`), relative Importe mit `.js`-Endung.

Begründungen siehe [DECISIONS.md](./DECISIONS.md).

## 5. Offene Architektur-Punkte

- Persistenz-Schicht und Migrationsstrategie (T1.2)
- Session-/Auth-Modell (T1.3)
- API-Client und Routing im Frontend (T1.4)
- Container-Topologie, Nginx-Vhost, Backup/Restore (T1.5)
- Ingestion-Pipeline für `data/book-source/` (AP3)
