# Architecture Decision Records (ADR)

Kurzformat. Jeder Eintrag: **Nr., Datum, Entscheidung, Begründung, Alternativen.**

> **Regel:** Keine neue Dependency ohne Eintrag in diesem Dokument
> (siehe [AGENT_GUIDE.md](./AGENT_GUIDE.md)).

---

## ADR-0001 — Monorepo-Setup und Basis-Toolchain

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP1.T1.1 — leeres Repository soll zu einem lint- und testbaren
  Projektgerüst mit Backend, Frontend und geteiltem Vertragsort werden.

### Entscheidung

Ein **pnpm-Workspace-Monorepo** mit drei Workspaces:

| Workspace         | Paket           | Stack                           |
| ----------------- | --------------- | ------------------------------- |
| `apps/backend`    | `@gto/backend`  | Fastify 5 + TypeScript (ESM)    |
| `apps/frontend`   | `@gto/frontend` | React 18 + Vite 6 + TypeScript  |
| `packages/shared` | `@gto/shared`   | TypeScript, gemeinsame Verträge |

Toolchain: **TypeScript 5 strikt** (`strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`) über eine Basis-`tsconfig.base.json` an der Wurzel;
**ESLint 9 Flat Config** monorepo-weit, kombiniert mit **Prettier 3** über
`eslint-config-prettier`; **Vitest 2** als Test-Runner in `apps/backend` und
`packages/shared`. Node-Version **20.19.6**, fixiert in `.nvmrc`.

### Begründung

- **pnpm statt npm/yarn:** Workspaces sind eingebaut, das Content-Addressable
  Store spart Plattenplatz, und `workspace:*`-Protokoll macht interne
  Abhängigkeiten explizit. Version wird über `packageManager` (Corepack)
  gepinnt, damit alle Umgebungen identisch auflösen.
- **Monorepo statt getrennter Repos:** Backend und Frontend teilen sich
  Typverträge (`packages/shared`). Getrennte Repos würden Versionierung und
  Release-Koordination für diese Verträge erzwingen — unangemessener Aufwand
  für ein Projekt dieser Größe.
- **Fastify statt Express:** Erstklassige TypeScript-Typen, eingebautes
  Schema-/Serialisierungs-Konzept und `app.inject()` für Tests ohne echten
  Port. Express bräuchte für dasselbe zusätzliche Pakete (`@types/express`,
  `supertest`).
- **Vite statt CRA/Webpack:** CRA ist unmaintained; Vite liefert schnellen
  Dev-Server und eine schlanke Produktions-Build-Pipeline ohne eigene
  Webpack-Konfiguration.
- **ESLint + Prettier via `eslint-config-prettier`:** Klare Trennung — ESLint
  prüft Code-Qualität, Prettier formatiert. Der Config schaltet alle
  formatierungsbezogenen ESLint-Regeln ab, damit sich beide nicht widersprechen.
- **Vitest statt Jest:** Nutzt dieselbe Vite-/esbuild-Transformation wie das
  Frontend, läuft ohne zusätzliche ESM-/TS-Konfiguration und ist im Monorepo
  nur einmal zu konfigurieren.
- **Strikte TS-Flags von Beginn an:** Nachträgliches Verschärfen von
  `noUncheckedIndexedAccess` in gewachsenem Code ist teuer; zu Projektbeginn
  kostenlos.

### Alternativen (verworfen)

- **npm workspaces** — funktioniert, aber langsamere Installationen und kein
  striktes `node_modules`-Layout; Phantom-Dependencies bleiben möglich.
- **Turborepo / Nx** — leistungsfähiges Task-Caching, aber zusätzliche
  Abstraktion und Konfiguration. Bei drei Workspaces reicht `pnpm -r`.
- **Ein einzelnes Paket ohne Workspaces** — hätte den Vertragsort
  `packages/shared` unmöglich gemacht bzw. zu Import-Pfaden über
  Verzeichnisgrenzen geführt.
- **Jest** — hätte `ts-jest`/Babel-Konfiguration und eine zweite
  Transform-Pipeline neben Vite bedeutet.
- **Biome statt ESLint+Prettier** — schneller und ein Tool weniger, aber
  geringere Regel- und Plugin-Abdeckung für TypeScript-spezifische Regeln.

### Konsequenzen

- Entwickler brauchen Node ≥ 20.19 und Corepack-aktiviertes pnpm.
- Interne Importe laufen über Paketnamen (`@gto/shared`), nicht über relative
  Pfade zwischen Workspaces.
- `pnpm build` muss `packages/shared` vor `apps/backend` bauen — das erledigt
  pnpm über die topologische Reihenfolge, ergänzt um TS-Project-References.

---

## ADR-0002 — `data/book-source/` als git-ignorierter Pflicht-Input

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP3 liest Buchinhalte (Markdown + Chart-Bilder) ein. Diese Quelle
  ist urheberrechtlich geschützt und darf nicht ins Repository.

### Entscheidung

Das Verzeichnis `data/book-source/` ist der verbindliche Ablageort. Sein Inhalt
ist git-ignoriert (`data/book-source/*`), ausgenommen die versionierte
`data/book-source/README.md`, die Dateinamenskonvention
(`pXXXX_YY.jpeg`) und Struktur dokumentiert.

