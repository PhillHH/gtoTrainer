# Architektur — GTO Trainer

Stand: AP1.T1.4 (Frontend-Shell). Dieses Dokument wird in jedem Task um die
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
│   │   ├── src/auth/       Passwort, Session, CSRF, Rate-Limit, Guard
│   │   ├── src/db/         Schema, Pool, Migration, Seed, Reset
│   │   ├── drizzle/        Versionierte SQL-Migrationen (generiert)
│   │   └── test/           Vitest (inkl. DB-Integrationstests)
│   └── frontend/         @gto/frontend — React + Vite + TypeScript
│       ├── index.html
│       ├── src/api/        API-Client (EINZIGE Backend-Zugangsstelle)
│       ├── src/auth/       AuthContext + RequireAuth-Guard
│       ├── src/theme/      Hell/Dunkel-Umschaltung
│       ├── src/layout/     Sidebar-Shell des geschuetzten Bereichs
│       ├── src/pages/      Login, Dashboard, 5 Platzhalter, 404
│       ├── src/styles/     tokens.css (Design-Tokens) + global.css
│       └── test/           Vitest + Testing Library (jsdom)
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

## 3. Laufzeit-Komponenten (Ist-Stand nach T1.4)

| Komponente | Technik                 | Zustand nach T1.3                               |
| ---------- | ----------------------- | ----------------------------------------------- |
| Backend    | Fastify 5, Node 20, ESM | `GET /healthz` + Auth-API unter `/api/auth/`    |
| Frontend   | React 18, Vite 6        | Baubar, Platzhalter-Inhalt                      |
| Shared     | TypeScript              | Health- **und** Auth-Verträge                   |
| Datenbank  | Postgres 16 (Compose)   | Läuft, Basisschema migriert (5 Tabellen)        |
| DB-Zugriff | Drizzle ORM + `pg`-Pool | Schema, Migration, Seed, Reset                  |
| Auth       | argon2id + DB-Sessions  | Login/Logout/me, CSRF, Rate-Limit, Passwort-CLI |
| Deployment | —                       | folgt in T1.5                                   |
| CI         | —                       | folgt in T1.6                                   |

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

## 3b. Auth-Komponente (neu in T1.3)

Der Zugangsschutz sitzt vollständig im Backend. Es gibt **genau einen** Ort, an
dem über Zugriff entschieden wird.

```
Browser
   │  1. GET /api/auth/csrf         → Cookie gto_csrf (lesbar)
   │  2. POST /api/auth/login       → Header x-csrf-token + Zugangsdaten
   ▼
┌──────────────────────────────────────────────────────────────┐
│ Fastify                                                      │
│                                                              │
│  onRequest-Hook 1: CSRF-Prüfung                              │
│     nur für POST/PUT/PATCH/DELETE                            │
│     Cookie gto_csrf  ==  Header x-csrf-token ?  sonst 403    │
│                                                              │
│  onRequest-Hook 2: Session auflösen                          │
│     Cookie gto_session → SHA-256 → session.token_hash        │
│     gültig & nicht abgelaufen → request.sessionUser          │
│                                                              │
│  preHandler app.requireSession   ← DIE Zugriffsentscheidung  │
│     kein sessionUser → 401 unauthenticated                   │
│                                                              │
│  Login-Pfad:                                                 │
│     Rate-Limit (nur Fehlversuche, IP|benutzername)           │
│       → argon2id-Verify (Dummy-Hash bei unbekanntem Konto)   │
│       → [TOTP-Hook, Default aus]                             │
│       → Session anlegen, Cookies setzen                      │
└──────────────────────────────────────────────────────────────┘
   │
   ▼
Postgres:  user.password_hash (argon2id) · session.token_hash (SHA-256)
```

| Baustein     | Datei                      | Aufgabe                                     |
| ------------ | -------------------------- | ------------------------------------------- |
| Passwort     | `src/auth/password.ts`     | argon2id hashen/prüfen, Timing-Gleichheit   |
| Session      | `src/auth/session.ts`      | Token erzeugen, hashen, auflösen, aufräumen |
| CSRF         | `src/auth/csrf.ts`         | Double-Submit + Origin-Prüfung              |
| Rate-Limit   | `src/auth/rate-limit.ts`   | Fehlversuche je `IP\|benutzer`              |
| Plugin/Guard | `src/auth/plugin.ts`       | Hooks, Cookies, `requireSession`            |
| Endpunkte    | `src/auth/routes.ts`       | login/logout/me/csrf, TOTP-Hook             |
| Passwort-CLI | `src/auth/set-password.ts` | Benutzer anlegen/Passwort ändern            |

