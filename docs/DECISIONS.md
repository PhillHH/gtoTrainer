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
öffentlich adressierbar. Auch das Backend läuft nicht auf 3000, weil dieser
Port belegt ist.

> **Nachtrag (T1.4/T1.5):** Der damals gewählte Backend-Port **3001** ist
> inzwischen ebenfalls fremd belegt. Verbindlich ist seither **3010**; die
> vollständige Portvergabe steht in [ADR-0018](#adr-0018--portvergabe-im-deployment-alles-über-variablen-nur-loopback).

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

---

## ADR-0019 — GitHub Actions als Qualitätsschranke

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP1.T1.6 verlangt eine automatisierte Schranke aus
  lint + test + build. Der Kanon lässt GitHub Actions **oder** ein lokales
  Pre-Push-Skript zu.

### Entscheidung

**GitHub Actions** (`.github/workflows/ci.yml`), zwei Jobs:

| Job       | Inhalt                                              |
| --------- | --------------------------------------------------- |
| `quality` | install → lint → migrate → test → build             |
| `e2e`     | Smoke-E2E (Login → Dashboard), läuft nach `quality` |

Trigger: Push auf `main` und Pull Requests gegen `main`. Node-Version aus
`.nvmrc`, pnpm-Version aus dem Feld `packageManager`, pnpm-Store und
Playwright-Browser werden zwischengespeichert.

### Begründung

- Das Repo liegt auf GitHub und ist **öffentlich** — Actions-Minuten sind damit
  kostenlos, und die Schranke greift auch bei Pull Requests, nicht nur lokal.
- Ein Pre-Push-Hook lässt sich mit `--no-verify` umgehen und läuft nicht, wenn
  von einer anderen Maschine gepusht wird. Eine serverseitige Prüfung ist die
  belastbarere Schranke.
- Die Integrationstests brauchen ein echtes Postgres. Actions bietet dafür
  **Service-Container** — lokal müsste jeder Entwickler das selbst bereitstellen.
- Der Runner ist eine frische Umgebung: Er deckt auf, wenn etwas nur auf diesem
  Host funktioniert (belegte Ports, `NODE_ENV=production` in der Shell).

### Datenbank in der CI

Ein `postgres:16-alpine`-Service-Container mit `pg_isready`-Healthcheck. Die
Zugangsdaten im Workflow sind **reine Wegwerf-Testwerte**
(`gto` / `ci-test-password`) für eine Datenbank, die nach dem Lauf verschwindet.
Es liegen **keine** Produktions-Secrets im Repository.

`NODE_ENV: development` wird im Workflow explizit gesetzt — nicht, weil der
Runner es bräuchte, sondern damit die auf dem Zielhost bekannte Falle
(`NODE_ENV=production` lässt pnpm die devDependencies überspringen) hier
dokumentiert und ausgeschlossen ist.

**Kein Test wird in der CI ausgeklammert.** Die volle Suite läuft, inklusive
der DB-Integrationstests und des Smoke-E2E.

### Alternativen (verworfen)

- **Lokales Pre-Push-Skript** — umgehbar, maschinenabhängig, keine
  PR-Prüfung.
- **Beides parallel** — zwei Wahrheiten, die auseinanderlaufen.
- **E2E im selben Job wie `quality`** — ein Fehlschlag im E2E hätte dann kein
  eigenes Signal; getrennte Jobs zeigen sofort, wo es klemmt.

---

## ADR-0020 — Playwright für den Smoke-E2E-Test

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Der Kanon fordert für T1.6 genau **einen** durchgehenden
  Browser-Test: Login → Dashboard.

### Entscheidung

**`@playwright/test`** als Root-Dev-Dependency, Konfiguration in
`playwright.config.ts`, Test in `e2e/login.spec.ts`. **Nur Chromium.**

Neue Dev-Dependency:

| Paket              | Zweck                                   |
| ------------------ | --------------------------------------- |
| `@playwright/test` | Browser-Automatisierung und Test-Runner |

### Begründung

- **`webServer`** startet Backend und Frontend für den Lauf selbst — der Test
  läuft ohne manuelle Vorbereitung, lokal wie in der CI. Genau das verlangt der
  Task.
- **Auto-Waiting** statt fester Wartezeiten: keine `sleep`-Flakiness.
- Rollen- und Label-basierte Selektoren (`getByRole`, `getByLabel`) passen zu
  den Frontend-Tests aus T1.4 und brechen nicht bei jeder Umgestaltung.
- **Nur Chromium**, weil ein Smoke-Test die Funktion belegen soll, nicht
  Browser-Kompatibilität. Drei Browser verdreifachen nur die Laufzeit.
- Playwright 1.62 verlangt Node ≥ 20 und passt damit zur `.nvmrc` — anders als
  drei Pakete aus T1.3/T1.4, die auf ältere Versionen gepinnt werden mussten.

### Testdaten und Ports

- Zugangsdaten kommen **ausschließlich aus Umgebungsvariablen**
  (`E2E_USERNAME`, `E2E_PASSWORD`); im Test steht kein Passwort.
- Der Benutzer wird in `e2e/global-setup.ts` reproduzierbar über **die
  vorhandenen Werkzeuge** angelegt: `pnpm db:migrate` (T1.2) und
  `pnpm auth:set-password` (T1.3) — kein zweiter, abweichender Weg.
- Ports sind konfigurierbar (`E2E_BACKEND_PORT` = 3020,
  `E2E_FRONTEND_PORT` = 5180). Bewusst **nicht** 3010/5174: Diese gehören dem
  laufenden Deployment bzw. dem Dev-Server, und 3000/3001/5173 sind auf dem
  Host fremd belegt.
- Die Datenbank kommt aus `E2E_DATABASE_URL` (Rückfall auf `DATABASE_URL`).
  Lokal empfiehlt sich eine eigene Datenbank (`gto_e2e`), in der CI ist es
  ohnehin eine frische Instanz.

### Alternativen (verworfen)

- **Cypress** — vergleichbar tauglich, aber kein eingebautes Starten mehrerer
  Server und schwergewichtiger in der CI.
- **Selenium/WebDriver** — deutlich mehr Konfiguration für denselben Zweck.
- **Kein E2E, nur die Komponententests aus T1.4** — die laufen gegen ein
  gemocktes Netzwerk und würden einen echten Bruch zwischen Frontend, Proxy und
  Backend nicht bemerken. Genau diesen Durchstich verlangt der Kanon.

---

## ADR-0021 — Aufrufform der Claude Code CLI: `-p` mit `--output-format json`, Profil B über `CLAUDE_CONFIG_DIR`

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP2.T2.1 verlangt eine dokumentiert verifizierte Entscheidung,
  wie die CLI headless und gegen **Profil B** angesprochen wird. Grundlage
  sind die offizielle Dokumentation (Stand 2026-08-23, `docs.claude.com`
  leitet dauerhaft auf `code.claude.com/docs` um) und eigene Messungen mit
  CLI-Version **2.1.240** auf dem Zielhost.

### Entscheidung

Zwei Aufrufformen, beide zustandslos, beide mit explizit gesetztem
`CLAUDE_CONFIG_DIR=/home/phillip/.claude-b`:

**A — Text- und JSON-Aufrufe ohne Bild (Regelfall, AP4/AP5/AP8/AP9):**

```bash
CLAUDE_CONFIG_DIR=/home/phillip/.claude-b claude -p "<prompt>" \
  --model <alias|modell-id> \
  --output-format json \
  [--json-schema '<JSON-Schema>']
```

**B — Aufrufe mit Bild-Input (AP3, Chart-Digitalisierung):**

```bash
CLAUDE_CONFIG_DIR=/home/phillip/.claude-b claude -p \
  --model <alias|modell-id> \
  --input-format stream-json --output-format stream-json --verbose \
  [--json-schema '<JSON-Schema>'] < nachrichten.jsonl
```

Der Prompt geht in Form A als Argument mit, in Form B als eine Zeile
`{"type":"user","message":{"role":"user","content":[…]},"parent_tool_use_id":null}`
über stdin; Bilder sind darin Blöcke
`{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}`.

### Belegte Doku-Aussagen

| Frage                 | Befund                                                                                                                                                                                                                              | Beleg                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Headless-Aufruf       | `--print`, `-p` — „Print response without interactive mode"; Prompt als Argument oder über stdin                                                                                                                                    | <https://code.claude.com/docs/en/cli-reference>, <https://code.claude.com/docs/en/headless> |
| Modellwahl            | `--model` — Alias (`sonnet`, `opus`, `haiku`, `fable`) oder vollständige Modell-ID; überschreibt `ANTHROPIC_MODEL`                                                                                                                  | <https://code.claude.com/docs/en/cli-reference>                                             |
| Strukturierte Ausgabe | `--output-format` mit `text` \| `json` \| `stream-json`; `--json-schema` erzwingt ein Schema, Ergebnis steht im Feld `structured_output`                                                                                            | <https://code.claude.com/docs/en/headless>                                                  |
| Auth / Config-Dir     | `CLAUDE_CONFIG_DIR` — „Override the configuration directory (default: `~/.claude`). All settings, session history, and plugins are stored under this path, as are credentials on Linux and Windows"                                 | <https://code.claude.com/docs/en/env-vars>                                                  |
| Fehlende Auth         | `Not logged in · Please run /login`                                                                                                                                                                                                 | <https://code.claude.com/docs/en/errors>                                                    |
| Session-Verhalten     | Jeder `-p`-Aufruf ist eine **neue** Sitzung; Fortsetzen nur ausdrücklich mit `--continue`/`--resume`. `--continue` überspringt sogar `-p`-Sitzungen, sofern `-p` nicht selbst mitgegeben wird                                       | <https://code.claude.com/docs/en/cli-reference>, <https://code.claude.com/docs/en/headless> |
| Bild-Input            | **Unterstützt, aber nur über Streaming-Input.** Der Streaming-Modus kann „attach images directly to messages"; für Single-Message-Input ist ausdrücklich dokumentiert: „does **not** support: Direct image attachments in messages" | <https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode>                        |
| Exit-Codes            | „Claude Code exits with code 0 on success and a non-zero code when the run fails"; SIGTERM ⇒ 143                                                                                                                                    | <https://code.claude.com/docs/en/headless>                                                  |
| Kontingent            | „You've hit your session limit · resets 3:45pm" / weekly / Opus-Limit; „Claude Code blocks further requests until the reset time shown in the message"                                                                              | <https://code.claude.com/docs/en/errors>                                                    |

### Eigene Messungen (CLI 2.1.240, alle mit `CLAUDE_CONFIG_DIR=/home/phillip/.claude-b`)

| Aufruf                                                  | Exit | Beobachtung                                                                                                                                                     |
| ------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude -p "Antworte nur mit OK" --output-format text`  | 0    | stdout genau `OK\n`, stderr leer                                                                                                                                |
| `claude -p … --output-format json --json-schema '…'`    | 0    | **eine** Zeile reines JSON auf stdout, **kein** Wrapper-Text, **keine** Code-Fences; `result` ist ein JSON-_String_, `structured_output` das geparste Objekt    |
| dasselbe mit `--input-format stream-json` + Base64-PNG  | 0    | Bild korrekt erkannt (`result: "Rot"`); Kombination mit `--json-schema` liefert zusätzlich `structured_output`                                                  |
| `--input-format stream-json` mit `--output-format json` | 1    | stderr: `Error: --input-format=stream-json requires output-format=stream-json.`                                                                                 |
| leeres, nicht eingeloggtes Config-Verzeichnis           | 1    | stdout-JSON mit `is_error: true`, `result: "Not logged in · Please run /login"`, `terminal_reason: "api_error"` — **kein** Rückfall auf `/home/phillip/.claude` |

**Für das Parsing in T2.2 maßgeblich:** Der Erfolg eines Aufrufs wird an
`is_error` **und** dem Exit-Code festgemacht, **nicht** an `subtype` — im
Auth-Fehlerfall stand `subtype: "success"` neben `is_error: true`. Ein
Fence-Stripping ist bei `--output-format json` nicht nötig, muss in T2.2 aber
trotzdem defensiv vorhanden sein.

### Begründung

- `--output-format json` liefert in einem Zug Antworttext **und** die
  Begleitdaten, die `llm_call_log` braucht (`duration_ms`, `usage`, Modell).
  `text` liefert nichts davon, `stream-json` erzwingt einen Zeilenparser.
- `--json-schema` verlagert die Schemaeinhaltung in die CLI; die Alternative
  „Schema im Prompt beschreiben und hinterher parsen" ist nachweislich
  fehleranfälliger und braucht Fence-Stripping.
- Für Bilder gibt es **keine** Alternative zu `--input-format stream-json`:
  Single-Message-Input unterstützt keine Bildanhänge. Der Umweg „Bild auf
  Platte legen und die CLI per Read-Tool lesen lassen" würde einen
  Werkzeugaufruf, ein Dateisystem-Recht und einen zusätzlichen Turn kosten und
  skaliert für ~336 Chart-Bilder aus AP3 schlecht.
- `--bare` wird **nicht** verwendet, obwohl es Startzeit spart: Laut
  Dokumentation liest der Bare-Modus „never … OAuth credentials or the system
  keychain" und braucht `ANTHROPIC_API_KEY`. Das ist mit einem
  Subscription-Profil unvereinbar.

### Alternativen (verworfen)

- **`--output-format text` plus eigenes Parsen** — keine Tokenzahlen, keine
  Dauer, kein maschinenlesbarer Fehlerzustand.
- **`--output-format stream-json` als Regelfall** — nötig nur für Bild-Input;
  für Textaufrufe unnötiger Zeilenparser.
- **Agent-SDK (`@anthropic-ai/claude-agent-sdk`) statt Prozessaufruf** — neue
  Laufzeit-Dependency und ein zweiter Auth-Pfad für dieselbe Sache; der
  Prozessaufruf hält das Backend frei von SDK-Bindungen und passt zum
  Adaptermodell (T2.3 nutzt daneben die reine HTTP-API).
- **`--continue`/`--resume` für Gesprächsverläufe** — der `LLMProvider`
  überträgt den Verlauf ausdrücklich in `messages`; Sitzungszustand auf der
  Platte des Hosts wäre eine zweite, nicht replizierbare Wahrheit.

---

## ADR-0022 — Container-zu-Host-Zugriff auf die CLI: Host-seitiger Runner über Unix-Domain-Socket

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Das Backend läuft im Container (`gto-backend`, ADR-0016/0018),
  die Claude CLI und Profil B liegen auf dem Host. AP2 verlangt eine
  begründete Entscheidung nach den Kriterien: reproduzierbar im
  Compose-Betrieb, Profil B isoliert und unverändert (read-only bevorzugt),
  ohne Root betreibbar, Verhalten bei CLI-Updates, Sicherheitsfolgen.

### Entscheidung

**Ein Host-seitiger Runner-Prozess.** Die CLI wird **nicht** ins Backend-Image
aufgenommen und Profil B **nicht** in den Container gemountet. Stattdessen:

1. Auf dem Host läuft als Benutzer `phillip` ein kleiner Runner-Prozess, der
   die Aufrufform aus [ADR-0021](#adr-0021--aufrufform-der-claude-code-cli--p-mit---output-format-json-profil-b-über-claude_config_dir)
   ausführt und `CLAUDE_CONFIG_DIR=/home/phillip/.claude-b` selbst setzt.
2. Der Runner lauscht auf einem **Unix-Domain-Socket** in einem eigenen
   Verzeichnis (`LLM_RUNNER_SOCKET_DIR`, Default `/home/phillip/gto-llm-runner`).
3. Compose bindet **nur dieses Verzeichnis** in den Backend-Container ein; der
   CLI-Adapter aus T2.2 spricht den Socket an, statt einen Prozess zu spawnen.

Kein TCP-Port, kein `host-gateway`, kein Docker-Socket. Die Umsetzung
(Runner-Skript, Compose-Mount, Protokoll) gehört in T2.2.

### Machbarkeitsnachweis (rückstandsfrei, 2026-08-23)

Host-seitiger Node-Listener auf `…/gto-llm.sock` (Mode `srw-------`), Aufruf
aus einem Wegwerf-Container mit demselben Basis-Image wie das Backend:

```
docker run --rm --user 1000:1000 -v "$SOCKDIR":/host-llm node:20.19.6-alpine node /host-llm/cli.js
→ pong:hello-from-container        (container exit=0)
```

Der Container läuft dabei als **uid 1000** (`node`) — dieselbe uid wie
`phillip` auf dem Host, deshalb genügt Socket-Mode `0600`. Socket, Skripte und
Verzeichnis wurden anschließend gelöscht.

### Begründung

- **Profil B bleibt isoliert.** Der Container sieht das Verzeichnis nie. Das
  ist mehr, als „read-only" leisten würde — und read-only ist ohnehin **nicht**
  tragfähig: Ein `-p`-Lauf gegen ein frisches Config-Verzeichnis legte
  nachweislich `.claude.json`, `backups/`, `projects/` und `sessions/` an, und
  laut <https://code.claude.com/docs/en/env-vars> liegen unter demselben Pfad
  auch die Zugangsdaten (Linux), deren OAuth-Refresh Schreibrechte braucht.
  Ein Read-only-Mount würde also entweder brechen oder müsste zum
  Read-write-Mount aufgeweicht werden.
- **Sicherheitsfolgen.** Beim Image-Mount hätte der Container die
  Subscription-Zugangsdaten **und** Schreibrecht darauf. Über den Socket kann
  er nur genau das, was der Runner anbietet: einen Prompt einreichen. Modell,
  Werkzeugfreigaben, Arbeitsverzeichnis und Timeout bestimmt der Runner.
- **CLI-Updates.** Die Host-Installation aktualisiert sich selbst
  (<https://code.claude.com/docs/en/overview>: „Native installations
  automatically update in the background"). Eine zweite Installation im Image
  müsste versioniert, gebaut und nachgezogen werden; Host- und Container-CLI
  würden auseinanderlaufen.
- **Ohne Root.** Runner und Socket gehören `phillip`; das Bind-Mount-Verzeichnis
  liegt in dessen Home. Nichts davon braucht `sudo` (`NoNewPrivs=1` gilt weiter).
- **Reproduzierbar in Compose.** Ein zusätzliches Bind-Mount plus zwei
  Umgebungsvariablen; keine Netzwerk- oder Capability-Änderung.

### Alternativen (verworfen)

- **CLI im Backend-Image plus Mount von `/home/phillip/.claude-b`** — die vom
  Kanon zuerst genannte Option. Verworfen, weil der bevorzugte
  Read-only-Mount am Schreibverhalten der CLI scheitert (Beleg oben), der
  Read-write-Mount das Isolationskriterium verletzt und die CLI-Version im
  Image einfriert. Zusätzlich wüchse das Backend-Image spürbar.
- **Loopback-TCP über `extra_hosts: host-gateway`** — funktioniert, öffnet aber
  einen Port, der ohne eigenes Token für **jeden** Container im Netz erreichbar
  wäre. Der Socket ist über Dateirechte abgesichert, ohne weitere Mechanik.
- **Docker-Socket in den Container** — wäre faktisch Root auf dem Host.
- **Backend aus dem Container holen und direkt auf dem Host betreiben** —
  löst das Problem, wirft aber die in AP1 etablierte Topologie um
  (ADR-0016/0017/0018) und ist keine AP2-Entscheidung.

### Risiko / offener Punkt

Der Runner ist ein Prozess **außerhalb** von Compose und startet nach einem
Reboot nicht von selbst mit. Ein Root-freier Weg (`@reboot`-Eintrag in der
Benutzer-Crontab; `cron` läuft auf dem Host) ist vorgesehen, aber noch nicht
verifiziert — das gehört in T2.2 samt RUNBOOK-Eintrag. Bis dahin ist der Start
des Runners ein manueller Deploy-Schritt.

---

## ADR-0023 — CLI-Adapter: einheitlicher stream-json-Aufruf, eigene Persona ohne Werkzeuge, Semaphore- und Retry-Parameter

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP2.T2.2 setzt [ADR-0021](#adr-0021--aufrufform-der-claude-code-cli--p-mit---output-format-json-profil-b-über-claude_config_dir)
  und [ADR-0022](#adr-0022--container-zu-host-zugriff-auf-die-cli-host-seitiger-runner-über-unix-domain-socket)
  um. Bei der Umsetzung sind vier Punkte entschieden worden, die dort noch
  offen waren. Alle Messungen mit CLI **2.1.240** gegen Profil B.

### Entscheidung 1 — **immer** `--input-format stream-json`, nie ein Prompt-Argument

ADR-0021 sah zwei Aufrufformen vor: Prompt als Argument für Text, Streaming-Input
für Bilder. Der Adapter nutzt **nur** die Streaming-Form.

Begründung: Der Prompt steht damit nie auf der Kommandozeile — weder ein
`ARG_MAX`-Limit noch ein Escaping-Thema, und Bild- und Textaufrufe teilen sich
einen Parser statt zweier Codepfade. Das entspricht auch der Vorgabe des Tasks
(„Prompt über stdin übergeben, nicht als Argument"). Nachtrag zu ADR-0021,
keine Abweichung von dessen Kern: `--json-schema` und die Auswertung über
`is_error` bleiben unverändert. Beachte: Die CLI lehnt
`--input-format stream-json` in Verbindung mit `--output-format json` ab
(`Error: --input-format=stream-json requires output-format=stream-json`),
deshalb ist die Ausgabe durchgängig `stream-json` und der Parser liest die
letzte Zeile mit `type: "result"`.

### Entscheidung 2 — `--system-prompt` statt Anhängen, und `--tools ""`

`LlmRequest.system` **ersetzt** den Standard-Systemprompt (`--system-prompt`),
und der Aufruf bekommt **keine Werkzeuge** (`--tools ""`).

Gemessen (Haiku, gleicher Prompt):

| Aufruf                             | Eingabetokens                           |
| ---------------------------------- | --------------------------------------- |
| `--system-prompt`, Werkzeuge aktiv | `input 10` + **`cache_creation 18543`** |
| `--system-prompt --tools ""`       | `input 247`, `cache_creation 0`         |

Das Gateway will eine Antwort, keinen Agenten: Datei- und Bash-Werkzeuge im
Container-Kontext wären zusätzlich ein Sicherheitsrisiko. `--json-schema`
funktioniert nachweislich weiter (`structured_output` gesetzt, `num_turns: 2`)
— das Werkzeug für strukturierte Ausgabe bleibt trotz `--tools ""` verfügbar.

Aus demselben Grund läuft der Prozess in einem **projektfremden**
Arbeitsverzeichnis (`LLM_CLI_CWD`, Default: temporäres Verzeichnis): Laut
<https://code.claude.com/docs/en/headless> lädt ein `-p`-Lauf ohne `--bare`
Hooks, MCP-Server und CLAUDE.md aus dem cwd. `--bare` selbst ist keine Option
— es liest keine OAuth-Zugangsdaten und wäre mit Profil B unvereinbar.

`maxTokens` wird als `CLAUDE_CODE_MAX_OUTPUT_TOKENS` gesetzt. Zu beachten: Die
CLI **kürzt nicht**, sie bricht ab
(`API Error: Claude's response exceeded the N output token maximum`). Der
Adapter meldet das als `invalid` — die Anfrage war so nicht erfüllbar.

### Entscheidung 3 — Prozess-Environment ist eine Allowlist

Der Kindprozess bekommt **nicht** das Eltern-Environment, sondern genau vier
Variablen: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `PATH`, `HOME`.

Entscheidend ist, was **fehlt**: `ANTHROPIC_API_KEY`. Laut
<https://code.claude.com/docs/en/env-vars> gilt „In non-interactive mode (`-p`),
the key is always used when present" — ein gesetzter Schlüssel würde also still
an Profil B vorbei abrechnen. Der CLI-Adapter ist der Subscription-Weg; der
API-Weg ist Adapter B (T2.3).

### Entscheidung 4 — Semaphore- und Retry-Parameter

| Parameter                   | Default  | Begründung                                                                                                                                                                     |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LLM_MAX_CONCURRENCY`       | `2`      | Jeder Aufruf ist ein Node-Prozess. Der Host ist geteilt (30+ fremde Container); AP3 setzt ~336 Aufrufe ab. Zwei parallel halten den Durchsatz oben, ohne den Host zu belasten. |
| `LLM_MAX_ATTEMPTS`          | `3`      | Ein Wiederholungsversuch deckt die üblichen 429/529 ab; mehr verbrennt bei echter Störung nur Kontingent.                                                                      |
| `LLM_RETRY_BASE_DELAY_MS`   | `1000`   | Exponentiell (1 s, 2 s, 4 s …) mit **voller Streuung** (`0,5–1,0 ×`), damit parallele Aufrufe nicht im Gleichtakt erneut anklopfen.                                            |
| `LLM_RETRY_MAX_DELAY_MS`    | `30000`  | Deckel je Wartezeit.                                                                                                                                                           |
| `LLM_RETRY_TOTAL_BUDGET_MS` | `300000` | Harte Obergrenze über alle Versuche. Wird sie durch den nächsten Backoff gesprengt, fliegt der Fehler sofort durch.                                                            |

Wiederholt wird ausschließlich, was die Taxonomie aus T2.1 als retrybar
ausweist (`timeout`, `rate_limit`, `transient`). **Unbekannte** CLI-Fehler
werden bewusst als `invalid` eingestuft, nicht als `transient`: Bei unklarer
Ursache wird nicht blind wiederholt. Der Preis ist eine leicht schiefe
Benennung — `invalid` ist zugleich Auffangkategorie —, der Gewinn ist, dass
keine unerklärte Störung Kontingent verbrennt.

Ein `rate_limit` bleibt retrybar, aber nicht sofort: `retryAfterMs` schiebt den
Versuch über den Backoff hinaus, und das Gesamtbudget bricht sauber ab, sodass
die Job-Queue aus T2.5 die eigentliche Wiedervorlage übernimmt.

### Entscheidung 5 — Schemaprüfung ohne neue Dependency

Bei gesetztem `jsonSchema` prüft der Adapter die Nutzlast gegen eine
**Teilmenge** von JSON Schema (`type`, `required`, `properties`, `items`,
`enum`, `additionalProperties: false`) — rund 80 Zeilen in
`apps/backend/src/llm/parse.ts`. Ein Verstoß ergibt `parse`, nie einen stillen
Rückfall auf Rohtext.

Begründung: Die **maßgebliche** Durchsetzung leistet die CLI über
`--json-schema`; die eigene Prüfung ist das Netz für den Fall, dass die
Nutzlast aus dem Antworttext rekonstruiert werden musste (Code-Fence,
Wrapper-Text). Dafür rechtfertigt Regel 5 des AGENT_GUIDE keine
Validator-Dependency wie `ajv`. Die geprüften Schlüsselwörter sind im
Quelltext dokumentiert; alles andere wird ignoriert statt fälschlich
durchgewunken.

**Keine neuen Dependencies in T2.2.**

### Alternativen (verworfen)

- **Zwei Aufrufformen wie in ADR-0021 skizziert** — zwei Parser, zwei
  Fehlerpfade, und der Textpfad bliebe an `ARG_MAX` gebunden.
- **`--append-system-prompt` statt `--system-prompt`** — behielte den
  Coding-Agenten-Prompt samt Werkzeugbeschreibungen; genau die 18.500 Tokens,
  die Entscheidung 2 einspart.
- **Werkzeuge aktiv lassen und Bilder per Read-Tool laden** — ein zusätzlicher
  Turn, Dateisystemrechte im Container und deutlich mehr Tokens je Chart.
- **`ajv` für die Schemaprüfung** — vollständiger, aber eine Dependency für
  einen Sonderfall, den die CLI bereits abdeckt.
- **Unbekannte Fehler als `transient`** — bequem, aber genau das „blinde
  Wiederholen bei unklarer Ursache", das der Task ausschließt.

---

## ADR-0024 — API-Fallback-Adapter: offizielles SDK, `output_config.format`, geteilte Retry-/Semaphore-Logik

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP2.T2.3 verlangt einen zweiten, gleichwertigen Adapter gegen
  die Anthropic Messages API (Risiko R1: Unabhängigkeit von der Subscription)
  sowie eine Provider-Auswahl rein über Konfiguration. Drei Punkte waren dabei
  offen: die Zugriffsart auf die API, die Umsetzung strukturierter Ausgaben und
  der Ort der geteilten Ablauflogik.

### Entscheidung 1 — offizielles SDK statt eigener HTTP-Aufrufe

**Neue Laufzeit-Abhängigkeit:**

| Paket               | Version    | Workspace      | Zweck                         |
| ------------------- | ---------- | -------------- | ----------------------------- |
| `@anthropic-ai/sdk` | `^0.120.0` | `apps/backend` | Zugriff auf die Anthropic-API |

Bewertet nach den Kriterien des Tasks:

- **Kontrolle über die Fehlerbehandlung** — das SDK wirft je Status eine eigene
  Klasse (`RateLimitError`, `AuthenticationError`, `BadRequestError`,
  `InternalServerError`, `APIConnectionTimeoutError`, …). Die Zuordnung auf
  unsere Taxonomie wird dadurch eine `instanceof`-Kette statt einer
  Status-Code-Tabelle mit selbstgebautem Body-Parsing. Genau diese Zuordnung
  ist der Kern der geforderten Parität.
- **Bild-Unterstützung** — Base64-Bildblöcke sind Teil der SDK-Typen; ein
  Tippfehler im Blockaufbau fällt bei `tsc` auf, nicht erst im Betrieb.
- **Gewicht** — das SDK bringt keine schweren Transitiven mit und landet über
  `pnpm deploy --prod` ohnehin nur im Backend-Bundle. Der Gegenwert (Typen für
  Request, Antwort und Fehler) überwiegt die ~20 Zeilen, die ein `fetch`-Aufruf
  gespart hätte.
- Die **Retry-Automatik des SDK ist abgeschaltet** (`maxRetries: 0`). Sie liefe
  sonst neben unserem Backoff, umginge die Taxonomie und vervielfachte das
  Zeitbudget unbemerkt. Wiederholt wird ausschließlich in `GuardedProvider`.

### Entscheidung 2 — strukturierte Ausgabe über `output_config.format`

Bei gesetztem `jsonSchema` schickt der Adapter
`output_config: { format: { type: 'json_schema', schema } }`. Das ist die
dokumentierte Form für serverseitig erzwungene Schemakonformität
(<https://platform.claude.com/docs/en/build-with-claude/structured-outputs>);
ein Beta-Header ist nicht nötig.

Zwei Zusätze, damit sich beide Adapter gleich verhalten:

1. **Schema-Angleichung.** Strukturierte Ausgaben verlangen
   `additionalProperties: false` an _jedem_ Objekt. Der `LLMProvider`-Vertrag
   verlangt das nicht — ohne Angleichung liefe derselbe Request beim
   CLI-Adapter durch und scheiterte beim API-Adapter mit 400. `forceClosedObjects()`
   ergänzt die Angabe rekursiv dort, wo `properties` steht und nichts
   angegeben ist; vorhandene Werte bleiben unangetastet.
2. **Dieselbe Auswertung.** Die Antwort wird mit denselben Funktionen
   ausgewertet wie beim CLI-Adapter (`extractJson` inklusive Fence-Stripping
   und Wrapper-Text, dann `validateAgainstSchema`). Damit ergibt dieselbe
   fehlerhafte Antwort bei beiden Adaptern denselben `parse`-Fehler.

Verworfen: **erzwungener Werkzeugaufruf** (`tools` + `tool_choice`) und
**Schema im Prompt beschreiben**. Ersteres erreicht dasselbe über einen Umweg
und macht die Antwortauswertung komplizierter; letzteres gibt keine Garantie
und würde die Parität von der Modellwahl abhängig machen.

**Bekannte Grenze:** Die API lehnt Schemata mit `minimum`/`maxLength`,
Rekursion oder `$ref` ab (400 → Kategorie `invalid`). Der CLI-Adapter ist hier
toleranter. Für die Schemata aus AP3–AP9 ist das ohne Belang; es steht im
RUNBOOK unter den Fehlerbildern.

### Entscheidung 3 — geteilte Ablauflogik in `GuardedProvider`

Nebenläufigkeitslimit, Retry mit Backoff und die Vorprüfung der Anfrage liegen
in `apps/backend/src/llm/base-provider.ts`. Beide Adapter erben davon und
implementieren nur `attempt()` — einen einzelnen Versuch.

Begründung: Die Retry-Einstufung ist der Kern der geforderten Parität. Läge sie
je Adapter vor, könnte ein neuer Adapter still davon abweichen. So ist die
Taxonomie aus T2.1 die einzige Quelle der Wahrheit, und ein dritter Adapter
erbt das Verhalten, statt es nachzubauen. Die T2.2-Tests belegen die
Umstrukturierung: sie liefen unverändert weiter grün.

### Entscheidung 4 — Provider-Auswahl über eine Registry

`LlmProviderRegistry` ist ab sofort der **einzige** Weg zu einem Provider.
Reihenfolge: `config`-Tabelle (`llm.provider`) → `LLM_PROVIDER` → `cli`. Die
Tabelle wird bei jedem Aufruf gelesen, damit eine Umschaltung ab dem nächsten
Aufruf greift — ohne Neustart. Ein unbekannter Wert ergibt einen `invalid`-Fehler
mit Nennung der erlaubten Werte, keinen stillen Default.

Ein Datenbanktreffer je LLM-Aufruf ist vertretbar: Der Aufruf selbst dauert
Sekunden, die Abfrage Mikrosekunden. Ein Cache mit Ablaufzeit würde die Zusage
„der nächste Aufruf nutzt den neuen Provider" aufweichen.

### Entscheidung 5 — Umgang mit dem API-Schlüssel

`ANTHROPIC_API_KEY` ist **nur Pflicht, wenn der API-Adapter aktiv ist**. Das
Backend startet ohne Schlüssel normal, solange `cli` aktiv ist. Fehlt der
Schlüssel bei aktivem API-Provider, bricht bereits der Bau des Adapters mit
Kategorie `auth` und einer handlungsanweisenden Meldung ab.

Der Schlüssel wird nirgends ausgegeben — auch nicht gekürzt. Fehlermeldungen
der Auth-Kategorie nennen nur die Variable; jede weitergereichte
Servermeldung läuft vorher durch eine Ausschwärzung, die den Schlüsselwert
durch `***` ersetzt. Der unveränderte Platzhalter aus `.env.example`
(`__SET_…`) gilt als „nicht gesetzt", damit eine kopierte Vorlage in die
verständliche Meldung läuft statt in einen 401.

---

## ADR-0025 — Prompt-Templates als Dateien mit JSON-Kopfdaten, eigene Mini-Ersetzung statt Template-Engine

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP2.T2.4 verlangt versionierte, testbare Prompt-Bausteine statt
  verstreuter Inline-Strings. Offen waren Ablageort, Metadaten-Format,
  Platzhalter-Mechanik und der Umgang mit Versionierung.

### Entscheidung 1 — Dateien im Repo, nicht in der Datenbank

Templates liegen unter **`apps/backend/prompts/`** als `.md`-Dateien, gegliedert
in `partial/`, `persona/` und `task/`.

Begründung: Prompts sind Code, kein Inhalt. Sie gehören in Review, Diff und
Historie. Eine Änderung an der Lehrer-Persona verschiebt die Didaktik des
ganzen Produkts — das darf nicht per `UPDATE` an der Datenbank passieren,
sondern muss im Pull Request sichtbar sein. In der Datenbank landen später
Lerndaten und Fachwissen, nicht die Anweisungen an das Modell.

Der Weg ins Image folgt dem Muster der Migrationen: `PROMPTS_DIR` zeigt im
Container auf `/app/prompts`, im Repo greift der Rückfall auf
`apps/backend/prompts`. Das Verzeichnis steht zusätzlich im `files`-Feld von
`apps/backend/package.json`, damit `pnpm deploy --prod` es mitnimmt.

`.md` als Endung, weil der Rumpf Prosa ist und in jedem Editor lesbar bleibt.
Das Verzeichnis steht in `.prettierignore`: Prettier würde die Absätze
umbrechen und damit Golden-Tests unbemerkt rot färben.

### Entscheidung 2 — Kopfdaten als JSON-Block, nicht YAML

Jede Datei beginnt mit einem JSON-Objekt zwischen zwei `---`-Zeilen:

```
---
{ "id": "persona/teacher", "version": 1, "kind": "persona",
  "description": "…", "placeholders": ["level"] }
---
Rumpf …
```

Begründung:

- **Ohne Dependency parsbar.** YAML-Frontmatter bräuchte einen Parser
  (`js-yaml` o. ä.); JSON kann Node von Haus aus. Regel 5 des AGENT_GUIDE
  spricht dagegen, für eine Kopfzeile eine Bibliothek zu ziehen.
- **Das optionale `jsonSchema` passt unverändert hinein.** Ein JSON-Schema in
  YAML zu pflegen und beim Laden zu konvertieren wäre eine Fehlerquelle ohne
  Gegenwert — so steht im Template exakt das, was später an den Provider geht.
- **Keine YAML-Fallen** (Norway-Problem, Einrückung, mehrdeutige Typen).

Der Preis sind Anführungszeichen und Kommata beim Schreiben. Das ist
vertretbar: Kopfdaten sind kurz, und ein Syntaxfehler fällt beim Laden mit
Dateinamen und Ursache auf.

**Verworfen:** Begleitdatei (`x.md` + `x.json`) — zwei Dateien, die
auseinanderlaufen können; Metadaten im TypeScript-Code — dann wäre das
Template wieder halb Inline-String.

### Entscheidung 3 — eigene Platzhalter-Ersetzung statt Template-Engine

Die Syntax kennt genau zwei Formen: `{{name}}` für Werte und `{{> partial/id}}`
für Bausteine. Keine Bedingungen, keine Schleifen, keine Filter, keine
Ausdrücke. Die Umsetzung sind ~90 Zeilen in `apps/backend/src/prompts/render.ts`.
**Keine neue Dependency.**

Gegen Handlebars/Nunjucks/Eta sprach nicht das Gewicht, sondern die
Semantik:

- **Strikt in beide Richtungen.** Ein fehlender Wert ist ein Fehler, und ein
  übergebener Wert ohne passenden Platzhalter ebenso. Übliche Engines liefern
  bei fehlenden Variablen einen leeren String — genau der stille Ausfall, den
  ein Prompt-System nicht haben darf, weil eine halbe Anweisung schlimmer ist
  als gar keine.
- **Literale Einsetzung.** Der eingesetzte Wert wird nicht erneut nach
  Platzhaltern durchsucht. Buchtext oder eine Nutzerantwort, in der zufällig
  `{{…}}` steht, kann die Prompt-Struktur nicht verändern. Bei einer Engine
  müsste man dieses Verhalten erst absichern.
- **Prüfung beim Laden.** Weil die Syntax so klein ist, lässt sich beim Start
  abgleichen, dass deklarierte und verwendete Platzhalter exakt übereinstimmen.
  Ein Tippfehler fällt damit beim Start auf, nicht beim ersten Aufruf.

Partials werden **beim Laden** eingesetzt, nicht beim Rendern. Danach enthält
der Rumpf nur noch Wert-Platzhalter, und das Rendern ist ein einziger
literaler Durchlauf. Verschachtelung ist erlaubt und gegen Zyklen sowie eine
Tiefe über 10 Ebenen abgesichert.

### Entscheidung 4 — Versionierung als Zähler, Verlauf über git

Jedes Template trägt `version` als Ganzzahl. Sie wird bei inhaltlichen
Änderungen erhöht und dient als Bezugspunkt für Logs und Auswertungen
(„Bewertung erfolgte mit `persona/grader` v2"). Der eigentliche Verlauf steht
in git; parallele Versionsstände derselben Kennung gibt es **nicht** — dafür
fehlt der Anwendungsfall, und zwei gleichzeitig gültige Fassungen einer
Bewertungs-Persona wären fachlich schwer zu verantworten.

Die Kennung spiegelt konventionsgemäß den Dateipfad ohne Endung. Doppelte
Kennungen brechen den Ladevorgang mit Nennung beider Dateien ab; es wird nichts
stillschweigend überschrieben.

### Entscheidung 5 — Golden-Tests mit gesperrtem Update-Modus

Für jedes Template gibt es mindestens einen Golden-Fall unter
`apps/backend/test/prompts/golden/`. `pnpm prompts:golden` schreibt die Dateien
bewusst neu (`UPDATE_GOLDEN=1`). Läuft der Update-Modus in einer CI-Umgebung
(`CI` gesetzt), bricht die Testdatei sofort mit einer Erklärung ab — sonst
könnte ein Testlauf die Absicherung stillschweigend selbst erneuern.

Ein Abdeckungstest stellt sicher, dass **jede** Template-Kennung in mindestens
einem Golden-Fall vorkommt: Ein neues Template ohne Golden-Datei macht die
Suite rot.

---

## ADR-0026 — Job-Worker als Schleife im Backend-Prozess, nicht als eigener Container

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP2.T2.5 verlangt einen Worker für LLM-Jobs. Zur Wahl standen
  ein eigener Prozess bzw. Container und eine Schleife im vorhandenen
  Backend-Prozess.

### Entscheidung

Der Worker läuft **im Backend-Prozess**, gestartet in `server.ts`, abschaltbar
über `WORKER_ENABLED=false`. Kein zusätzlicher Compose-Service.

### Begründung entlang der geforderten Kriterien

- **Ressourcenkonkurrenz mit HTTP:** Ein LLM-Job wartet fast ausschließlich auf
  I/O — beim CLI-Adapter sogar in einem Prozess **auf dem Host** (ADR-0022), bei
  der API auf HTTPS. Er belegt also kaum CPU im Backend. Die eigentliche
  Begrenzung ist ohnehin die Semaphore aus T2.2 (`LLM_MAX_CONCURRENCY`, Default 2),
  die der Worker mitbenutzt statt sie zu umgehen. Der Worker holt bewusst
  **einen** Job je Durchlauf.
- **SSE ohne Umweg:** Der Statuskanal braucht die Ereignisse des Workers im
  HTTP-Prozess. Im selben Prozess genügt eine Menge von Zuhörern. Ein eigener
  Container bräuchte dafür `LISTEN/NOTIFY` oder Polling — spürbar mehr Technik
  für denselben Zweck.
- **Deploy-Aufwand:** Kein zweites Image, kein zweiter Service, kein zweiter
  Healthcheck. Der Deploy aus AP1 bleibt unverändert; `./deploy/deploy.sh`
  bringt den Worker mit.
- **Betrieb durch einen Einzelnutzer:** Ein Prozess, ein Log, ein Neustart.
  Ein separater Worker wäre ein zweiter Ort, an dem etwas stillstehen kann,
  ohne dass es auffällt.
- **Ausfallverhalten:** Der schwächere Punkt dieser Wahl — stürzt das Backend
  ab, steht auch der Worker. Abgefangen ist das durch zwei Dinge:
  `restart: unless-stopped` in Compose und die Wiederaufnahme verwaister Jobs
  (ADR-0027). Ein Absturz mitten im Job blockiert die Queue also nicht.
- **Kein Root nötig**, keine Änderung an der laufenden Server-Umgebung.

### Wo die Grenze liegt

Die Wahl setzt **eine** Backend-Instanz voraus — nicht wegen der Queue (das
Claiming ist über `FOR UPDATE SKIP LOCKED` mehrinstanzfähig, siehe ADR-0027),
sondern wegen SSE: Der Ereignisbus ist prozessintern, eine zweite Instanz sähe
nur ihre eigenen Jobs. Für den geplanten Einzelnutzer-Betrieb ist das kein
Thema; würde jemals horizontal skaliert, träte an die Stelle des Busses
`LISTEN/NOTIFY` — die Schnittstelle `JobEventBus` bliebe dieselbe.

### Alternativen (verworfen)

- **Eigener Worker-Container** — sauberere Trennung, aber zweites Image,
  zweiter Service und ein Zusatzmechanismus für SSE. Der Gewinn (Isolation der
  CPU-Last) fällt weg, weil die eigentliche Arbeit ohnehin außerhalb des
  Containers passiert.
- **Worker als `pnpm`-Skript neben dem Backend** (wie der CLI-Runner) — würde
  einen weiteren Prozess einführen, der nach einem Reboot von Hand zu starten
  ist. Genau dieses offene Problem hat der Runner schon; ein zweites davon
  wollten wir nicht.
- **Kein Worker, Jobs synchron im Request** — scheidet aus: AP3 setzt hunderte
  Aufrufe ab, ein HTTP-Request kann nicht minutenlang offen bleiben.

---

## ADR-0027 — Job-Claiming: `FOR UPDATE SKIP LOCKED`, Zählung beim Holen, Frist für verwaiste Jobs

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Die Queue liegt in Postgres (`job_queue` aus AP1). Zu klären
  waren die Sperrstrategie, der Zeitpunkt der Versuchszählung und die Frist,
  nach der ein hängengebliebener Job wieder aufgenommen wird.

### Entscheidung 1 — atomares Holen mit `FOR UPDATE SKIP LOCKED`

Ein einziges `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`
setzt Status, Zeitstempel und Zähler in einem Schritt. Ein zweiter Worker
überspringt die gesperrte Zeile, statt zu warten oder sie ebenfalls zu ziehen.

Damit gibt es kein Read-then-Update-Rennen, und zwar unabhängig von der Zahl
der Instanzen — belegt durch einen Test mit zehn gleichzeitigen Versuchen auf
einen Job, von denen genau einer gewinnt. Reihenfolge: `available_at`
aufsteigend, bei Gleichstand `created_at` — älteste zuerst, nachvollziehbar.

**Keine externe Queue-Infrastruktur.** Redis oder ein Broker wären ein
weiterer Dienst mit eigenem Betrieb, eigener Sicherung und eigenem
Ausfallmodus — für einen Einzelnutzer ohne Gegenwert. Postgres kann das, und
Jobs sind so mit denselben Mitteln inspizierbar wie alle anderen Daten.

### Entscheidung 2 — `attempts` wird **beim Holen** erhöht, nicht beim Fehlschlag

Damit zählt auch ein Absturz als Versuch. Ein Job, der den Worker
reproduzierbar umbringt, landet nach `max_attempts` im Dead-Letter statt in
einer Endlosschleife aus Absturz und Wiederaufnahme. Der Preis: Ein Job, dessen
Worker durch einen Neustart des Servers unterbrochen wurde, verliert einen
Versuch, obwohl er nichts falsch gemacht hat. Das ist der bessere Tausch — eine
Schleife bemerkt niemand, ein verlorener Versuch steht in `last_error`.

### Entscheidung 3 — verwaiste Jobs nach 5 Minuten

`WORKER_STALE_AFTER_MS`, Default **300 000 ms**. Ein Job im Zustand `running`,
dessen `claimed_at` länger zurückliegt, wird von derselben Claim-Abfrage
wieder aufgenommen — es braucht keinen zweiten Mechanismus.

Die Zahl folgt aus dem Timeout eines Aufrufs: `LLM_TIMEOUT_MS` ist 120 000 ms,
plus Retry-Backoff und Prozessstart. Fünf Minuten liegen klar darüber, sodass
ein langsamer Job **nicht** doppelt verarbeitet wird, und klar darunter, wo ein
Absturz spürbar wehtäte. **Wer `LLM_TIMEOUT_MS` erhöht, muss diesen Wert
mitziehen** — sonst holt sich der Worker einen Job zurück, der noch läuft.

### Terminalzustände

Der Worker nutzt `done` und `dead`. `failed` aus dem AP1-Skelett bleibt
ungenutzt: Ein Job ist entweder wieder eingeplant (`queued`) oder endgültig
`dead`. Ein dritter Fehlzustand hätte keine eigene Bedeutung. Die CHECK-Regel
der Tabelle bleibt unverändert — keine Migration nötig.

Wiederholt wird ausschließlich, was die Taxonomie aus T2.1 als retrybar
ausweist. Alles andere — Programmfehler, unbekannter Job-Typ, unbrauchbare
Nutzlast — geht **sofort** in den Dead-Letter, ohne dass ein Aufruf abgesetzt
wird. `POST /api/jobs/:id/retry` plant einen toten Job erneut ein und setzt
`attempts` zurück; behobene Ursachen bedeuten damit keine verlorene Arbeit.

---

## ADR-0028 — Aufruf-Protokoll zentral an der Registry, mit sichtbarer Kürzung

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** Jeder KI-Aufruf soll in `llm_call_log` landen. Die Frage war, wo
  das Protokollieren ansetzt und wie große Inhalte behandelt werden — AP3 setzt
  rund 336 Aufrufe mit Base64-Bildern ab.

### Entscheidung 1 — Dekorator um jeden Adapter, in der Provider-Registry

`withCallLog()` legt sich um den Adapter, und die `LlmProviderRegistry` wendet
ihn auf **jeden** Provider an, den sie herausgibt. Wer die Registry benutzt —
und das ist laut INTERFACES.md der einzige erlaubte Weg — protokolliert
automatisch mit.

Der Gegenentwurf, in jedem Aufrufer zu protokollieren, scheitert absehbar:
Ab AP3 kommen fünf Arbeitspakete mit eigenen Aufrufstellen dazu, und die erste
vergessene Zeile fällt erst auf, wenn man einen Fehler sucht und nichts findet.

Zwei Schreibvorgänge je Aufruf: erst `status: 'pending'`, dann das Ergebnis. So
ist ein laufender Aufruf in der Oberfläche sichtbar, und ein Absturz mitten im
Aufruf hinterlässt eine Spur statt gar nichts. **Fehlgeschlagene Aufrufe werden
genauso protokolliert** — gerade sie braucht man.

**Ein Fehler beim Protokollieren lässt den Aufruf nie scheitern.** Er wird
gemeldet und sonst verschluckt: Eine volle Platte darf nicht dazu führen, dass
das Produkt keine Antworten mehr gibt.

### Entscheidung 2 — Bilder nie im Klartext, Rest bei 20 000 Zeichen gekürzt

- **Bildblöcke** erscheinen im Protokoll als
  `[bild image/png, N Zeichen base64 - nicht protokolliert]`. Ein einzelnes
  Chart-Rendering wären sonst mehrere hundert Kilobyte Base64 je Zeile; bei 336
  Aufrufen ist das der Unterschied zwischen einer lesbaren Tabelle und einer
  unbenutzbaren.
- **Prompt und Antwort** werden bei `LLM_LOG_MAX_CHARS` Zeichen abgeschnitten,
  Default **20 000**. Das reicht für jeden Prompt aus T2.4 samt Kontext und
  bleibt weit unter dem, was eine Zeile unhandlich macht.
- Gekürzt wird **sichtbar**: Es folgt die Markierung
  `… [gekuerzt]: N von M Zeichen entfernt`. Wer sie sieht, weiß, dass etwas
  fehlt und wie viel — eine stille Kürzung wäre schlimmer als gar keine, weil
  man einem abgeschnittenen Prompt sonst nicht ansieht, dass er unvollständig
  ist.

Der Vollständigkeit halber: Prompts und Antworten werden bewusst protokolliert
(sie sind der Gegenstand der Fehlersuche), Zugangsdaten niemals — der
API-Schlüssel läuft vor jeder Ausgabe durch die Ausschwärzung aus ADR-0024.

---

## ADR-0029 — Laufzeit-Einstellungen: Vertrag in `packages/shared`, Prüfung serverseitig, Ping mit Sperre

- **Datum:** 2026-08-23
- **Status:** angenommen
- **Kontext:** AP2.T2.6 macht Provider, Modell und die Aufrufparameter zur
  Laufzeit umschaltbar. Zu entscheiden waren: wo der Vertrag lebt, wie geprüft
  wird, wie eine Änderung ohne Neustart wirkt und wie der Ping-Test gegen
  Missbrauch abgesichert ist.

### Entscheidung 1 — Vertrag in `packages/shared`, Werte in der `config`-Tabelle

`packages/shared/src/settings.ts` definiert Felder, erlaubte Modelle und die
zulässigen Spannen; gespeichert wird in der `config`-Tabelle aus AP1 unter
`llm.provider`, `llm.model`, `llm.timeout_ms`, `llm.max_concurrency`,
`llm.max_attempts`.

Damit kennt die Oberfläche die Grenzen aus **derselben** Quelle wie der Server
und muss nichts hartkodieren: `GET /api/llm/settings` liefert Werte, Herkunft
(`config` oder `default`), Modellauswahl und Spannen mit.

**Defaults kommen aus der Umgebungskonfiguration** (`LLM_MODEL`,
`LLM_TIMEOUT_MS`, …), nicht aus einem zweiten Satz Zahlen im Code. Ein nicht
gesetzter Wert ist damit exakt das, was ohne Tabelle gälte.

### Entscheidung 2 — Prüfung ausschließlich serverseitig, feldweise

Die Oberfläche schränkt ein (Auswahllisten, `min`/`max`), aber **entschieden
wird auf dem Server**. Abgelehnt wird mit HTTP 400 und einer Liste
`{ field, message }` — die UI hängt die Meldung ans jeweilige Feld statt an die
Seite.

Zwei Punkte, die bewusst streng sind:

- **Kein stiller Rückfall auf Defaults.** Ein ungültiger Wert wird abgelehnt,
  nicht ersetzt. Sonst zeigte die Oberfläche eine Einstellung an, die niemand
  benutzt.
- **Unbekannte Felder werden abgelehnt**, nicht ignoriert. Ein Tippfehler oder
  eine fachliche Einstellung aus einem späteren AP (`mastery_threshold`) fällt
  damit sofort auf, statt wirkungslos in der Tabelle zu liegen.

Steht in der Tabelle trotzdem ein unbrauchbarer Wert — etwa nach einem
manuellen SQL-Eingriff —, gilt der Default und die Herkunft wird als `default`
ausgewiesen. Auch das ist sichtbar, nicht still.

### Entscheidung 3 — Umschaltung ohne Neustart über die Registry

Die `LlmProviderRegistry` liest die Einstellungen bei **jedem** `getActive()`.
Provider und Modell wirken damit ab dem nächsten Aufruf. Nebenläufigkeit,
Versuche und Timeout fließen beim **Bau** eines Adapters ein — ändert sich
einer dieser Werte, verwirft die Registry ihren Zwischenspeicher und baut den
Adapter neu. Ohne das wäre „gilt ab dem nächsten Aufruf" für drei der fünf
Felder unwahr gewesen.

Der Preis ist eine Datenbankabfrage je Aufruf. Vertretbar: Der Aufruf selbst
dauert Sekunden, die Abfrage Mikrosekunden — dieselbe Abwägung wie in ADR-0024.

### Entscheidung 4 — Ping-Test geht durch die Registry, mit Sperrzeit

Der Testaufruf nimmt **denselben** Weg wie jeder andere Aufruf. Dadurch greifen
Aufruf-Protokoll (ADR-0028) und Fehler-Taxonomie automatisch; es gibt keinen
zweiten Pfad, der anders protokolliert oder anders scheitert.

- **Sparsam:** Prompt „Antworte nur mit OK", `maxTokens` 1024. Nicht kleiner —
  die Claude CLI kürzt nicht, sondern bricht ab, wenn die Antwort das Limit
  sprengt (T2.2). Mit 64 Tokens scheiterte der Ping in der laufenden Instanz
  reproduzierbar.
- **Sperrzeit 10 Sekunden** zwischen zwei Pings (`pingCooldownMs`). Ein
  hängender Button oder ein Doppelklick kostet damit höchstens einen Aufruf.
  Über 429 mit Klartext, nicht stillschweigend.
- **Nie automatisch:** Der Ping läuft nur auf ausdrückliche Aktion, nie beim
  Laden der Seite. Die Oberfläche sagt vorher, dass er echtes Kontingent kostet.
- **Fehlschlag ist kein HTTP-Fehler.** Ein nicht erreichbarer Provider ergibt
  200 mit `{ ok: false, kind, message, hint }` — der Testaufruf hat ja
  funktioniert, sein Ergebnis lautet nur „geht nicht". Je Kategorie gibt es
  einen Klartext-Hinweis, was zu tun ist.
- Optional lässt sich ein **anderer** Provider testen (`{ provider: 'api' }`),
  ohne die gespeicherte Wahl zu ändern — ausdrücklicher Parameter, kein
  versteckter Nebeneffekt.

### Entscheidung 5 — Der API-Schlüssel bleibt auf dem Server

`GET /api/llm/settings` liefert `apiKeyConfigured: true|false` — mehr nicht.
Kein maskierter Wert, keine Länge, kein Präfix. Wer den Schlüssel ändern will,
tut das in der `.env` (RUNBOOK 9.5); die Oberfläche ist bewusst kein
Secret-Manager.

**Keine neuen Dependencies in T2.6.**

---

## ADR-0030 — Buch-Parser: Kapitelstruktur aus dem Inhaltsverzeichnis, Schema mit fachlichen Schlüsseln, Klassifikation regelbasiert

- **Datum:** 2026-08-24
- **Status:** angenommen
- **Kontext:** AP3.T3.1 macht die Buchquelle zur Wissensbasis. Zu entscheiden
  waren: woraus die Kapitelstruktur kommt, wie die drei Tabellen geschnitten
  sind, wie ein erneuter Import sich verhält und wie Range-Charts von allem
  anderen unterschieden werden — Letzteres entscheidet in T3.3 über den
  Kontingentverbrauch.

### Entscheidung 1 — Kapitel kommen aus dem Inhaltsverzeichnis, nicht aus den Überschriften

Der naheliegende Weg — Kapitel an `# NN TITEL` erkennen — scheitert an der
Quelle selbst: Zwei der vierzehn Kapitel stehen dort **ohne Nummer**, vier
weitere sind über **zwei** Überschriftszeilen umbrochen (`# 06 THE THEORY OF`
gefolgt von `# TOURNAMENT PLAY`). Ein rein überschriftenbasierter Parser fände
12 statt 14 Kapitel und ordnete außerdem keine Teile zu.

Das Inhaltsverzeichnis des Buches nennt dagegen Teile und Kapitel vollständig
und nummeriert. Es wird als **Sollstruktur** gelesen; jedes Kapitel wird
anschließend im Fließtext verankert — über die Nummer, ersatzweise über den
normalisierten Titel. Umbrochene Titel werden zusammengesetzt, solange das
bisher Gelesene ein echter Präfix des Solltitels ist.

- **Alternative „nur Überschriften":** verworfen, findet die Struktur nicht.
- **Alternative „Kapitelliste im Code hinterlegen":** verworfen. Die Titel
  stammen dann nicht mehr aus der Quelle, und die Leitplanke „keine erfundenen
  Kapitelnamen" wäre nur noch Absichtserklärung.
- **Rückfallebene:** Fehlt ein Inhaltsverzeichnis (kleine Fixtures), greift die
  Ableitung aus nummerierten Überschriften — mit einer Meldung `toc-missing`
  im Report, nicht stillschweigend.

Weicht das Ergebnis von 14 Kapiteln in 3 Teilen ab, erscheint das als
`chapter-count`/`part-count` im Report. Der Parser repariert nichts.

### Entscheidung 2 — Schema: drei Tabellen, fachlicher Schlüssel je Zeile, Volltext in der Sektion

`book_chapter` → `book_section` → `book_asset`. Der Zuschnitt der Sektionen
folgt **jeder** Überschrift der Quelle (`##`, `###`), nicht dem Kapitel: Ab AP5
sollen einzelne Sektionen gezielt geladen werden, und eine Sektion je Kapitel
wäre für den Kontext zu grob (die größten Kapitel hätten sonst je >100 kB Text).

Jede Tabelle trägt einen fachlichen Schlüssel mit Unique-Index
(`chapter_number`, `section_key`, `relative_path`). `section_key` enthält
bewusst **keine laufende Nummer** — ein eingeschobener Abschnitt würde sonst
alle folgenden Schlüssel verschieben und beim nächsten Import zu
Neuanlage-plus-Wegfall statt zu einer Änderung führen.

Bildunterschriften liegen **doppelt** vor: `caption_raw` unverändert und
daneben die geparsten Bestandteile (`caption_label`, `caption_number`,
`caption_spot`, `caption_actions`). Der Rohtext ist in T3.4 die unabhängige
Gegenprobe zur Vision-Extraktion — was hier normalisiert würde, wäre dort nicht
mehr rekonstruierbar.

### Entscheidung 3 — Idempotenz über Inhaltshash, Wegfall über `removed_at`

Je Zeile ein SHA-256 über den fachlichen Inhalt. Gleicher Hash ⇒ die Zeile wird
**nicht angefasst**, auch `updated_at` bleibt stehen. Anderer Hash ⇒ Update auf
derselben `id`.

Zeilen, deren Schlüssel nicht mehr in der Quelle vorkommt, bekommen
`removed_at` gesetzt und werden **nicht gelöscht**.

Der Grund ist nicht Ordnungsliebe: Ab T3.3 hängen Chart-Daten an
`book_asset.id`. Ein Import, der Assets löscht und neu anlegt, würde bei jedem
Lauf die Ergebnisse hunderter Vision-Aufrufe verwaisen lassen — genau den
teuersten Datenbestand des Projekts.

- **Alternative „truncate + insert":** verworfen, siehe oben.
- **Alternative „Hash über die ganze Datei":** verworfen. Eine Tippfehler-
  korrektur im Buch würde dann alle 855 Assets als geändert melden.

### Entscheidung 4 — Klassifikation regelbasiert, unsichere Fälle bleiben unsicher

Die Typisierung (`hand_range`, `table`, `diagram`, `formula`, `other`) läuft
über eine feste Regeltabelle auf Bildunterschrift und Textumfeld — **ohne
KI-Aufruf**. Zwei Gründe: Der Schritt ist ein _Filter vor_ der Vision-Pipeline
und darf nicht selbst Kontingent verbrauchen; und ein regelbasiertes Ergebnis
ist reproduzierbar, ein Modellurteil über 855 Bilder nicht.

Tragfähig ist das, weil die Quelle ihre Abbildungen durchnummeriert
beschriftet. Der Import belegt es: `Hand Range 1–348`, `Table 1–170`,
`Diagram 1–133`, `Heatmap 1–4` — **lückenlos**, jede Nummer genau einmal
vergeben. Der Report weist Lücken je Etikett aus; solange dort „keine" steht,
ist kein beschriftetes Chart übersehen worden.

Was die Regeln nicht sicher entscheiden, wird **nicht geraten**: Es landet als
`other` mit `classification_confidence = 'uncertain'` und ist im Report gezählt
(aktuell 59 von 855). Die Regelnamen stehen in `classification_rule`, damit im
Nachhinein prüfbar ist, warum ein Asset seinen Typ hat.

Wirkung: 348 statt 855 Vision-Aufrufe in T3.3 — rund 60 % weniger Kontingent,
und keine Formelbilder oder Autorenfotos in der Chart-Datenbank.

### Entscheidung 5 — Struktur der Quelle tolerant erkennen, aber nicht raten

Die README aus T1.1 beschreibt flache Bildablage; die tatsächliche Quelle legt
sie in ein Unterverzeichnis (so exportiert das PDF-nach-Markdown-Werkzeug, und
so zeigen die Bildbezüge im Markdown). Der Parser akzeptiert **beide** Formen
und nennt die gefundene im Report. Mehr als ein bildhaltiges Unterverzeichnis
ist ein Abbruchgrund — dann ist die Ablage mehrdeutig, und Raten wäre schlechter
als eine klare Fehlermeldung. README und INTERFACES Abschnitt 5 sind
entsprechend nachgezogen.

### Entscheidung 6 — Report nach `data/reports/`, git-ignoriert

Der Import-Report enthält Kapitel- und Sektionstitel sowie Bildunterschriften —
Buchinhalt. Er wird deshalb nach `data/reports/book-import.md` geschrieben und
ist git-ignoriert, wie `data/book-source/` selbst. Im Repository stehen nur die
Zahlen, die für die Abnahme nötig sind (Statusbericht).

**Keine neuen Dependencies in T3.1.**

Ergänzend behoben: `packages/shared/package.json` hatte in `exports` nur die
Bedingung `import`. drizzle-kit bündelt `schema.ts` samt `drizzle.config.ts`
im CJS-Modus und konnte das Workspace-Paket dadurch seit AP2 nicht mehr
auflösen — `pnpm db:generate` scheiterte. Eine zusätzliche `default`-Bedingung
auf dieselbe Datei stellt das wieder her.

---

## ADR-0031 — Konzept-Taxonomie: zwölf feste Themenbereiche, Zuschnitt „prüfbare Lerneinheit", deterministische Nachbearbeitung

- **Datum:** 2026-08-24
- **Status:** angenommen
- **Kontext:** AP3.T3.2 baut den Konzept-Graphen — das Rückgrat des gesamten
  Lernpfads. Zu entscheiden waren: welche Themenbereiche es gibt (AP4 führt
  darauf Skill-Ratings und kann sie später kaum noch ändern), woran ein Konzept
  geschnitten wird, wie die KI-Vorschläge geprüft werden und was mit Zyklen und
  Dubletten geschieht.

### Entscheidung 1 — Zwölf feste Themenbereiche, genau einer je Konzept

Die Liste steht als `CONCEPT_TOPIC_AREAS` in `packages/shared/src/concept.ts`
und als CHECK-Constraint auf `concept.topic_area`:

`grundlagen-mathematik` · `spieltheorie` · `software-werkzeuge` ·
`preflop-ranges` · `preflop-verteidigung` · `spiel-gegen-3bets` ·
`turnier-metriken-icm` · `postflop-grundlagen` · `flop-spiel` · `turn-spiel` ·
`river-spiel` · `mental-game`

Zuschnitt entlang der **Struktur des Buches**, nicht entlang einer freien
Systematik: Jedes der 14 Kapitel findet mindestens einen Bereich, und jeder
Bereich hat mindestens ein Kapitel. `software-werkzeuge` ist gegenüber der im
Auftrag skizzierten Liste ergänzt — Kapitel 3 behandelt ausschließlich
Solver und Analysewerkzeuge und hätte sonst keinen Platz; ohne den Bereich
landeten seine Konzepte in `spieltheorie` und verzerrten dort das Rating.

**Genau ein Bereich je Konzept.** Eine Mehrfachzuordnung wäre fachlich oft
richtig, macht aber jede Kennzahl unscharf: Ein Konzept in drei Bereichen
zählt dreimal, und ein Rating „62 % in Flop-Spiel" wäre nicht mehr
interpretierbar. Wo ein Konzept an einer Grenze liegt, entscheidet die Review.

Ein Wert außerhalb der Liste wird **abgelehnt**, nicht auf einen Default
umgebogen. Ein falsch einsortiertes Konzept fällt später niemandem mehr auf;
ein abgelehnter Vorschlag steht im Protokoll des Laufs.

### Entscheidung 2 — Zuschnitt: „verstehen, anwenden, prüfen"

Ein Konzept ist etwas, zu dem sich eine Frage stellen lässt, deren Antwort
eindeutig richtig oder falsch ist. Gliederungsüberschriften („Weitere
Überlegungen") sind keine. Die Prompt-Anweisung nennt das ausdrücklich, und
die Persona `persona/taxonomist` trägt es als Rolle.

Die Grenze nach unten: Braucht die Kurzdefinition ein „und", um zwei
unabhängige Dinge zu verbinden, sind es zwei Konzepte. Die Grenze nach oben:
Die Zielgröße von 120–200 über 14 Kapitel entspricht ~9–14 je Kapitel — fein
genug für gezielte Wiederholung in AP4, grob genug, dass ein Lernpfad nicht
aus 600 Trivialschritten besteht.

**Die Obergrenze je Teillauf ist bindend, nicht bloß erbeten.** Ein erster
Anlauf mit der Formulierung „ungefähr N Konzepte" ergab hochgerechnet rund 350
Konzepte — das Modell nahm die Zahl als Untergrenze. Zwei Änderungen halten das
Band jetzt: Der Prompt nennt N als **Höchstzahl** und lässt nach Wichtigkeit
sortieren, und der Handler kappt die Liste zusätzlich bei N. Die Kappung ist
die deterministische Rückversicherung — ohne sie hinge die Größe des Graphen
daran, wie streng ein Modell eine Zahl im Prompt nimmt. Wie viel gekappt wurde,
steht je Teillauf im Serverprotokoll.

**Kurzdefinitionen enthalten keine Zahlenwerte.** Keine Frequenzen, keine
Ranges, keine Chart-Werte. Diese Wahrheiten liegen ab T3.3/T3.4 in den
Chart-Daten; eine zweite, vom Modell geschätzte Fassung im Konzepttext wäre
genau die Sorte Halbwahrheit, gegen die R2 im Gesamtscope schützt. Der Prompt
verlangt stattdessen einen Verweis auf das zugehörige Chart, und
`partial/data-truth` ist eingebunden.

### Entscheidung 3 — Eine eigene Persona statt `persona/analyst`

`persona/analyst` ist auf die Auswertung von **Trainingsdaten** geschrieben
(Stichprobe, Muster, Belege je Datensatz). Für die Zerlegung eines Fachtexts
in Begriffe passt das nicht: Die Rolle drängt zu „Befunden" statt zu einer
Begriffsliste. Deshalb `persona/taxonomist` — dieselben Bausteine
(`partial/language`), aber die richtige Aufgabenbeschreibung.

`partial/data-truth` ist bewusst im **Task** eingebunden, nicht in der Persona:
So steht die strengste Regel des Projekts direkt neben den Daten, auf die sie
sich bezieht.

### Entscheidung 4 — Ein Job je Kapitelteil, nicht je Buch und nicht je Sektion

Zeichenbudget **15 000 Zeichen** (~4 000 Token) je Lauf, Sektionen werden nie
zerschnitten. Das ergibt für dieses Buch 53 Läufe.

Der Wert ist **gemessen, nicht geschätzt**. Der erste Anlauf lief mit 45 000
Zeichen: Ein einzelner Aufruf über die Claude CLI brauchte dort mehr als zehn
Minuten und lief ins Zeitlimit; ein anderer sprengte die Ausgabegrenze der CLI
von 8 192 Tokens. Mit 15 000 Zeichen antwortet derselbe Aufruf in ein bis zwei
Minuten. Die Gesamtmenge an Eingabetext ist dieselbe — sie verteilt sich nur
auf mehr, dafür einzeln wiederholbare Läufe. Beide Fehlerbilder samt Abhilfe
stehen im RUNBOOK 12.1.

- **Ein Lauf je Buch** wäre ein Prompt von rund 620 000 Zeichen — teuer, und
  bei jedem Fehlschlag komplett zu wiederholen.
- **Ein Lauf je Sektion** (367 Läufe) sähe den Zusammenhang nicht und lieferte
  Gliederung statt Fachbegriffe. Außerdem: 7× so viele Aufrufe.
- **Ein Lauf je Kapitel** wäre beim längsten Kapitel (77 532 Zeichen) weit
  jenseits dessen, was ein Aufruf in vertretbarer Zeit schafft.

Jeder Teillauf bekommt die **bereits bekannten Konzepte** mit. Das erlaubt
Voraussetzungen über Kapitelgrenzen hinweg und verhindert, dass derselbe
Begriff in Kapitel 8 noch einmal erfunden wird. Weil der Worker die Jobs
nacheinander abarbeitet, wächst diese Liste in Buchreihenfolge.

Zwischenergebnisse werden je Teillauf persistiert: Ein fehlgeschlagenes
Kapitel zieht die übrigen nicht mit, und bei `rate_limit` legt die Queue den
Job wieder vor, statt den ganzen Lauf zu verlieren.

### Entscheidung 5 — Zyklen: gar nicht erst speichern, aber melden

Ein Zyklus im Prerequisite-Graphen macht den Lernpfad in AP5 unableitbar. Die
Zyklenfreiheit ist aber eine Eigenschaft des ganzen Graphen und lässt sich
nicht als Constraint schreiben.

Gewählt: **Jede neue Kante wird gegen den bestehenden Graphen geprüft.** Was
einen Zyklus schlösse, wird nicht gespeichert — beim Import (`selectAcyclicEdges`)
wie in der Review-Ansicht (`replacePrerequisites`, HTTP 400 mit Begründung).
Die Datenbank ist damit **jederzeit** zyklenfrei.

- **Alternative „speichern und hinterher prüfen":** verworfen. Zwischen Import
  und Review gäbe es Zeitfenster, in denen kein Lernpfad ableitbar ist, und
  eine Reparatur müsste raten, welche Kante die falsche war.
- **Alternative „Zyklus auflösen lassen":** verworfen — das wäre eine fachliche
  Entscheidung und gehört in die Review, nicht in eine Heuristik.

Der Konflikt geht trotzdem nicht verloren: Er zählt im Ergebnis des Laufs und
erscheint als Befund `cycle`, sobald doch einer entsteht (etwa durch direkt
in der Datenbank gesetzte Kanten).

### Entscheidung 6 — Dubletten über den normalisierten Titel zusammenführen

`conceptSlug()` normalisiert aggressiv: Kleinschreibung, Umlaute,
Klammerzusätze, führende Artikel, alle Nicht-Alphanumerik. „Die Minimum
Defense Frequency (MDF)" und „minimum defense frequency" ergeben denselben
Slug — und `concept_slug_key` macht daraus genau eine Zeile.

Bei einem Treffer bleibt das Konzept, **wo es zuerst eingeführt wurde**. Das
ist die didaktisch richtige Stelle: Wer den Begriff zum ersten Mal braucht,
lernt ihn dort. Ein Konzept, das in Kapitel 8 noch einmal auftaucht, ist keine
neue Einheit, sondern eine Wiederholung.

Derselbe Slug trägt auch die Auflösung der Voraussetzungen — ein Verweis auf
„MDF" findet das Konzept „Minimum Defense Frequency", ohne dass das Modell
IDs kennen müsste.

### Entscheidung 7 — Nachbearbeitung ist Code, nicht ein zweiter Modellaufruf

Referenzauflösung, Zyklenprüfung, Dubletten-Erkennung, Themenbereichsprüfung
und die Chart-Zuordnung sind deterministische Funktionen mit Tests. Ein
zweites Modell zur Prüfung des ersten wäre teurer, langsamer und selbst
fehlbar — und das Ergebnis wäre bei jedem Lauf ein anderes.

Die Chart-Zuordnung ist bewusst **grob**: Ein `hand_range`-Asset gehört
zunächst zu jedem Konzept, dem seine Sektion zugeordnet ist. T3.3/T3.4
verfeinern das mit Spot-Metadaten. Eine KI für eine Zuordnung einzusetzen, die
ohnehin überschrieben wird, wäre verschwendetes Kontingent.

### Entscheidung 8 — Review-Endpunkte getrennt von der Content-API

`/api/concepts` ist die Prüfoberfläche dieses Tasks. Die Content-API für
Folge-APs (gezielter Abruf, Spot-Suche, Asset-Auslieferung) entsteht in T3.5
unter `/api/content` und ist hier nicht vorweggenommen. Getrennte Namensräume,
weil die Zielgruppen verschieden sind: hier ein Mensch beim Prüfen, dort
Folge-APs beim Kontext-Retrieval.

**Keine neuen Dependencies in T3.2.**

---

## ADR-0032 — Chart-Daten: geschlossene Aktionsmenge, Zellen als eigene Tabelle, Spot deterministisch aus der Unterschrift

- **Datum:** 2026-08-24
- **Status:** angenommen
- **Kontext:** AP3.T3.3 macht aus 348 Chart-Bildern maschinenlesbare Daten.
  Diese Zahlen sind ab hier die **einzige Wahrheitsquelle** für jede objektiv
  prüfbare Frage im Tool (Risiko R2 im Gesamtscope). Zu entscheiden waren:
  welche Aktionen es geben darf, wie die Matrix abgelegt wird, woher die
  Spot-Metadaten kommen und was mit unvollständigen Ergebnissen geschieht.

### Entscheidung 1 — Zehn Aktionsarten, Sizing daneben

`CHART_ACTION_KINDS` ist geschlossen: `fold`, `check`, `call`, `limp`, `bet`,
`raise`, `three_bet`, `four_bet`, `five_bet`, `all_in`.

Die Liste ist **aus den tatsächlichen Bildunterschriften abgeleitet**, nicht
erfunden. Eine Abfrage über `book_asset.caption_actions` der 348 Range-Charts
ergibt 31 verschiedene Beschriftungen — darunter `Fold` (297×), `Call` (213×),
`All-in` (119×), `3-bet` (67×), aber auch `Raise 2.25x`, `3Bet 10bb`,
`Bet Full Pot`, `5-bet All-in` und `Call All-in`. Diese 31 Beschriftungen sind
zehn Arten in unterschiedlichen Größen.

Die **Größe** steht deshalb daneben als normalisierte Zeichenkette (`2.5x`,
`10bb`, `pot`), nicht als eigene Art. Sizings sind Zahlen und lassen sich nicht
sinnvoll aufzählen; die Art dagegen schon, und Vergleiche und Suche stützen
sich auf sie.

- **Alternative „freier Text":** verworfen. „3-bet", „3Bet 10bb" und
  „3-bet all-in" wären drei verschiedene Aktionen, und keine Auswertung könnte
  sie zusammenführen.
- **Alternative „jede Beschriftung eine eigene Art":** verworfen. 31 Arten
  heute, unbekannt viele nach dem nächsten Buch — und `raise@2.5x` vs.
  `raise@3x` wäre ein Artunterschied statt eines Größenunterschieds.

Mehrdeutigkeiten sind bewusst aufgelöst: `5-bet All-in` ist ein `five_bet` mit
Sizing `all-in`, `Call All-in` ist ein `call`. Die Reihenfolge der Regeln in
`parseChartAction()` erzwingt das.

### Entscheidung 2 — Die Matrix als Zeilen, nicht als Blob

`range_chart_cell` ist eine eigene Tabelle mit
`(chart_id, hand, action_kind, sizing, percent)` und Index auf
`(hand, action_kind)`. Eine Zelle mit Mischfrequenz ergibt mehrere Zeilen.

Der Grund ist der Zugriff der Folge-APs: Die Spot-Suche aus T3.5 und die Drills
aus AP7 fragen „was macht AJs in diesem Spot?". Mit der Tabelle beantwortet das
ein Index. Mit einem `jsonb`-Blob am Chart müsste jede solche Frage das ganze
Chart laden und parsen — bei 348 Charts × 169 Zellen ist das der Unterschied
zwischen einer Abfrage und einem Vollscan.

Größenordnung: 348 Charts × ~200 Zeilen ≈ 70 000 Zeilen. Für Postgres nichts.

- **Alternative „Blob plus generierte Spalten":** verworfen; komplizierter als
  eine Tabelle und ohne Vorteil.
- Der Chart trägt daneben eine **Legende** (`actions`) als `jsonb`. Sie ist
  Metadaten über die Matrix, keine abfragbare Größe.

### Entscheidung 3 — Der Spot kommt aus der Unterschrift, nicht vom Modell

Position, Gegenposition, Stacktiefe, Aktionsfolge und Sizings liest
`apps/backend/src/chart/spot.ts` **deterministisch** aus dem beschreibenden
Teil der Bildunterschrift (`SB vs BB (15bb)`, `CO 25bb (2x vs SB 3x 3-bet)`).
Das Modell bekommt das Ergebnis als Kontext mit — es soll den Spot richtig
einordnen —, bestimmt es aber nicht.

Der Grund ist derselbe wie überall in diesem Projekt: Was sich mit einer Regel
entscheiden lässt, entscheidet eine Regel. Ein Modell, das die Stacktiefe aus
dem Bild schätzt, liegt gelegentlich daneben, und niemand merkt es. Was die
Unterschrift nicht hergibt, bleibt `null` — eine benannte Lücke statt einer
plausiblen Erfindung.

### Entscheidung 4 — Unvollständig ist `failed`, nicht „teilweise gut"

`validateChartMatrix()` verlangt genau 169 Zellen, jedes Blatt genau einmal,
mindestens eine Aktion je Zelle, nur bekannte Arten, Frequenzen zwischen 0 und 100. Wird das verletzt, landet der Chart als `state = 'failed'` mit Begründung
in `failure_reason` — er wird trotzdem gespeichert, damit sichtbar bleibt, was
das Modell geliefert hat.

Ein halb gelesenes Chart ist gefährlicher als ein fehlendes: Es sieht in jeder
Auswertung wie ein vollständiges aus, und die fehlenden Blätter wären still
„nicht in der Range".

**Ausdrücklich nicht hier:** die Frequenzsummen-Prüfung je Hand, der
gewichtete Abgleich gegen die Caption-Prozente und die Plausibilitätsregeln.
Das ist T3.4. Hier geht es allein um strukturelle Vollständigkeit.

### Entscheidung 5 — Ein Job je Chart, Wiederaufnahme über den Datenbestand

Ein Job je Chart-Bild, nicht einer je Charge. Damit wirkt ein Retry gezielt,
ein Abbruch verliert höchstens den laufenden Chart, und ein `rate_limit` legt
genau diesen einen Job wieder vor.

Die **Wiederaufnahme** braucht keinen eigenen Zustand: `selectCandidates()`
wählt Assets, zu denen noch kein `range_chart` existiert. Ein zweiter Lauf ruft
deshalb nichts noch einmal auf. Das ist robuster als eine Fortschrittsdatei —
der Datenbestand _ist_ der Fortschritt.

- **Alternative „Batch-Job über alle Charts":** verworfen. Ein Wochenlimit
  mitten im Lauf würde die ganze Charge kosten.
- **Alternative „Lauf-Tabelle mit Cursor":** verworfen; zwei Wahrheiten über
  denselben Sachverhalt.

### Entscheidung 6 — Bilder gehen über `renderRequest`, nicht am Template vorbei

`RenderOptions` bekam eine Option `images`. Der Provider-Request entsteht damit
weiterhin an **einer** Stelle. Das Bild selbst gehört nicht in die
Template-Datei — es ist Nutzlast, keine Prompt-Fassung. Im Aufruf-Protokoll
erscheint es als Kurzvermerk (ADR-0028); diese Kürzung wird nicht umgangen,
sonst würde `llm_call_log` bei 348 Bildern um mehrere hundert Megabyte wachsen.

**Keine neuen Dependencies in T3.3.**

---

## ADR-0033 — Modellwahl für die Chart-Digitalisierung: `claude-sonnet-5`, mit angehobener Zeitgrenze

- **Datum:** 2026-08-24
- **Status:** angenommen
- **Kontext:** Scope-Delta 3 der AP-Datei verlangt einen Kalibrierungslauf, bevor
  hunderte Vision-Aufrufe laufen. Eingestellt war `claude-haiku-4-5` als Rest
  des Ping-Tests aus T2.6. Falsche Frequenzen in der Datenbank vergiften jeden
  späteren Drill, jede Bewertung und jedes Szenario (Risiko R2) — die Wahl darf
  deshalb nicht nach Bauchgefühl fallen.

### Die Stichprobe

Acht Charts, bewusst nach **Bauart** ausgewählt, nicht nach Reihenfolge.
Sollwerte in `apps/backend/test/chart/fixtures/calibration-reference.json`:
die Prozentwerte der Bildunterschrift für alle acht, dazu 31 von Hand aus dem
Bild abgelesene Einzelzellen für die drei aussagekräftigsten.

| HR  | Bauart                                               | Warum in der Stichprobe                                          |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Strukturraster ohne Aktionsfarben                    | Ehrlichkeitsprobe — 41 der 348 Bilder tragen keine Frequenzen    |
| 7   | 3 Aktionen, dichte Mischfrequenzen (BB-Verteidigung) | dichtester Fall; hier scheitern schwache Modelle an den Anteilen |
| 8   | 2 Aktionen, zweifarbig ohne Mischzellen              | einfachster Fall — wer den nicht liest, scheidet sofort aus      |
| 11  | 2 Aktionen, Call/Fold statt Raise/Fold               | prüft, ob die Legende gelesen und nicht geraten wird             |
| 96  | 3 Aktionen, Push/Limp/Fold, viele schmale Anteile    | typischer Turnier-Chart                                          |
| 99  | 4 Aktionen **mit Sizing** (Raise 3.3x)               | prüft die Trennung von Aktionsart und Größenangabe               |
| 300 | 3 Aktionen, Reaktion auf 3-Bet                       | Spot mit Aktionsfolge in der Unterschrift                        |
| 348 | 4 Aktionen, extrem fold-lastig (82,9 % Fold)         | Randfall: „alles Fold" sieht hier scheinbar fast richtig aus     |

### Die Messwerte

| Modell             | beantwortet | vollständig | Referenzzellen | Ø Caption-Abweichung |   Dauer |  Tokens |
| ------------------ | ----------: | ----------: | -------------: | -------------------: | ------: | ------: |
| `claude-haiku-4-5` |         8/8 | 8/8 (100 %) |   22/32 (69 %) |          **19,9 pp** | 1 305 s | 264 888 |
| `claude-sonnet-5`  |         4/8 |  4/8 (50 %) |   20/32 (63 %) |           **3,5 pp** | 2 841 s |  83 083 |

Je Chart, die aussagekräftigen Fälle:

| HR  | Haiku Zellen | Haiku Abw. | Sonnet Zellen | Sonnet Abw. |
| --- | -----------: | ---------: | ------------: | ----------: |
| 1   | korrekt leer |          — |  korrekt leer |           — |
| 8   |        11/12 |     1,8 pp |     **12/12** |  **0,3 pp** |
| 96  |          5/9 |    40,3 pp |       **7/9** |  **2,4 pp** |
| 99  |         5/10 |    22,3 pp |       Timeout |           — |
| 11  |            — |    22,7 pp |             — |      7,9 pp |
| 7   |            — |    22,5 pp |       Timeout |           — |
| 300 |            — |    24,9 pp |       Timeout |           — |
| 348 |            — |     4,7 pp |       Timeout |           — |

### Entscheidung — `claude-sonnet-5`

**Entscheidend ist die Caption-Abweichung, nicht die Vollständigkeitsquote.**

Die Prozentwerte der Bildunterschrift sind eine vom Bild unabhängige Wahrheit:
Das Buch nennt sie, und sie lassen sich aus der abgelesenen Matrix
Combo-gewichtet nachrechnen. T3.4 prüft genau das mit einer Toleranz von
±1,5 pp.

- Haiku liegt im Mittel **19,9 pp** daneben — bei fünf von sechs Charts
  zwischen 22 und 40 pp. Mit dieser Streuung würde in T3.4 praktisch **jeder**
  Chart durchfallen. Haiku liefert zuverlässig 169 Zellen, aber die Zahlen
  darin sind falsch. Eine vollständige Matrix mit falschen Werten ist der
  gefährlichste Fall überhaupt: Sie sieht in jeder Auswertung gesund aus.
- Sonnet liegt im Mittel **3,5 pp** daneben, auf den beiden Charts mit
  Referenzzellen bei 0,3 pp und 2,4 pp. Auf den Zellen, die es tatsächlich
  gelesen hat, trifft es **20 von 22** (91 %); Haiku auf denselben Charts
  21 von 31 (68 %).
- Bei HR 8 las Sonnet zusätzlich die **Sizing-Angabe** (`raise 2.25x`) korrekt
  mit und meldete den scheinbaren Widerspruch zur Unterschrift als offene
  Frage, statt seine Ablesung daran anzupassen — genau das Verhalten, das
  `partial/data-truth` verlangt.
- Beide Modelle bestanden die Ehrlichkeitsprobe (HR 1): leere Matrix mit
  Begründung, keine erfundene Strategie.

Sonnet ist außerdem **sparsamer**: 83 083 Tokens für vier gelesene Charts
gegen 264 888 für acht bei Haiku — je gelesenem Chart rund 19 000 gegen
33 000 Tokens.

### Das Problem, das die Entscheidung mitbringt

Sonnet riss bei **vier von acht** Charts die Zeitgrenze von 600 s;
reproduzierbar (HR 7 zweimal). Haiku brauchte für dieselben Charts unter 200 s.
Sonnet denkt bei dichten Rastern deutlich länger.

Zwei Maßnahmen:

1. **Die Obergrenze für `llm.timeout_ms` steigt von 600 000 auf 1 800 000 ms**
   (`LLM_SETTINGS_RANGES` in `packages/shared/src/settings.ts`). Sonst würde
   die Modellwahl nicht durch Qualität, sondern durch eine Zeitgrenze
   entschieden. Der Host-Runner muss mit demselben Wert gestartet werden — er
   deckelt jede Anfrage auf sein eigenes `LLM_TIMEOUT_MS` (RUNBOOK 13.1).
2. **`timeout` ist eine wiederholbare Kategorie.** Der Job geht mit Backoff
   zurück in die Queue; ein Chart, der auch nach `maxAttempts` nicht durchkommt,
   landet im Dead-Letter und bleibt als offener Fall sichtbar. Er wird **nicht**
   mit einem schwächeren Modell nachgelesen — dann stünden zwei
   Qualitätsstufen nebeneinander in derselben Tabelle.

### Nebenläufigkeit

`llm.max_concurrency` bleibt bei **2**. Sie greift ohnehin nicht als Beschleuniger:
Der Job-Worker holt einen Job je Durchlauf und wartet ihn ab (ADR-0026) — die
Semaphore der Adapter begrenzt nur, sie parallelisiert nicht. Eine höhere Zahl
würde auf diesem geteilten Host nur mehr CLI-Prozesse erlauben, ohne den
Massenlauf zu verkürzen.

### Hochrechnung für den Vollausbau

348 Charts, Sonnet, sequenziell:

| Größe                        | Rechnung             | Ergebnis          |
| ---------------------------- | -------------------- | ----------------- |
| Tokens                       | 348 × ~19 000        | **~6,6 Mio**      |
| Modellzeit (ohne Timeouts)   | 348 × ~110 s         | **~10,6 Stunden** |
| Modellzeit (mit ~30 % Zähen) | zzgl. Wiederholungen | **12–17 Stunden** |

Das ist der mit Abstand größte Massenlauf des Projekts. Er läuft deshalb **in
Chargen** und ist jederzeit fortsetzbar (`selectCandidates()` wählt nur Assets
ohne Chart-Datensatz) — ein Session- oder Wochenlimit kostet keinen bereits
gelesenen Chart.

### Prompt-Fassung

Unverändert übernommen: `task/chart-digitize` mit `persona/chart-reader`,
`partial/data-truth` und `partial/json-output`, Ausgabegrenze 16 384 Tokens,
Bild als Vision-Baustein. Der Golden-Fall `task-chart-digitize` hält die
Fassung fest; ändert sie sich, ist die Kalibrierung zu wiederholen.

### Regressionsgrundlage

Die Antworten beider Modelle zu HR 1 und HR 8 liegen als
`apps/backend/test/chart/fixtures/recorded/` im Repo — reine Zahlen, keine
Bildkopien. `test/chart/calibration.test.ts` misst sie ohne Live-Aufruf gegen
dieselben Sollwerte und hält die Trefferquote des gewählten Modells fest.

**Keine neuen Dependencies.**

## ADR-0034 — Chart-Validierung: Toleranzen, Heuristiken als Warnung, zweiter Wert gilt

- **Datum:** 2026-08-24
- **Status:** angenommen
- **Kontext:** T3.4 entscheidet, welche Vision-Ergebnisse zur „Wahrheit" werden.
  Zu enge Toleranzen beanstanden korrekte Charts und erzeugen Handarbeit ohne
  Ertrag; zu weite lassen falsche Zahlen durch und vergiften jeden späteren
  Drill (Risiko R2). Die Zahlen sind **vorab** festgelegt und in
  `packages/shared/src/validation.ts` (`CHART_TOLERANCES`) an einer Stelle
  hinterlegt — sie werden nicht nachträglich an ein Ergebnis angepasst.

### Prüfung 1 — Frequenzsumme je Hand: ±2,0 pp, Schweregrad `error`

Die Anteile einer Zelle müssen zusammen 100 % ergeben. Rundung im Original ist
normal: Ein Buch schreibt „33.3 / 33.3 / 33.3" und meint 100. Drei gerundete
Drittel liegen 0,1 pp daneben, vier Viertel exakt, sechs Sechstel bis 0,2 pp.
Auch Flächenschätzung an mehrfarbigen Zellen streut um etwa 1 pp.

**±2,0 pp** liegt bequem über beidem und trotzdem weit unter jedem echten
Lesefehler: Wer eine Aktion in einer Mischzelle übersieht, verfehlt die 100 um
zweistellige Beträge, nicht um zwei. Der Befund ist **zellgenau** (`hand` ist
gesetzt), damit der Zweitdurchlauf auf die betroffenen Blätter zeigen kann statt
auf „Chart fehlerhaft".

### Prüfung 2 — Caption-Abgleich: ±1,5 pp, Schweregrad `error`

Die Toleranz gibt die AP-Datei vor. Sie passt zur Sache: Die Caption-Werte des
Buchs sind auf ein bis zwei Nachkommastellen gerundet, und die combo-gewichtete
Summe über 169 Zellen mittelt Schätzfehler einzelner Zellen stark heraus. Am
echten Bestand bestätigt: 15 der 21 automatisch bestandenen Charts trafen ihren
extern gedruckten Wert **auf zwei Nachkommastellen genau** — 1,5 pp ist für ein
richtig gelesenes Chart kein enges Korsett.

Die Rechnung ist **combo-gewichtet** (Paare 6, suited 4, offsuit 12, Summe
1326). Eine ungewichtete Mittelung über 169 Zellen ist nicht etwas ungenauer,
sondern systematisch falsch — offsuit wiegt dreimal so schwer wie suited. Bei
einer reinen Paar-Range liegen beide Rechenwege 1,8 pp auseinander, also mehr
als die ganze Toleranz.

**Charts ohne Caption-Prozente fallen nicht durch.** Sie bekommen
`caption-not-checkable` mit Schweregrad `info`. Ein fehlender Maßstab ist ein
Sachverhalt, kein Fehler des Charts.

> **Was der Lauf gegen den echten Bestand darüber gelehrt hat:** Nur 6 der 25
> lesbaren Charts nennen überhaupt Prozentwerte in der Buch-Unterschrift. Für
> die übrigen 19 ist `caption-match` blind — sie erreichen `validated`, ohne je
> gegen eine externe Zahl gehalten worden zu sein. Bei der Sichtung fanden sich
> unter ihnen fünf Charts mit belegbaren Abweichungen (bis 11,4 pp). Die
> automatische Prüfung ist damit eine Vorsortierung, keine Abnahme. Konsequenz
> im Betrieb: Die Sammelfreigabe ist der Ausnahmefall, die Sichtung im Review
> der Regelfall. Viele Chart-Bilder tragen ihre Prozentwerte in einer **Legende
> im Bild** — die liest ein Mensch in der Review-Ansicht, und sie wäre der
> naheliegende Kandidat für eine vierte, automatische Prüfung in einem späteren
> AP.

### Prüfung 3 — Plausibilität: Warnungen, keine Fehler

Heuristiken sind Hinweisgeber. Sie kennen die Strategie nicht, sondern nur die
Form einer typischen Range — und eine untypische Range ist manchmal genau das,
was das Kapitel zeigen will. Beispiel aus dem Bestand: HR 16 „A Capped Range"
lässt AA, KK und AKs **absichtlich** aus. Jede Monotonie-Regel schlägt dort an,
und trotzdem ist das Chart in Ordnung. Deshalb blockieren `monotonicity` und
`outlier` keine Freigabe.

`incomplete-matrix` und `empty-cell` sind dagegen `error`: Eine fehlende Zelle
ist kein Stilfrage, sondern eine Lücke.

**Monotonie mit Mindestabstand 10.** Die naive Regel „stärkere Hand nicht
seltener aggressiv als schwächere" erzeugte im ersten Lauf 159 Warnungen über
16 Charts — fast alle falsch. Grund: Sie flaggt `A8s` gegen `98s`, obwohl
Suited Connectors in vielen Spots berechtigt häufiger im Spiel sind als schwache
suited Asse. Verglichen werden deshalb nur Paare mit deutlichem Rangabstand
(Summe der Rangdifferenzen ≥ 10, etwa `AKs` gegen `72s`). Zwischenstand bei
Abstand 6: noch 80 Warnungen. Bei 10: 14 Warnungen über 2 Charts — und die
Verletzungen, auf die die AP-Datei zielt (vertauschte Zeilen oder Spalten),
haben Abstände weit darüber.

**Ausreißer nur gegen Nachbarn derselben Kategorie.** Die erste Fassung verglich
Rasternachbarn und meldete 59 Warnungen. Ein Paar liegt auf der Diagonale und
hat ausschließlich suited- und offsuit-Nachbarn — jedes Paar sah dadurch wie ein
Ausreißer aus. Das war ein Fehlalarm aus der Bauart des Rasters, nicht aus den
Daten. Nach der Einschränkung: 4 Warnungen über 2 Charts. Zusätzlich braucht ein
Befund mindestens 3 Nachbarn, deren Streuung selbst gering ist — sonst gibt es
kein „Muster", aus dem eine Zelle fallen könnte.

Die Ausgabe der Monotonie-Prüfung ist auf 10 Befunde plus eine Summenzeile
gedeckelt. Eine Liste mit 200 Einträgen liest niemand.

### Umgang mit widersprüchlichen Zweitdurchläufen: der zweite Wert gilt

Der Zweitdurchlauf liest das Bild **vollständig neu**, mit einem Prompt, der die
konkrete Beanstandung nennt. Er sieht die erste Ablesung nicht — sonst würde er
sie bestätigen statt prüfen.

- **Beide stimmen überein** (dieselben Aktionen, ≤ 5 pp Unterschied je Zelle):
  Der Befund ist vermutlich echt. Das Chart bleibt beanstandet und geht in die
  Review. Eine zweite Bestätigung ist ein Argument für den Befund, nicht dagegen.
- **Sie unterscheiden sich:** Der zweite Wert gilt. Er entstand mit mehr
  Information — der Hinweis, wo es klemmt, ist echter Kontext, kein Zwang zu
  einem Ergebnis. Der Prompt sagt das ausdrücklich: „Das ist ein Hinweis, keine
  Vorgabe. Ändere deine Ablesung nicht, um eine Zahl zu treffen."

Die 5 pp stammen aus derselben Überlegung wie Prüfung 1: Flächenschätzung ist
keine exakte Wissenschaft, und ein Prozentpunkt hin oder her ist keine
Meinungsverschiedenheit.

**Jeder Fall wird protokolliert.** `chart_recheck` hält Vergleichszahlen und die
Entscheidung im Klartext fest. Ohne diese Zeile wäre „der zweite Wert gilt" ein
stilles Überschreiben — und genau das verbietet die AP-Datei.

**Von Hand korrigierte Zellen sind ausgenommen.** Der Zweitdurchlauf überspringt
sie und zählt sie als `cells_protected`. Ein Mensch, der ins Bild geschaut hat,
schlägt ein Modell, das dasselbe Bild noch einmal schätzt.

### Warum die Validierung kein KI-Anteil ist

Eine KI, die eine KI prüft, teilt deren Fehler. Frequenzsummen, Combo-Gewichte,
Rangordnungen und Nachbarschaften sind rechenbar — und rechenbare Dinge werden
gerechnet. Die einzige Stelle mit Modellbeteiligung ist der Zweitdurchlauf, und
der **liest das Bild neu**, statt Zahlen zu beurteilen.

### Folgen

- `validated` heißt „nichts spricht dagegen", nicht „extern bestätigt". Der Weg
  nach `approved` führt in der Regel über die Review-Ansicht.
- Warnungen blockieren nichts, tauchen aber in Liste und Detail auf. Wer sie
  ignoriert, tut das sehenden Auges.
- Wird die 95-%-Schwelle verfehlt, ist das ein Befund. Die Toleranzen bleiben,
  wo sie sind.

**Keine neuen Dependencies.**
