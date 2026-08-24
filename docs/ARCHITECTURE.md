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

| Modul             | Aufgabe                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `cli-provider`    | `LLMProvider`-Implementierung: Semaphore, Retry, Transportwahl          |
| `invocation`      | `LlmRequest` → Argumentliste, stdin-Nachricht, Prozess-Environment      |
| `spawn`           | Prozessstart ohne Shell, Timeout, SIGTERM → SIGKILL                     |
| `interpret`       | CLI-Ausgabe → `LlmResponse` oder `LlmError` der Taxonomie               |
| `parse`           | Fence-Stripping, Wrapper-Text, schlanke Schemaprüfung                   |
| `concurrency`     | Semaphore und Backoff mit Streuung                                      |
| `runner`          | Host-Runner (Server) und sein Gegenstück im Container (Client)          |
| `runner-main`     | Einstiegspunkt des Host-Prozesses (`pnpm llm:runner`)                   |
| `base-provider`   | `GuardedProvider`: Semaphore, Retry, Vorprüfung — für **beide** Adapter |
| `api-provider`    | Adapter B gegen die Anthropic Messages API (T2.3)                       |
| `registry`        | Provider-Auswahl aus der Konfiguration — der einzige Zugang             |
| `call-log`        | Protokoll-Dekorator um jeden Adapter, Kürzung und Bild-Vermerk          |
| `log-routes`      | Lesezugriff auf `llm_call_log` für die Oberfläche                       |
| `settings`        | Laufzeit-Einstellungen lesen, prüfen, schreiben                         |
| `settings-routes` | `GET/PUT /api/llm/settings`, `POST /api/llm/settings/ping`              |

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

`apps/backend/src/jobs/` ergänzt das um Queue und Worker:

| Modul                   | Aufgabe                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `queue`                 | Einplanen, atomares Holen, Retry, Dead-Letter, erneut einplanen |
| `worker`                | die Schleife; entscheidet über Retry anhand der Taxonomie       |
| `types`                 | `JobType`, `JobHandlerRegistry`, Payload-Fehler                 |
| `events`                | prozessinterner Ereignisbus für SSE                             |
| `routes`                | `GET /api/jobs/events`, `POST /api/jobs/:id/retry`              |
| `runtime`               | verdrahtet Templates, Provider, Protokoll, Handler und Worker   |
| `handlers/llm-complete` | Referenz-Job-Typ: ein Aufruf über die Provider-Registry         |
| `cli-enqueue`           | `pnpm jobs:enqueue` — Betriebswerkzeug                          |

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

### Prompt-Template-System (neu in T2.4)

Prompts sind versionierte Dateien, keine Inline-Strings. Ablageort:
**`apps/backend/prompts/`**, im Container über `PROMPTS_DIR` auf `/app/prompts`
— dieselbe Mechanik wie bei den Migrationen.

```
apps/backend/prompts/
  partial/    language · data-truth · json-output      ← wiederverwendbare Bausteine
  persona/    teacher · grader · analyst                ← System-Prompts
  task/       concept-explanation                       ← Aufgaben (Beispiel)
```

Ein Task verweist über `system` auf eine Persona; Partials werden **beim
Laden** eingesetzt. Das Rendern ist danach ein einziger literaler Durchlauf:

```
TemplateRegistry.load()          liest Dateien, setzt Partials ein,
        │                        prueft Platzhalter gegen die Deklaration
        ▼
registry.renderRequest(id, werte, {model, maxTokens})
        │
        ▼
LlmRequest  { system aus der Persona, messages aus dem Aufgabenrumpf,
              jsonSchema aus den Kopfdaten }
        │
        ▼
LlmProviderRegistry.getActive().complete(request)
```

Der Aufrufer baut keine Strings mehr zusammen. Golden-Tests unter
`apps/backend/test/prompts/golden/` halten jeden gerenderten Prompt fest;
Details und Begründung in [ADR-0025](./DECISIONS.md).

### Job-Worker, Protokoll und Statuskanal (neu in T2.5)

Lange KI-Aufgaben laufen asynchron. Der Worker ist eine Schleife **im
Backend-Prozess** ([ADR-0026](./DECISIONS.md)) — kein zweiter Container:

```
  HTTP-Request                    pnpm jobs:enqueue
        │                                │
        └──────────► job_queue ◄─────────┘        (Postgres, kein Broker)
                        │
                        │  UPDATE … FOR UPDATE SKIP LOCKED   ← atomar, mehrinstanzfaehig
                        ▼
                   JobWorker  (im Backend-Prozess)
                        │  kennt nur die JobHandlerRegistry
                        ▼
                   Job-Typ "llm.complete"       ← Referenz; AP3/AP4/AP8/AP9 haengen hier an
                        │
        TemplateRegistry ──► LlmProviderRegistry ──► Adapter (cli|api)
                                    │
                                    └─ withCallLog ──► llm_call_log
                        │
                        ▼
                   JobEventBus ──► GET /api/jobs/events (SSE) ──► Einstellungen
```

**Zustände.** `queued → running → done`, bei wiederholbarem Fehler zurück nach
`queued` mit Backoff über `available_at`, sonst `dead` (Dead-Letter mit
gespeichertem `last_error`). `attempts` steigt **beim Holen**, damit ein
Absturz mitzählt; ein Job, der länger als `WORKER_STALE_AFTER_MS` in `running`
hängt, wird wieder aufgenommen ([ADR-0027](./DECISIONS.md)).

**Protokoll.** `withCallLog` sitzt in der Provider-Registry und umfasst jeden
Adapter — kein Aufrufer kann es vergessen. Bilder erscheinen als Kurzvermerk,
lange Inhalte werden sichtbar gekürzt ([ADR-0028](./DECISIONS.md)).

**Statuskanal.** Prozessinterner Ereignisbus → SSE unter
`GET /api/jobs/events`, auth-geschützt wie jede andere Route. Der
Host-Nginx-vhost hat dafür eine eigene `location` ohne Pufferung (siehe
`deploy/nginx/gto.growento.com.conf`); das Einspielen bleibt ein Root-Schritt
des Nutzers.

### Laufzeit-Einstellungen (neu in T2.6)

Provider, Modell, Timeout, Nebenläufigkeit und Versuche liegen in der
`config`-Tabelle und werden über **Einstellungen** gesetzt:

```
Einstellungen-Seite
   │  GET/PUT /api/llm/settings        (auth + CSRF, serverseitig geprüft)
   ▼
config-Tabelle   llm.provider · llm.model · llm.timeout_ms
   │             llm.max_concurrency · llm.max_attempts
   │  je Feld: Tabelle → .env → fester Default
   ▼
LlmProviderRegistry  liest bei JEDEM getActive()
   │  ändert sich ein Wert, der in den Bau des Adapters einfließt,
   │  wird der Adapter verworfen und neu gebaut
   ▼
Adapter (cli|api) → withCallLog → llm_call_log
```

Der **Ping-Test** (`POST /api/llm/settings/ping`) nimmt denselben Weg wie jeder
andere Aufruf; Protokoll und Fehler-Taxonomie greifen dadurch automatisch.
Begründungen in [ADR-0029](./DECISIONS.md).

**Stand nach AP2:** Das LLM-Gateway ist vollständig — zwei Adapter mit
Paritätstests, Registry mit Laufzeitwahl, Template-Registry mit Golden-Tests,
Job-Worker mit Retry und Dead-Letter, zentrales Aufruf-Protokoll, SSE-Statuskanal
und die Einstellungen-Seite mit Testaufruf. Die fachlichen Job-Typen und
Lern-Templates entstehen ab AP3/AP5.

## 3g. Content-Pipeline (neu in AP3.T3.1)

Die Buchquelle wird zur abfragbaren Wissensbasis. Der erste Schritt ist
**deterministisch und ohne jeden KI-Aufruf** — er entscheidet nur, _was_
später überhaupt an ein Modell geht.