**Öffentlich bleibt nur `GET /healthz`** — ab T1.5 rufen Host-Nginx und
Container-Healthcheck ihn ohne Session auf.

Begründungen: [ADR-0007](./DECISIONS.md) (argon2-Parameter),
[ADR-0008](./DECISIONS.md) (Token-Hashing, Cookies),
[ADR-0009](./DECISIONS.md) (CSRF), [ADR-0010](./DECISIONS.md) (Rate-Limit).

## 3c. Frontend-Struktur (neu in T1.4)

```
main.tsx
  └─ <BrowserRouter>
       └─ <App>
            ├─ <ThemeProvider>        data-theme am <html>, Tokens greifen
            └─ <AuthProvider>         EINZIGE Quelle des Anmeldestatus
                 └─ <AppRoutes>
                      ├─ /login                      oeffentlich
                      └─ <RequireAuth>               DIE Zugriffsentscheidung
                           └─ <AppLayout>            Sidebar + Kopfzeile
                                ├─ /                 Dashboard
                                ├─ /lernen           Platzhalter (AP5)
                                ├─ /drills           Platzhalter (AP6)
                                ├─ /turniere         Platzhalter (AP7)
                                ├─ /material         Platzhalter (AP8)
                                └─ /einstellungen    Platzhalter (AP9)
                      └─ *                           404
```

### Auth-Fluss im Frontend

```
App-Start
   │
   ├─ AuthProvider: GET /api/auth/me      Status = "checking"
   │        │
   │        ├─ 200 → Status "authenticated", Benutzer im Context
   │        └─ 401 → Status "anonymous"
   │
   └─ RequireAuth
          checking      → Ladeanzeige  (NIE Login-Screen — sonst blitzt er
          anonymous     → /login          angemeldeten Nutzern kurz auf)
          authenticated → Seite

Login:  LoginPage → useAuth().login() → API-Client
          → GET /api/auth/csrf (falls kein Cookie)  → POST /api/auth/login
          → Status "authenticated" → zurueck zum urspruenglich angefragten Ziel

Logout: AppLayout → useAuth().logout() → POST /api/auth/logout
          → Status "anonymous" → /login
```

### Backend-Anbindung

Der Browser sieht **eine einzige Herkunft**. Im Dev-Betrieb leitet der
Vite-Proxy `/api` und `/healthz` an das Backend weiter, im Zielbetrieb (T1.5)
macht der Host-Nginx dasselbe. Dadurch braucht es kein CORS, und
`SameSite=Lax` bleibt wirksam ([ADR-0015](./DECISIONS.md)).

```
Browser ──► Vite-Dev-Server :5174 ──/api, /healthz──► Fastify :3010
            (statische Assets)                        (T1.5: Host-Nginx)
```

| Baustein      | Datei                         | Aufgabe                                                    |
| ------------- | ----------------------------- | ---------------------------------------------------------- |
| API-Client    | `src/api/client.ts`           | **Einzige** Stelle mit `fetch`; CSRF, Cookies, Fehlerarten |
| Auth-Zustand  | `src/auth/AuthContext.tsx`    | `checking`/`authenticated`/`anonymous`                     |
| Route-Guard   | `src/auth/RequireAuth.tsx`    | Umleitung auf `/login`, merkt sich das Ziel                |
| Layout        | `src/layout/AppLayout.tsx`    | Sidebar, Kopfzeile, Logout                                 |
| Design-Tokens | `src/styles/tokens.css`       | Hell/Dunkel, alle visuellen Werte                          |
| Theme         | `src/theme/ThemeProvider.tsx` | `data-theme`, Systemwahl + manuelle Wahl                   |

Begründungen: [ADR-0011](./DECISIONS.md) (Router),
[ADR-0012](./DECISIONS.md) (Context), [ADR-0013](./DECISIONS.md) (Tokens),
[ADR-0014](./DECISIONS.md) (Tests), [ADR-0015](./DECISIONS.md) (Dev-Proxy).

## 4. Querschnitts-Entscheidungen

- **Node 20.19.6**, fixiert in `.nvmrc`; `engines.node >= 20.19.0`.
- **pnpm Workspaces** als Monorepo-Mechanik, Version über `packageManager`
  (Corepack) gepinnt.
- **TypeScript strikt** — `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride` in `tsconfig.base.json`, von allen Workspaces geerbt.
- **ESM durchgehend** (`"type": "module"`), relative Importe mit `.js`-Endung.

Begründungen siehe [DECISIONS.md](./DECISIONS.md).

## 5. Offene Architektur-Punkte

- Container-Topologie, Nginx-Vhost, Backup/Restore (T1.5)
- Ingestion-Pipeline für `data/book-source/` (AP3)
