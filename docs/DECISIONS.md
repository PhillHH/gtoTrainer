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