### Begründung

Der Pfad ist damit ab AP1 stabil und dokumentiert, ohne dass Daten im Repo
landen. Die versionierte README stellt sicher, dass die Konvention auch dann
existiert, wenn das Verzeichnis leer ist — Git kann leere Verzeichnisse nicht
abbilden.

### Alternativen (verworfen)

- **Daten mit Git LFS versionieren** — löst das Lizenzproblem nicht.
- **Pfad erst in AP3 festlegen** — hätte AP1/AP2 ohne Andockpunkt gelassen und
  die Konvention in einen Task verschoben, der bereits Fachlogik baut.
- **`.gitkeep` statt README** — hätte den Ordner erhalten, aber die
  Namenskonvention nirgends festgehalten.

---

## ADR-0003 — Frontend ohne TS-Project-Reference

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** `tsc -b` im Frontend erzeugte Emit-Artefakte, die ESLint erneut
  prüfte und dabei fehlschlug (DOM-Globals, `import()`-Typen in `.d.ts`).

### Entscheidung

`apps/frontend` ist kein `composite`-Projekt. Typprüfung erfolgt mit
`tsc --noEmit`, das Bundling ausschließlich durch Vite.

### Begründung

Das Frontend ist ein Blatt im Abhängigkeitsgraphen — niemand konsumiert seine
Deklarationen. Emit ist dort überflüssig und erzeugte nur Artefakte, die
gesondert von Lint und Git ausgeschlossen werden müssten.

### Alternativen (verworfen)

- **`dist-tsc/` in `.eslintignore` und `.gitignore` aufnehmen** — hätte das
  Symptom kaschiert und totes Emit-Verzeichnis erhalten.

---

## ADR-0004 — Drizzle ORM als ORM- und Migrations-Werkzeug

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP1.T1.2 verlangt eine Entscheidung zwischen **Drizzle ORM** und
  **Prisma** für Datenzugriff und Migrationen. Die Wahl ist laut Arbeitspaket
  **bindend für alle Folge-APs**.

### Entscheidung

**Drizzle ORM** (`drizzle-orm`) mit `drizzle-kit` für die Migrations-Generierung
und `pg` (node-postgres) als Treiber.

Neue Dependencies in `apps/backend`:

| Paket         | Art  | Zweck                                    |
| ------------- | ---- | ---------------------------------------- |
| `drizzle-orm` | prod | Schema-Definition und typisierte Queries |
| `pg`          | prod | Postgres-Treiber inkl. Connection-Pool   |
| `drizzle-kit` | dev  | Erzeugt SQL-Migrationen aus dem Schema   |
| `@types/pg`   | dev  | Typen für `pg`                           |

### Abwägung der geforderten Kriterien

| Kriterium                    | Drizzle                                                                                     | Prisma                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **TypeScript-Integration**   | Schema **ist** TypeScript; Typen werden direkt daraus abgeleitet, kein Generierungsschritt  | Eigene DSL (`schema.prisma`); Typen entstehen erst durch `prisma generate` — ein Schritt, der veralten kann |
| **Migrations-Handling**      | `drizzle-kit generate` schreibt lesbares SQL, das im Repo liegt und von Hand editierbar ist | Ebenfalls SQL-Dateien, aber eng an den Prisma-Migrations-Zustand gebunden                                   |
| **Kontrolle über rohes SQL** | Erstklassig: `sql`-Template beliebig mit typisierten Queries mischbar                       | Nur über `$queryRaw`, außerhalb des Typsystems                                                              |
| **Gewicht/Dependencies**     | Reine TS-Bibliothek, kein Binary                                                            | Lädt eine plattformspezifische Query-Engine (Binary, ~15–20 MB) — spürbar in Image und Install              |
| **Single-User-Projekt**      | Passt: wenig Abstraktion, direkter SQL-Bezug, leicht zu überschauen                         | Bringt Studio, Client-Generierung und Engine-Lifecycle mit — Funktionsumfang, der hier ungenutzt bleibt     |

### Begründung

Ausschlaggebend war die Kombination aus **kein Generierungsschritt** und
**voller SQL-Kontrolle**. Das Projekt braucht in späteren APs eigenes SQL
(Job-Claiming mit `FOR UPDATE SKIP LOCKED`, JSONB-Abfragen, Volltextsuche über
die Buchinhalte). Bei Drizzle bleibt das im selben Typsystem; bei Prisma fiele
es in `$queryRaw` und damit aus der Typsicherheit heraus. Dazu kommt das
geringere Gewicht: keine Query-Engine-Binary, die in T1.5 mit ins Container-Image
müsste.

### Alternative (verworfen)

**Prisma** — ausgereiftes Tooling, sehr gute Developer Experience, Prisma Studio
als Datenbrowser. Verworfen, weil die Engine-Binary das Deployment beschwert,
die Schema-DSL einen zusätzlichen Generierungsschritt erzwingt und rohes SQL
aus dem Typsystem herausfällt. Für ein Single-User-Projekt mit SQL-nahen
Anforderungen überwiegt der Zusatzaufwand den Nutzen.

### Konsequenzen