```
data/book-source/            (git-ignoriert, vom Nutzer befüllt, nur gelesen)
   │  <buch>.md  +  Bilder pXXXX_YY.jpeg
   ▼
src/book/source.ts           Vorbedingung: Verzeichnis, Markdown, Bilder da?
   │                         Struktur tolerant: flach ODER ein Unterverzeichnis
   │                         fehlt etwas -> BookSourceError, sauberer Abbruch
   ▼
src/book/parser.ts           Inhaltsverzeichnis -> Teile + Kapitel (Soll)
   │                         Fließtext -> Kapitelanker, Sektionen, Seitenmarker
   │                         Bildbezüge -> Assets
   ├── caption.ts            Unterschrift -> Etikett, Nummer, Spot, Prozente
   └── classify.ts           Regeltabelle -> hand_range | table | diagram |
                             formula | other  (+ certain/uncertain)
   ▼
src/book/import.ts           Upsert über fachliche Schlüssel, Hash-Vergleich
   │                         unverändert -> nichts anfassen
   │                         entfallen  -> removed_at, kein DELETE
   ▼
book_chapter -> book_section -> book_asset
   │
   ├── T3.2  Konzepte je Sektion
   ├── T3.3  Vision-Pipeline, gefiltert auf asset_type = 'hand_range'
   └── T3.5  Content-API (Sektionen gezielt, Charts, Asset-Serving)
```

Der **Import-Report** (`src/book/report.ts`) fällt bei jedem Lauf an: Terminal
plus `data/reports/book-import.md`. Er ist git-ignoriert, weil er Kapitel- und
Sektionstitel aus dem Buch enthält.

Zwei Eigenschaften sind für die Folge-APs wesentlich:

- **Der Filter spart Kontingent.** Von 855 Bildern der Quelle sind 348
  Range-Charts. T3.3 verarbeitet nur diese — ohne die Typisierung wären es
  2,5× so viele Vision-Aufrufe.
- **Assets überleben den Re-Import.** `book_asset.id` bleibt stabil, solange
  das Asset in der Quelle steht. Chart-Daten aus T3.3/T3.4 hängen daran und
  gehen bei einem erneuten Buchimport nicht verloren.

## 3h. Konzept-Graph (neu in AP3.T3.2)

Aus den Sektionstexten wird das Rückgrat des Lernpfads. Anders als T3.1 ist
dieser Schritt **KI-gestützt** — aber nur an einer Stelle: Das Modell schlägt
vor, der Code prüft, ordnet ein und räumt auf.

```
book_section (T3.1)
   │  ein Job je Kapitelteil (Zeichenbudget 15 000)
   ▼
jobs/handlers/concept-extract.ts      ← der EINZIGE KI-Anteil
   │  Job-Queue (T2.5) → Provider-Registry (T2.3) → llm_call_log
   │  Template task/concept-taxonomy (T2.4), Persona persona/taxonomist
   ▼
concept/normalize.ts     Themenbereich prüfen · Dubletten über Slug
concept/resolve.ts       Titel → Konzept-IDs · Sektionsschlüssel → Sektions-IDs
concept/graph.ts         Zyklenprüfung · Kanten auswählen
concept/store.ts         schreiben, verknüpfen, Befunde sammeln
   ▼
concept ──< concept_prerequisite   (gerichteter, zyklenfreier Graph)
   ├──< concept_section            → AP5 lädt gezielt den richtigen Buchtext
   └──< concept_chart              → AP5/AP7 verankern Fragen an Charts
   ▼
/api/concepts (Review)  →  Seite „Konzepte" im Frontend
   │  bearbeiten · bestätigen einzeln und je Kapitel
   ▼
state: draft → approved     ← AP4 baut Mastery und Skill-Ratings darauf auf
```

Drei Eigenschaften, auf die sich Folge-APs verlassen können:

- **Ein Themenbereich je Konzept**, aus einer festen Liste von zwölf
  ([ADR-0031](./DECISIONS.md)). Das sind die Achsen des Skill-Ratings in AP4;
  eine Mehrfachzuordnung würde jede Kennzahl unscharf machen.
- **Der Prerequisite-Graph ist jederzeit zyklenfrei.** Eine Kante, die einen
  Zyklus schlösse, wird gar nicht erst gespeichert — weder beim Import noch
  über die Review-Ansicht. Der Konflikt geht trotzdem nicht verloren: Er
  erscheint als Befund.
