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