- Das Schema lebt in `apps/backend/src/db/schema.ts` und ist die einzige Quelle
  der Wahrheit.
- Migrationen werden **zur Entwicklungszeit** mit `pnpm db:generate` erzeugt und
  als SQL unter `apps/backend/drizzle/` versioniert. Zur Laufzeit wird nichts
  generiert — `pnpm db:migrate` spielt nur vorhandene Dateien ein.
- `pg.Pool` ist der Connection-Pool; Shutdown-Handling liegt in
  `apps/backend/src/db/client.ts`.

---

## ADR-0005 — Postgres-Host-Port konfigurierbar, Default 55434

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Auf dem Zielhost laufen bereits fremde Dienste. Port **5432 ist
  belegt** (fremde Postgres-Instanz), ebenso **55432** und **55433** (weitere
  Projekte). Port 3000 ist laut AP1.T1.1-Bericht ebenfalls belegt.

### Entscheidung

Der Host-Port des Postgres-Containers kommt aus **`POSTGRES_HOST_PORT`** und ist
nirgends hart verdrahtet. Default ist **55434** (zum Zeitpunkt der Einrichtung
nachweislich frei). Das Mapping bindet zusätzlich auf **`127.0.0.1`**, nicht auf
`0.0.0.0`.

### Begründung

Ein fest verdrahteter Port würde beim Start entweder fehlschlagen oder — schlimmer
— mit einer fremden Instanz kollidieren. Die Bindung an `127.0.0.1` verhindert,
dass die Entwicklungsdatenbank vom Internet aus erreichbar ist; der Host ist
öffentlich adressierbar. Auch das Backend läuft auf **3001** statt 3000, weil
3000 belegt ist.

### Alternative (verworfen)

- **Fester Port 5432** — kollidiert sofort mit der vorhandenen Instanz.
- **Ganz ohne Port-Mapping (nur Compose-intern)** — hätte in T1.2 funktioniert,
  aber Migrationen, Seed und Tests laufen hier noch außerhalb von Compose auf dem
  Host und brauchen einen erreichbaren Port.

---

## ADR-0006 — Explizites Docker-Subnetz für das Compose-Netzwerk

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** `docker compose up` scheiterte auf dem Zielhost mit
  `all predefined address pools have been fully subnetted`. Die 33 bereits
  vorhandenen Netzwerke fremder Projekte belegen Dockers vordefinierte Pools
  (`172.17.0.0/16`–`172.31.0.0/16` sowie `192.168.0.0/16` in /20-Blöcken)
  vollständig.

### Entscheidung

Das Compose-Netzwerk `gto-net` bekommt ein **explizites Subnetz** aus
`DOCKER_SUBNET`, Default **`10.89.0.0/24`** — außerhalb der Docker-Standardpools
und auf dem Host frei (geprüft via `ip route`).

### Begründung

Das Problem ließ sich nur an drei Stellen lösen: Daemon-Konfiguration,
Aufräumen fremder Netzwerke, oder ein eigenes Subnetz. Die ersten beiden greifen
in fremde Projekte ein — laut Leitplanke des Arbeitspakets ausgeschlossen. Ein
explizites Subnetz betrifft ausschließlich dieses Projekt und ist zudem
selbstdokumentierend.

### Alternativen (verworfen)

- **`default-address-pools` in `/etc/docker/daemon.json` erweitern** — wirkt
  global, erfordert einen Daemon-Neustart und damit einen Neustart **aller**
  fremden Container auf dem Host.
- **`docker network prune`** — würde Netzwerke fremder, gestoppter Projekte
  löschen.
- **`network_mode: bridge`** — umgeht das Problem, verhindert aber die
  Service-zu-Service-Auflösung per Name, die in T1.5 für Backend↔Postgres
  gebraucht wird.

---

## ADR-0007 — argon2id als Passwort-Hash mit OWASP-Parametern

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP1.T1.3 verlangt Passwort-Hashing mit argon2. Die Parameter
  (Memory, Iterationen, Parallelität) sind bewusst zu wählen und zu begründen.

### Entscheidung

**argon2id** über das Paket **`@node-rs/argon2`** mit:

| Parameter                | Wert               |
| ------------------------ | ------------------ |
| Algorithmus              | argon2id           |
| `memoryCost`             | 19456 KiB (19 MiB) |
| `timeCost` (Iterationen) | 2                  |
| `parallelism`            | 1                  |

Mindestlänge für Passwörter: **12 Zeichen**.

### Begründung

- **argon2id statt argon2i/argon2d:** Die Hybridvariante ist gegen
  Seitenkanal- **und** GPU-/ASIC-Angriffe abgesichert und ist die von OWASP
  und RFC 9106 empfohlene Standardwahl.
- **19 MiB / t=2 / p=1:** exakt eine der im OWASP Password Storage Cheat Sheet
  genannten Konfigurationen. Höherer Speicher (z. B. 64 MiB) wäre stärker, aber
  der Host teilt sich RAM mit über 30 fremden Containern — ein Login darf dort
  keine dreistelligen MB-Beträge belegen. `p=1`, weil Parallelität auf einem
  geteilten Host keinen echten Gewinn bringt.
