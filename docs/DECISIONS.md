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