- **Deterministisches bleibt deterministisch.** Zyklenprüfung,
  Referenzauflösung, Dubletten-Erkennung und Chart-Zuordnung sind Code. Kein
  zweiter Modellaufruf prüft den ersten.

Der Trennstrich zu T3.5: `/api/concepts` ist die **Prüfoberfläche** für die
Vorschläge. Die Content-API für Folge-APs (gezielter Abruf, Spot-Suche,
Asset-Auslieferung) entsteht in T3.5 unter `/api/content`.

## 3i. Chart-Pipeline (neu in AP3.T3.3)

Aus Bildern werden Zahlen. Ab hier sind diese Zahlen die **einzige
Wahrheitsquelle** für jede objektiv prüfbare Frage im Tool — deshalb ist der
Weg dorthin an jeder Stelle belegpflichtig.

```
book_asset  (asset_type = 'hand_range', confidence = 'certain')   ← T3.1
   │  ein Job je Chart, Auswahl ueber selectCandidates()
   ▼
jobs/handlers/chart-digitize.ts            ← der EINZIGE KI-Anteil
   │  Job-Queue (T2.5) → Provider-Registry (T2.3) → llm_call_log
   │  Template task/chart-digitize (T2.4), Persona persona/chart-reader
   │  Nachricht = Aufgabentext + Bildbaustein { type:'image', mediaType, data }
   ├── chart/spot.ts        Caption → Spot und Legende (deterministisch)
   └── chart/store.ts       Matrix pruefen, schreiben, Fortschritt zaehlen
   ▼
range_chart ──< range_chart_cell   (chart, hand, action_kind, sizing, percent)
   │  state: raw
   ▼
T3.4  Validierung  →  validated  →  approved
   ▼
T3.5 Content-API / AP6 Renderer / AP7 Drills / AP8 Analyse
     lesen ausschliesslich `approved`
```

Vier Eigenschaften, auf die sich Folge-APs verlassen können:

- **Vollständigkeit ist erzwungen.** Eine Matrix mit weniger als 169 Zellen,
  einer unbekannten Aktion oder einer Frequenz außerhalb 0–100 wird abgelehnt;
  der Chart landet als `failed` mit Begründung, nicht als stiller Teilerfolg.
- **Zellen sind einzeln abfragbar.** `range_chart_cell` ist eine eigene Tabelle
  mit Index auf `(hand, action_kind)` — die Spot-Suche aus T3.5 und die Drills
  aus AP7 fragen „was macht AJs hier?", ohne das ganze Chart zu laden.
- **Der Spot kommt nicht vom Modell.** Position, Stacktiefe, Aktionsfolge und
  Sizings liest `chart/spot.ts` deterministisch aus der Bildunterschrift. Das
  Modell bekommt sie als Kontext und liest nur die Farben.
- **Wiederaufnahme ist der Normalfall.** Ein zweiter Lauf wählt nur Assets ohne
  Chart-Datensatz. Ein durch ein Wochenlimit gestoppter Lauf setzt fort, wo er
  aufhörte, ohne Kontingent für Erledigtes zu verbrennen.

Vor dem Massenlauf steht der **Kalibrierungslauf** (`pnpm charts:calibrate`,
Scope-Delta 3): dieselbe Stichprobe mit mehreren Modellen, gemessen gegen von
Hand geprüfte Sollwerte. Er schreibt nicht in `range_chart` — er entscheidet
nur die Modellwahl ([ADR-0033](./DECISIONS.md)).

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
- Der Host-seitige CLI-Runner aus [ADR-0022](./DECISIONS.md) läuft außerhalb
  von Compose. Sein Neustart nach einem Reboot ist noch nicht abgesichert
  (siehe `docs/RUNBOOK.md` 9.2).
- Die SSE-`location` im vhost ist vorbereitet, aber wie der ganze vhost noch
  nicht eingespielt (`docs/RUNBOOK.md` 10.4).
- Der SSE-Ereignisbus ist prozessintern; das Gateway setzt damit **eine**
  Backend-Instanz voraus ([ADR-0026](./DECISIONS.md)). Das Job-Claiming selbst
  ist mehrinstanzfähig.