- **`@node-rs/argon2` statt `argon2`:** liefert vorkompilierte Binaries per
  napi-rs. Das Paket `argon2` braucht auf vielen Systemen `node-gyp` und eine
  Build-Toolchain — im Container-Build (T1.5) wäre das zusätzlicher Ballast.

### Timing-Gleichheit

`verifyPassword(undefined, …)` verifiziert gegen einen zwischengespeicherten
**Dummy-Hash**. Ohne das wäre die Antwort bei unbekanntem Benutzer messbar
schneller als bei falschem Passwort und würde die Existenz eines Kontos
verraten. Der Dummy wird verzögert erzeugt und gecacht, damit die ~30 ms nicht
bei jedem Fehlversuch erneut anfallen.

### Alternativen (verworfen)

- **bcrypt** — weit verbreitet, aber auf 72 Byte begrenzt und ohne
  Speicherhärte; gegen GPU-Angriffe deutlich schwächer.
- **scrypt aus `node:crypto`** — dependency-frei und speicherhart, aber der
  Kanon nennt argon2 ausdrücklich.
- **Höhere Parameter (64 MiB, t=3)** — sicherer, aber auf diesem geteilten Host
  unverhältnismäßig.

---

## ADR-0008 — Session-Token gehasht speichern, Cookie-Attribute

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Das Session-Cookie ist der Zugangsschlüssel zur gesamten
  Anwendung. Die `session`-Tabelle aus T1.2 hatte eine Spalte `token`.

### Entscheidung

1. Der Token besteht aus **32 Byte** (256 Bit) aus `crypto.randomBytes`,
   base64url-kodiert.
2. In der Datenbank steht ausschließlich der **SHA-256-Hash** des Tokens. Die
   Spalte heißt deshalb jetzt **`token_hash`** (Migration `0001`, siehe unten).
3. Cookie-Attribute:

