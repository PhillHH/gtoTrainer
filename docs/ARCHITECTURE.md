# Architektur — GTO Trainer

Stand: AP1.T1.6 (AP1 abgeschlossen). Dieses Dokument wird in jedem Task um
die jeweiligen Deltas fortgeschrieben.

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
├── docker-compose.yml    Compose-Stack (postgres, backend)
├── deploy/               Deploy-, Backup-, Restore-Skripte, Nginx-vhost
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

## 3. Laufzeit-Komponenten (Ist-Stand nach T1.6)

| Komponente | Technik                     | Zustand nach T1.6                                             |
| ---------- | --------------------------- | ------------------------------------------------------------- |
| Backend    | Fastify 5, Node 20, ESM     | `GET /healthz` + Auth-API unter `/api/auth/`, containerisiert |
| Frontend   | React 18, Vite 6, Router 7  | Login, Routing, Sidebar-Shell, Dark Mode, API-Client          |
| Shared     | TypeScript                  | Health- und Auth-Verträge, von beiden Apps genutzt            |
| Datenbank  | Postgres 16 (Compose)       | Läuft, Basisschema migriert (5 Tabellen)                      |
| DB-Zugriff | Drizzle ORM + `pg`-Pool     | Schema, Migration, Seed, Reset                                |
| Auth       | argon2id + DB-Sessions      | Login/Logout/me, CSRF, Rate-Limit, Passwort-CLI               |
| Deployment | Docker Compose + Host-Nginx | Container laufen; vhost/TLS offen (Root nötig)                |
| CI         | GitHub Actions              | lint + test + build + Smoke-E2E                               |

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

## 3d. Deployment-Topologie (neu in T1.5)

```
                    Internet
                       │  :80 / :443
                       ▼
        ┌──────────────────────────────────┐
        │  Host-Nginx  (systemd, root)     │   vhost gto.growento.com
        │  + Certbot                       │   TLS-Terminierung (Stufe B)
        └───────┬───────────────┬──────────┘
                │               │
   statische    │               │  proxy_pass  /api/*, /healthz
   Auslieferung │               ▼
                │        127.0.0.1:3010  (BACKEND_HOST_PORT)
                │               │
                ▼               ▼
   /home/phillip/gto-static   ┌──────────────────────────────┐
   (FRONTEND_STATIC_DIR)      │  Compose-Netz  gto-net        │
   index.html + assets/       │  10.89.0.0/24                 │
   SPA-Fallback via try_files │                               │
                              │  ┌────────────┐               │
                              │  │ gto-backend│ :3000 intern  │
                              │  │ Fastify    │               │
                              │  └─────┬──────┘               │
                              │        │ postgres:5432        │
                              │  ┌─────▼──────┐               │
                              │  │gto-postgres│               │
                              │  └─────┬──────┘               │
                              └────────┼──────────────────────┘
                                       ▼
                                 Volume gto-pgdata
```

### Tatsächlich verwendete Ports

| Was                | Port                         | Bindung     | Öffentlich |
| ------------------ | ---------------------------- | ----------- | ---------- |
| Host-Nginx         | 80, 443                      | `0.0.0.0`   | **ja**     |
| Backend-Container  | `BACKEND_HOST_PORT` = 3010   | `127.0.0.1` | nein       |
| Backend intern     | 3000                         | Container   | nein       |
| Postgres-Container | `POSTGRES_HOST_PORT` = 55434 | `127.0.0.1` | nein       |
| Postgres intern    | 5432                         | Container   | nein       |

Begründung der Portwahl und der Loopback-Bindung: [ADR-0018](./DECISIONS.md).

### Was wo läuft

| Bestandteil        | Form                                  | Datei                                  |
| ------------------ | ------------------------------------- | -------------------------------------- |
| Backend            | Container (`gto-backend`)             | `apps/backend/Dockerfile`              |
| Datenbank          | Container (`gto-postgres`)            | `docker-compose.yml`                   |
| Frontend           | **statische Dateien**, kein Container | `apps/frontend/Dockerfile` (nur Build) |
| Reverse Proxy, TLS | Host-Nginx + Certbot                  | `deploy/nginx/gto.growento.com.conf`   |

Das Frontend läuft bewusst **nicht** als Container: Der Host-Nginx liefert die
gebauten Assets direkt aus, damit kein zweiter nginx bzw. Reverse Proxy
entsteht ([ADR-0016](./DECISIONS.md)).

### Deploy-Ablauf

`deploy/deploy.sh` — idempotent, bricht bei jedem Fehler ab:

```
git pull --ff-only
  → docker compose build backend
  → Frontend-Assets bauen und exportieren
  → docker compose up -d postgres   (auf healthy warten)
  → Migrationen als EINMALIGER Schritt (ADR-0017)
  → docker compose up -d --force-recreate backend
  → Assets per Verzeichnistausch veröffentlichen
  → Healthcheck gegen /healthz
```

Der Host-Nginx wird dabei **nicht** angefasst — sein vhost ist eine einmalige,
root-pflichtige Einrichtung (siehe `docs/RUNBOOK.md`, Abschnitt 8).

### Sicherung

`deploy/backup.sh` erzeugt `pg_dump` (gzip) und ein Archiv von `data/` mit
Zeitstempel in `BACKUP_DIR` (außerhalb des Repos), mit Rotation über
`BACKUP_KEEP`. `deploy/restore.sh` spielt eine Sicherung standardmäßig in die
**separate** Prüfdatenbank `gto_restore_check` ein — die produktive Datenbank
wird nur mit ausdrücklichem `RESTORE_CONFIRM=yes` überschrieben.

## 3e. Qualitätsschranke (neu in T1.6)

```
Push auf main / Pull Request
        │
        ▼
GitHub Actions  .github/workflows/ci.yml
  ┌──────────────────────────────────────────────┐
  │ Job "quality"   (Service: postgres:16-alpine)│
  │   install → lint → migrate → test → build    │
  └───────────────────┬──────────────────────────┘
                      │ needs
  ┌───────────────────▼──────────────────────────┐
  │ Job "e2e"       (Service: postgres:16-alpine)│
  │   Playwright startet Backend + Frontend      │
  │   selbst und prüft: Login → Dashboard        │
  └──────────────────────────────────────────────┘
```

Der E2E-Lauf nutzt eigene Ports (`E2E_BACKEND_PORT` 3020,
`E2E_FRONTEND_PORT` 5180), damit er weder das laufende Deployment (3010) noch
den Dev-Server (5174) stört. Begründungen: [ADR-0019](./DECISIONS.md),
[ADR-0020](./DECISIONS.md).

## 3f. LLM-Gateway (neu in AP2.T2.1 — bisher nur Vertrag)

Der **einzige** KI-Zugang des Systems. Fachliche Komponenten rufen nie eine
CLI und nie die Anthropic-API direkt auf, sondern ausschließlich `LLMProvider`
aus `packages/shared`.

```
AP3 Vision · AP4 Reports · AP5 Didaktik · AP8 Analyse · AP9 Material
        │  (nur dieser Weg ist erlaubt)
        ▼
LlmProviderRegistry        apps/backend/src/llm/registry.ts  ← einziger Zugang
        │   liest llm.provider aus der config-Tabelle,
        │   Startwert LLM_PROVIDER, sonst "cli"
        ▼
   LLMProvider             packages/shared/src/llm.ts  ← Vertrag, AP2.T2.1
        │
   GuardedProvider         Semaphore · Retry · Vorpruefung (fuer beide gleich)
        │
   ┌────┴─────────────────────────┐
   ▼                              ▼
Adapter "cli"  (T2.2)      Adapter "api"  (T2.3)
   │                              │
   │ Unix-Domain-Socket           │ HTTPS, @anthropic-ai/sdk
   │ (Bind-Mount, ADR-0022)       ▼
   ▼                        api.anthropic.com
── Containergrenze ──────────────────────────────
CLI-Runner auf dem Host (Benutzer phillip)
   └─ claude -p …  mit CLAUDE_CONFIG_DIR=/home/phillip/.claude-b
```

**Container-zu-Host-Weg:** Das Backend läuft im Container, die Claude CLI und
Profil B liegen auf dem Host. Die CLI wird **nicht** ins Backend-Image
aufgenommen und Profil B **nicht** in den Container gemountet; der Container
spricht einen Host-seitigen Runner über einen Unix-Domain-Socket an, der als
einziges Verzeichnis eingebunden wird ([ADR-0022](./DECISIONS.md)). Damit sieht
der Container die Subscription-Zugangsdaten nie. Die Aufrufform der CLI —
`-p` mit `--output-format json`, für Bild-Input `--input-format stream-json` —
steht in [ADR-0021](./DECISIONS.md).

### CLI-Adapter (neu in T2.2)

`apps/backend/src/llm/` implementiert Adapter „cli". Aufbau:

| Modul           | Aufgabe                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `cli-provider`  | `LLMProvider`-Implementierung: Semaphore, Retry, Transportwahl          |
| `invocation`    | `LlmRequest` → Argumentliste, stdin-Nachricht, Prozess-Environment      |
| `spawn`         | Prozessstart ohne Shell, Timeout, SIGTERM → SIGKILL                     |
| `interpret`     | CLI-Ausgabe → `LlmResponse` oder `LlmError` der Taxonomie               |
| `parse`         | Fence-Stripping, Wrapper-Text, schlanke Schemaprüfung                   |
| `concurrency`   | Semaphore und Backoff mit Streuung                                      |
| `runner`        | Host-Runner (Server) und sein Gegenstück im Container (Client)          |
| `runner-main`   | Einstiegspunkt des Host-Prozesses (`pnpm llm:runner`)                   |
| `base-provider` | `GuardedProvider`: Semaphore, Retry, Vorprüfung — für **beide** Adapter |
| `api-provider`  | Adapter B gegen die Anthropic Messages API (T2.3)                       |
| `registry`      | Provider-Auswahl aus der Konfiguration — der einzige Zugang             |

Der Aufrufweg ist **einer**, nur der Transport unterscheidet sich — und der
kommt aus der Konfiguration, nicht aus einer Code-Verzweigung:

```
LLM_TRANSPORT=direct                      LLM_TRANSPORT=socket  (Container)
  cli-provider                              cli-provider
    └─ spawn ── claude -p …                   └─ runner-client ──┐
                                                                  │ /run/gto-llm/gto-llm.sock (ro)
                                          ── Containergrenze ─────┼──────────────
                                                                  │
                                             runner-main (Host)  ─┘
                                               └─ spawn ── claude -p …
```

Beide Wege münden in dasselbe Rohergebnis und werden von demselben Code
ausgewertet. Der Runner setzt `CLAUDE_CONFIG_DIR` selbst; im Container ist die
Variable **nicht** gesetzt und das Profil-B-Verzeichnis **nicht** gemountet.

**Aufrufform** (ADR-0021, präzisiert in ADR-0023): `claude -p --model …
--system-prompt … --tools "" --input-format stream-json --output-format
stream-json --verbose [--json-schema …]`, Prompt über stdin. Der Kindprozess
erhält ein Environment aus genau vier Variablen — `ANTHROPIC_API_KEY` ist
bewusst nicht darunter.

### API-Adapter und Registry (neu in T2.3)

Adapter B spricht die Anthropic Messages API über das offizielle SDK
([ADR-0024](./DECISIONS.md)); der SDK-eigene Retry ist abgeschaltet, damit
`GuardedProvider` die einzige Wiederholungslogik bleibt. Strukturierte
Ausgaben laufen über `output_config.format`, ausgewertet mit denselben
Funktionen wie beim CLI-Adapter — deshalb ergibt dieselbe Eingabe bei beiden
Adaptern dieselbe Antwortform und dieselbe Fehlerkategorie.

Die Umschaltung ist reine Konfiguration:

```
config-Tabelle  llm.provider = 'api'   ← Laufzeit (T2.6: Settings-UI)
        ↓ (fehlt / null)
Umgebung        LLM_PROVIDER=cli       ← Startwert
        ↓ (fehlt)
Default         'cli'
```

Die Tabelle wird bei jedem Aufruf gelesen: Eine Umschaltung wirkt ab dem
nächsten Aufruf, ohne Neustart. Ein unbekannter Wert ist ein Fehler mit klarer
Meldung, kein stiller Default.

**Stand nach T2.3:** Beide Adapter sind gebaut, durch eine gemeinsame
Paritätssuite abgesichert und über die Registry umschaltbar — aber noch
**nicht** an Job-Verarbeitung, `llm_call_log` oder UI angebunden. Das folgt in
T2.5/T2.6.

## 4. Querschnitts-Entscheidungen

- **Node 20.19.6**, fixiert in `.nvmrc`; `engines.node >= 20.19.0`.
- **pnpm Workspaces** als Monorepo-Mechanik, Version über `packageManager`
  (Corepack) gepinnt.
- **TypeScript strikt** — `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride` in `tsconfig.base.json`, von allen Workspaces geerbt.
- **ESM durchgehend** (`"type": "module"`), relative Importe mit `.js`-Endung.

Begründungen siehe [DECISIONS.md](./DECISIONS.md).

## 5. Offene Architektur-Punkte

- Host-Nginx-vhost und TLS sind vorbereitet, aber noch nicht eingespielt —
  beides erfordert Root auf dem Host (siehe `docs/status/AP01.md`).
- Ingestion-Pipeline für `data/book-source/` (AP3)
- Der Host-seitige CLI-Runner aus [ADR-0022](./DECISIONS.md) läuft außerhalb
  von Compose. Sein Neustart nach einem Reboot ist noch nicht abgesichert
  (siehe `docs/RUNBOOK.md` 9.2).
