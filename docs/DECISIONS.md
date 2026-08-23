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