| Attribut   | Wert                                                   | Grund                                                                                                                                             |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HttpOnly` | immer an                                               | Kein Zugriff aus JavaScript → XSS kann den Token nicht auslesen                                                                                   |
| `SameSite` | `Lax` (Default), `strict` möglich                      | `Lax` erlaubt normale Navigation zur App; `Strict` bräche Links von außen ohne Sicherheitsgewinn, da CSRF bereits per Double-Submit abgedeckt ist |
| `Secure`   | `COOKIE_SECURE`, Default = `NODE_ENV === 'production'` | Hinter dem Host-Nginx läuft TLS; lokal ohne HTTPS würde der Browser ein `Secure`-Cookie verwerfen und Entwicklung unmöglich machen                |
| `Path`     | `/`                                                    | Gilt für API und spätere Frontend-Routen                                                                                                          |
| `Expires`  | `SESSION_TTL_HOURS`, Default 168 h                     | Serverseitig zusätzlich über `expires_at` geprüft — ein manipuliertes Cookie verlängert nichts                                                    |

### Begründung für SHA-256 statt argon2 beim Token

Der Token ist bereits **hochentropischer Zufall** (256 Bit) — es gibt nichts zu
erraten, ein Brute-Force über den Hash ist praktisch ausgeschlossen. Ein
langsamer Passwort-Hash würde bei **jedem** Request anfallen und die API
spürbar bremsen, ohne Sicherheitsgewinn. Anders als bei Passwörtern gibt es
hier auch kein Wörterbuch-Problem.

### Schemaänderung

Die Leitplanke des Tasks erlaubt Schemaänderungen, wenn sie nötig sind, als
**neue** Migration. Die Spalte `session.token` wurde deshalb per Migration
`0001_wild_blue_marvel.sql` (`ALTER TABLE … RENAME COLUMN`) zu `token_hash`
umbenannt. Grund: Eine Spalte namens `token`, die in Wahrheit einen Hash
enthält, lädt Folge-APs zu einem gefährlichen Fehlschluss ein. Die Migration
aus T1.2 blieb unverändert; die Tabelle war fachlich noch ungenutzt.

### Alternativen (verworfen)

- **Token im Klartext speichern** — ein Datenbank-Leak (Backup, `pg_dump`,
  SQL-Injection) erlaubte sofortige Übernahme aller laufenden Sessions.
- **Signierte, zustandslose Tokens (JWT)** — kein serverseitiges Invalidieren
  ohne Sperrliste; genau das braucht Logout und die Passwortänderung.
- **`SameSite=Strict`** — würde bei jedem Aufruf aus einer externen Quelle
  abmelden, ohne zusätzlichen Schutz gegenüber der bestehenden CSRF-Lösung.

---

## ADR-0009 — CSRF-Schutz per Double-Submit-Cookie plus Origin-Prüfung

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Die Session liegt in einem Cookie und wird vom Browser bei jedem
  Request automatisch mitgeschickt — auch bei Requests, die eine fremde Seite
  auslöst. Zustandsändernde Requests brauchen deshalb einen zweiten Nachweis.

### Entscheidung

**Double-Submit-Cookie**, kombiniert mit einer **Origin-/Referer-Prüfung**.

Ablauf für das Frontend (T1.4):

1. `GET /api/auth/csrf` aufrufen. Der Server setzt das Cookie **`gto_csrf`**
   (bewusst **nicht** `HttpOnly`) und liefert denselben Wert im Body als
   `{ "csrfToken": "…" }`.
2. Bei **jedem** `POST`/`PUT`/`PATCH`/`DELETE` den Wert im Header
   **`x-csrf-token`** mitschicken.
3. Der Server vergleicht Cookie und Header in konstanter Zeit. Bei Abweichung:
   **403** mit `{ "error": "csrf_failed" }`.

Der Vergleich läuft als globaler `onRequest`-Hook — er greift für jede
zustandsändernde Route, auch für künftige. Eine neue Route kann den Schutz also
nicht versehentlich umgehen.

### Begründung

- **Warum das trägt:** Eine fremde Seite kann das Cookie zwar mitschicken
  lassen, es aber wegen der Same-Origin-Policy nicht **auslesen** und damit
  nicht in den Header spiegeln.
- **Kein `HttpOnly` auf dem CSRF-Cookie:** Das ist Absicht und kein Widerspruch
  — der Wert ist kein Geheimnis, sondern nur der Nachweis, dass der Request von
  der eigenen Seite stammt. Der eigentliche Zugangsschlüssel (`gto_session`)
  bleibt `HttpOnly`.
- **Zusätzliche Origin-Prüfung:** greift, wenn `ALLOWED_ORIGINS` gesetzt ist.
  Fehlen `Origin` und `Referer` ganz (curl, Tests, Server-zu-Server), wird
  durchgelassen — der Double-Submit-Token trägt dort die Absicherung.
- **Token-Rotation nach dem Login:** verhindert Session-Fixation über ein
  vorab untergeschobenes CSRF-Cookie.

### Alternativen (verworfen)

- **`@fastify/csrf-protection`** — zusätzliche Dependency für ~60 Zeilen
  nachvollziehbaren Code; das Double-Submit-Verfahren ist hier vollständig
  überschaubar.
- **Nur Origin-/Referer-Prüfung** — scheitert bei Clients, die keinen Origin
  senden, und lässt sich in manchen Konstellationen umgehen.
- **`SameSite=Strict` allein** — kein Schutz in älteren Browsern und bricht
  legitime Navigation von außen.

---

## ADR-0010 — Eigener Login-Rate-Limiter statt Plugin

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Der Login-Endpunkt braucht ein Limit gegen das Durchprobieren
  von Passwörtern. Die Anforderung lautet ausdrücklich: **erfolgreiche Logins
  dürfen nicht unnötig blockiert werden.**

### Entscheidung

Ein eigener, in-memory `LoginRateLimiter` (`src/auth/rate-limit.ts`, ~90
Zeilen). Gezählt werden **ausschließlich Fehlversuche**, der Schlüssel ist
`IP|benutzername`. Nach erfolgreichem Login wird der Zähler zurückgesetzt.
Defaults: **5 Fehlversuche je 15 Minuten**, konfigurierbar über
`LOGIN_RATE_LIMIT_MAX_ATTEMPTS` und `LOGIN_RATE_LIMIT_WINDOW_MINUTES`.
Bei Überschreitung: **429** mit `Retry-After`, ohne Hinweis darauf, ob das
Konto existiert.

### Begründung

- `@fastify/rate-limit` zählt **jeden** Request, nicht nur gescheiterte. Ein
  Benutzer, der sich mehrfach korrekt anmeldet, liefe dort ins Limit — genau
  das schließt die Anforderung aus. Man kann das mit eigenem Store nachbauen,
  dann bleibt vom Plugin aber kaum noch etwas übrig.
- Der zusammengesetzte Schlüssel bremst beides: Angriffe von einer IP über
  viele Benutzernamen und Angriffe auf ein Konto von wechselnden IPs.
- Prozessspeicher genügt: ein Single-User-Dienst mit einer Backend-Instanz.

### Alternativen (verworfen)

- **`@fastify/rate-limit`** — siehe oben; passt nicht zur Fehlversuch-Semantik.
- **Zähler in der `config`- oder einer eigenen Tabelle** — überlebt Neustarts,
  kostet aber bei jedem Login einen Schreibvorgang. Bei mehreren
  Backend-Instanzen (heute nicht absehbar) wäre das der nächste Schritt.

### Konsequenz

Ein Neustart des Backends leert die Zähler. Für einen Angreifer ist das kein
brauchbarer Hebel — er kann den Neustart nicht auslösen.

---

## ADR-0011 — React Router als Routing-Bibliothek

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP1.T1.4 braucht öffentliche und geschützte Routen, einen
  Guard an genau einer Stelle und eine 404-Route.

### Entscheidung

**`react-router-dom` v7** im Deklarativ-Modus (`<BrowserRouter>` +
`<Routes>`). Geschützte Seiten hängen als Kind-Routen unter einer einzigen
`<RequireAuth>`-Route.

### Begründung

- Der Guard lässt sich als **Layout-Route** ausdrücken (`<Route element={<RequireAuth />}>`).
  Damit gibt es genau eine Stelle, die über Zugriff entscheidet — neue Seiten
  erben den Schutz automatisch, statt ihn selbst mitzubringen.
- `<Navigate state={{ from }}>` und `useLocation()` liefern das Zurückspringen
  auf das ursprünglich angefragte Ziel ohne Eigenbau.
- `NavLink` bringt den Aktiv-Zustand der Seitenleiste mit.
- De-facto-Standard im React-Umfeld; kein exotisches Wissen nötig.

### Alternativen (verworfen)

- **Eigenes Routing über `history`/`useState`** — für fünf Routen machbar, aber
  Verschachtelung, Guard und „zurück zum Ziel" wären Eigenbau mit eigenen
  Fehlern.
- **TanStack Router** — stärkere Typisierung, aber deutlich mehr Konzept für
  eine Shell dieser Größe.
- **Data-Router (`createBrowserRouter` + Loader)** — Loader-basiertes Laden
  lohnt erst, wenn Seiten echte Daten holen. Das kommt ab AP4; der Wechsel ist
  dann lokal begrenzt möglich.

---

## ADR-0012 — Auth-Zustand über React Context statt State-Bibliothek

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Der Anmeldestatus muss an genau einer Stelle liegen, ohne
  Duplikate in einzelnen Komponenten.

### Entscheidung

Ein **React Context** (`AuthProvider` / `useAuth`) mit drei Zuständen:
`checking` → `authenticated` | `anonymous`. Keine State-Bibliothek.

### Begründung

- Es gibt genau **einen** globalen Zustand (den angemeldeten Benutzer) und
  kaum Schreibzugriffe. Redux, Zustand oder Jotai lösen Probleme, die hier
  nicht existieren — das wäre der „UI-Framework-Wildwuchs", den die Leitplanke
  ausschließt.
- Der Zustand `checking` ist nicht kosmetisch, sondern notwendig: Ohne ihn
  würde `RequireAuth` beim Neuladen sofort auf `/login` umleiten und
  angemeldeten Nutzern kurz der Login-Screen aufblitzen.
- **Nichts** davon liegt in `localStorage`. Die Session steckt ausschließlich
  im HttpOnly-Cookie; der Frontend-Zustand ist nur dessen Spiegelung und wird
  beim Start über `GET /api/auth/me` neu ermittelt.

### Alternativen (verworfen)

- **Zustand/Redux** — Zusatz-Dependency ohne Gegenwert bei einem Datum.
- **TanStack Query** — sinnvoll, sobald es viele Server-Daten zu cachen gibt
  (ab AP4 neu zu bewerten); für einen einzigen `/me`-Aufruf zu viel.
- **Benutzer in `localStorage` spiegeln** — verstößt gegen die Leitplanke und
  würde einen Zustand erzeugen, der nach Cookie-Ablauf falsch ist.

---

## ADR-0013 — Design-Tokens als CSS Custom Properties, Umschaltung per data-theme

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Es braucht ein Dark-Mode-fähiges Token-Set; Komponenten dürfen
  keine hartkodierten Farben enthalten.

### Entscheidung

Alle visuellen Werte (Farbe, Abstand, Radius, Typografie) sind **CSS Custom
Properties** in `apps/frontend/src/styles/tokens.css`. Zwei Sets:
`:root, [data-theme='light']` und `[data-theme='dark']`. Umgeschaltet wird über
das Attribut `data-theme` am `<html>`-Element. Startwert = `prefers-color-scheme`,
manuelle Wahl in `localStorage` (`gto.theme`).

### Begründung

- Custom Properties wechseln zur Laufzeit ohne Neuaufbau und ohne
  JavaScript-in-CSS. Ein Attributwechsel am Wurzelelement schaltet das ganze
  Set um.
- Kein Build-Schritt, keine Dependency — plain CSS reicht.
- `localStorage` ist hier ausdrücklich erlaubt: eine reine UI-Präferenz, kein
  Anwendungszustand und keine Auth-Daten.
- Der Aktiv-Zustand der Seitenleiste hängt **nicht allein an der Farbe**
  (Fläche + linke Kante + Schriftstärke) und bleibt so in beiden Modi und bei
  Farbfehlsichtigkeit erkennbar.

### Alternativen (verworfen)

- **Tailwind CSS** — mächtig, aber ein ganzes Utility-System für eine Shell mit
  fünf Platzhalterseiten; zusätzlich Build-Konfiguration.
- **CSS-in-JS (styled-components/emotion)** — Laufzeitkosten und eine weitere
  Abstraktion ohne Nutzen hier.
- **Zwei getrennte Stylesheets pro Modus** — doppelte Pflege, und beim
  Umschalten müsste ein Stylesheet getauscht werden.

---

## ADR-0014 — Testing Library plus jsdom für Frontend-Tests

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Die Frontend-Tests sollen echtes Komponentenverhalten prüfen
  (Formular, Guard, Umleitung, Logout) — ohne laufendes Backend.

### Entscheidung

**Vitest** (bereits im Monorepo) mit **jsdom** als Umgebung, dazu
`@testing-library/react`, `@testing-library/user-event` und
`@testing-library/jest-dom`. Das Netzwerk wird über einen Stub von
`globalThis.fetch` nachgebildet.

Neue Dev-Dependencies in `apps/frontend`:

| Paket                         | Zweck                                   |
| ----------------------------- | --------------------------------------- |
| `jsdom`                       | DOM-Umgebung für Vitest                 |
| `@testing-library/react`      | Rendern und Abfragen von Komponenten    |
| `@testing-library/user-event` | Realistische Eingaben (Tippen, Klicken) |
| `@testing-library/jest-dom`   | Aussagekräftige DOM-Matcher             |

### Begründung

- Testing Library prüft über **Rollen und Beschriftungen** statt über
  CSS-Klassen. Die Tests brechen dadurch nicht bei jeder Umgestaltung und
  decken nebenbei die Zugänglichkeit mit ab.
- `user-event` bildet echte Interaktion nach — nur so ließ sich prüfen, dass
  **Enter** das Formular absendet.
- Vitest war bereits gesetzt (ADR-0001); es kommt kein zweiter Test-Runner dazu.
- Ein `fetch`-Stub genügt und hält die Tests unabhängig von Backend und
  Datenbank. MSW wäre realistischer, aber eine weitere Dependency.

### Versions-Einschränkungen (Node 20)

Zwei Pakete mussten gepinnt werden, weil ihre neuesten Fassungen Node ≥ 22
verlangen, das Projekt aber auf Node 20.19.6 festgelegt ist (`.nvmrc`):

| Paket                       | Gewählt   | Grund                         |
| --------------------------- | --------- | ----------------------------- |
| `jsdom`                     | `^26.1.0` | `jsdom@30` verlangt Node ≥ 22 |
| `@testing-library/jest-dom` | `^6.6.4`  | Version 7 verlangt Node ≥ 22  |

Das ist dasselbe Muster wie beim Pin von `@fastify/cookie` in T1.3. Sammelt
sich das weiter an, wird ein Node-Upgrade als eigene Entscheidung fällig.

### Alternativen (verworfen)

- **MSW (Mock Service Worker)** — realistischer, aber für vier Endpunkte
  überdimensioniert.
- **Playwright** — gehört laut Kanon in **T1.6** und braucht ein laufendes
  Backend.
- **happy-dom statt jsdom** — schneller, aber weniger vollständig.

---

## ADR-0015 — Vite-Dev-Proxy statt CORS im Backend

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Im Dev-Betrieb laufen Frontend (Vite) und Backend (Fastify) auf
  verschiedenen Ports. Cookie-gestützte Requests über Origin-Grenzen hinweg
  brauchen sonst CORS mit `credentials`.

### Entscheidung

Der Vite-Dev-Server **proxyt `/api` und `/healthz`** an das Backend
(`vite.config.ts`, Ziel über `BACKEND_URL`). Am Backend wurde **nichts**
geändert — kein CORS-Plugin, keine neue Konfiguration.

### Begründung

- Für den Browser gibt es damit **eine einzige Herkunft**. Session- und
  CSRF-Cookies funktionieren ohne Sonderregeln; `SameSite=Lax` bleibt wirksam.
- Es entspricht exakt dem Zielbetrieb: Ab T1.5 macht der Host-Nginx dasselbe.
  Dev und Produktion verhalten sich also gleich, statt sich nur im Dev-Fall auf
  CORS zu stützen.
- Die Leitplanke verlangt, Backend-Änderungen zu vermeiden. Diese Lösung
  braucht gar keine.

### Alternativen (verworfen)

- **`@fastify/cors` mit `credentials: true`** — Backend-Änderung, zusätzliche
  Dependency, und die Dev-Umgebung wiche von der Produktion ab.
- **Frontend und Backend auf demselben Port** — hieße, die Vite-Assets vom
  Fastify-Server auszuliefern; das verschiebt Dev-Komfort ohne Not.

---

## ADR-0016 — Frontend-Assets direkt vom Host-Nginx, kein Frontend-Container

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP1.T1.5 lässt offen, ob die gebauten Frontend-Assets von einem
  schlanken Static-Server im Container oder direkt vom Host-Nginx ausgeliefert
  werden. Die Umgebungs-Vorgabe ist eindeutig: **kein Reverse-Proxy-Container,
  ausdrücklich auch kein nginx-Container.**

### Entscheidung

Die Assets werden **in einem Container gebaut**, aber **nicht aus einem
Container ausgeliefert**:

1. `apps/frontend/Dockerfile` baut sie in einer Build-Stage; die letzte Stage
   (`assets`, auf `scratch`) enthält nur das fertige `dist/`.
2. Der Deploy exportiert diese Stage per BuildKit
   (`docker build --target assets --output type=local,…`).
3. Das Ergebnis landet per Verzeichnistausch in `FRONTEND_STATIC_DIR`
   (Default `/home/phillip/gto-static`), das der Host-Nginx als `root`
   ausliefert.

Im Compose-Stack laufen damit nur **zwei** Services: `postgres` und `backend`.

### Begründung

- Ein Static-Server-Container wäre entweder nginx (explizit ausgeschlossen)
  oder ein weiterer Prozess, der genau das tut, was der Host-Nginx ohnehin
  kann — ein zusätzlicher Netzwerk-Hop ohne Gegenwert.
- Der Host-Nginx beherrscht `try_files` für den SPA-Fallback, `gzip` und
  Cache-Header nativ. Vite versieht Assets mit Hash, deshalb `immutable` für
  `/assets/` und `no-cache` für `index.html`.
- Der Build bleibt trotzdem reproduzierbar und containerisiert — die
  Node-/pnpm-Version ist im Dockerfile festgelegt, nicht die des Hosts.
- Weniger laufende Container heißt weniger Speicher auf einem Host, der sich
  bereits über 30 fremde Container teilt.

### Abweichung vom Kanon

`docs/ap/AP01.md` nennt unter T1.5 die Services „backend, frontend-static,
postgres". Ein `frontend-static`-Service entsteht hier **nicht**. Das ist
bewusst: Die Aufgabenstellung des Tasks erlaubt beide Wege ausdrücklich
(„Static-Server im Container **ODER** Bind-Mount/Kopie in ein vom Host-Nginx
direkt ausgeliefertes Verzeichnis"), und die härtere Vorgabe „kein
nginx-Container" schließt die naheliegende Container-Variante aus. Funktional
ist das Ergebnis identisch.

### Alternativen (verworfen)

- **`nginx:alpine` als `frontend-static`** — durch die Umgebungs-Vorgabe
  ausgeschlossen.
- **Node-basierter Static-Server (`serve`, `sirv`)** — neue Dependency und ein
  weiterer Prozess für eine Aufgabe, die der Host-Nginx besser erledigt.
- **Assets vom Backend ausliefern** — vermischt API und Auslieferung und
  verschenkt Nginx' statisches Caching.

---

## ADR-0017 — Migrationen als eigener Schritt im Deploy, nicht beim Backend-Start

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Beim Deploy muss das Schema aktuell sein. Möglich wären ein
  Migrationslauf beim Start des Backends oder ein eigener Schritt im
  Deploy-Skript.

### Entscheidung

Ein **einmaliger, eigener Schritt** im Deploy-Skript, **vor** dem Neustart des
Backends:

```bash
docker compose run --rm --no-deps backend node dist/db/cli-migrate.js
```

### Begründung

- **Fehler brechen den Deploy ab.** Schlägt die Migration fehl, endet
  `deploy.sh` mit Exit-Code ≠ 0, und das alte Backend läuft unverändert
  weiter. Beim Start-Ansatz würde der Container in eine Restart-Schleife
  laufen, während der Deploy „erfolgreich" gemeldet hätte.
- **Kein Wettlauf.** Bei mehreren Backend-Instanzen (heute eine, künftig
  denkbar) würden alle gleichzeitig migrieren. Der eigene Schritt läuft
  garantiert genau einmal.
- **Idempotent.** Drizzle führt Buch in `drizzle.__drizzle_migrations` und
  überspringt bereits eingespielte Dateien — wiederholte Deploys sind
  unproblematisch.
- `--no-deps` verhindert, dass Compose dafür weitere Services hochzieht;
  Postgres wurde im Schritt davor bereits als `healthy` bestätigt.

### Alternativen (verworfen)

- **Migration beim Backend-Start** — bequem, aber verschleiert Fehler und
  skaliert nicht.
- **Migration von Hand** — vergisst man; Deploys wären nicht reproduzierbar.
- **Init-Container** — dasselbe Ergebnis, aber mehr Compose-Mechanik als nötig.

---

## ADR-0018 — Portvergabe im Deployment: alles über Variablen, nur Loopback

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Der Host ist stark belegt. Im Verlauf von AP1 waren nacheinander
  3000, 3001, 5173, 5432, 55432 und 55433 durch fremde Dienste besetzt — die
  Belegung ändert sich also über die Zeit.

### Entscheidung

| Dienst   | Variable             | Default | Bindung     |
| -------- | -------------------- | ------- | ----------- |
| Backend  | `BACKEND_HOST_PORT`  | `3010`  | `127.0.0.1` |
| Postgres | `POSTGRES_HOST_PORT` | `55434` | `127.0.0.1` |

Kein Port ist in `docker-compose.yml` fest verdrahtet; fehlt eine Variable,
bricht Compose mit einer erklärenden Meldung ab (`${VAR:?…}`). Öffentlich
erreichbar ist ausschließlich der Host-Nginx auf 80/443.

### Begründung

- **Loopback-Bindung** verhindert, dass Backend oder Datenbank am Internet
  hängen. Der Host hat eine öffentliche IP; ein `0.0.0.0`-Mapping wäre sofort
  von außen erreichbar.
- **Pflichtvariablen statt Defaults im Compose-File:** Ein stiller Default
  würde bei Portwechsel unbemerkt auf einen belegten Port zeigen. Die
  `:?`-Syntax erzwingt eine bewusste Angabe in der `.env`.
- Der container-interne Port ist fest `3000` — im eigenen Namensraum gibt es
  keinen Konflikt, und der Healthcheck kann ihn fest annehmen.

### Alternativen (verworfen)

- **Feste Ports** — kollidieren nachweislich; 3001 war bei T1.3 noch frei und
  bei T1.4 belegt.
- **Gar kein Port-Mapping (nur Compose-intern)** — der Host-Nginx läuft
  außerhalb von Compose und braucht einen erreichbaren Port.
- **Unix-Sockets statt TCP** — technisch reizvoll, aber Compose-Volumes für
  Sockets zwischen Host-Nginx und Container sind fehleranfällig.
