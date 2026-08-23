# Agent Guide — verbindliche Arbeitsregeln

Diese Regeln gelten **dauerhaft** für jeden Coding-Agenten, der in diesem
Repository arbeitet — unabhängig davon, welcher Task gerade beauftragt ist.
Sie sind nicht optional und werden nicht pro Task neu verhandelt.

---

## Regel 1 — Vor jedem Task: Kanon lesen und prüfen

Vor **jeder** Codeänderung ist die zum Task gehörende Arbeitspaket-Datei
`docs/ap/AP<NN>.md` zu lesen. Anschließend ist zu prüfen, ob der erhaltene
Auftrag zum dort festgehaltenen Kanon passt: Ziel, Scope, Abgrenzungen,
Akzeptanzkriterien.

**Bei Widerspruch zwischen Auftrag und Kanon: STOP.** Keine Codeänderung, keine
„sinnvolle Interpretation", kein Kompromiss. Stattdessen den Task mit

```
STATUS: BLOCKED
```

melden und den Widerspruch konkret benennen (Auftrag sagt X, `AP<NN>.md`
Abschnitt Y sagt Z). Die Auflösung ist Sache des Nutzers.

---

## Regel 2 — Kontextdisziplin

**Keine Buch-Volltexte und keine kompletten Fremddateien einlesen.**

- Dateien unter `data/book-source/` werden **nie am Stück** gelesen. Ab AP3
  erfolgt der Zugriff ausschließlich abschnitts- bzw. seitenweise über die
  dafür gebaute Ingestion.
- Gelesen wird **gezielt nur, was der Prompt auflistet** — plus die Dateien,
  die zum Verständnis dieser Dateien zwingend nötig sind.
- Kein spekulatives Durchsuchen des Repos „zur Sicherheit", keine
  Massen-Dumps ganzer Verzeichnisse in den Kontext.
- Große Dateien abschnittsweise lesen (`sed -n`, `grep -n` mit Kontext), nicht
  komplett.

Begründung: Kontextbudget ist die knappste Ressource. Ein zugemüllter Kontext
verschlechtert jede nachfolgende Entscheidung im selben Task.

---

## Regel 3 — Doku-Pflicht je Task

Jeder Task aktualisiert **im selben Commit** die Dokumentation:

| Datei                   | Wann                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `docs/ARCHITECTURE.md`  | sobald sich Struktur, Komponenten oder Datenfluss ändern                             |
| `docs/INTERFACES.md`    | sobald ein Endpunkt, ein geteilter Vertrag oder ein Andockpunkt entsteht/sich ändert |
| `docs/DECISIONS.md`     | bei jeder nennenswerten technischen Entscheidung (siehe auch Regel 5)                |
| `docs/status/AP<NN>.md` | immer — Statusbericht fortschreiben                                                  |
| `docs/RUNBOOK.md`       | sobald sich Setup, Start, Betrieb, Backup oder Restore ändern                        |

Es werden **Deltas** nachgetragen, keine Neuschreibungen. Ein Task ohne
Doku-Delta ist nur dann zulässig, wenn sich nachweislich nichts an Struktur,
Schnittstellen, Entscheidungen oder Betrieb geändert hat.

---

## Regel 4 — Commit-Konvention

Commit-Nachrichten folgen exakt diesem Format:

```
AP<N>.T<M>: <summary>
```

Beispiele:

```
AP1.T1.1: Repo- und Projektgerüst (Monorepo, Toolchain, Doku-Gerüst)
AP1.T1.2: Postgres-Anbindung und Migrationsgerüst
```

- `<summary>` ist eine kurze, sachliche Beschreibung im Deutschen.
- Ein Task ergibt in der Regel **einen** Commit.
- Keine Commits ohne Task-Präfix.

---

## Regel 5 — Keine neuen Dependencies ohne ADR

Jede neue Laufzeit- oder Entwicklungs-Abhängigkeit erfordert **vor oder mit**
ihrer Einführung einen Eintrag in `docs/DECISIONS.md` im ADR-Kurzformat
(Nr., Datum, Entscheidung, Begründung, Alternativen).

- Gilt für alle Workspaces und für Root-Dependencies.
- Gilt auch für Dev-Tooling (Linter-Plugins, Test-Utilities, Build-Helfer).
- Grundhaltung: **schlank bleiben.** Was sich mit vorhandenen Mitteln oder
  ~20 Zeilen eigenem Code lösen lässt, rechtfertigt keine Dependency.
- Transitive Abhängigkeiten sind nicht dokumentationspflichtig — nur das, was
  direkt in einer `package.json` landet.

---

## Regel 6 — `docs/ap/` ist unantastbar

Dateien in `docs/ap/` werden vom Agenten **ausschließlich gelesen**.

- **Niemals** anlegen, ändern, umbenennen, löschen oder formatieren.
- Auch nicht „nur einen Tippfehler korrigieren", auch nicht Zeilenumbrüche,
  auch nicht auf Zuruf im Prompt — dieses Verzeichnis wird allein vom Nutzer
  gepflegt.
- Ist eine `AP<NN>.md` fehlerhaft oder unvollständig: `STATUS: BLOCKED` melden
  (siehe Regel 1), nicht selbst reparieren.

---

## Arbeitsablauf je Task (Zusammenfassung)

1. `docs/ap/AP<NN>.md` lesen → Auftrag gegen Kanon prüfen (Regel 1).
2. Bei Widerspruch: `STATUS: BLOCKED`, Ende.
3. Nur die im Prompt genannten Dateien lesen (Regel 2).
4. Umsetzen — nichts, was zu einem späteren Task gehört.
5. `pnpm lint && pnpm test && pnpm build` müssen grün sein.
6. Doku-Deltas nachtragen (Regel 3), neue Dependencies als ADR (Regel 5).
7. Statusbericht `docs/status/AP<NN>.md` aktualisieren.
8. Commit nach Konvention (Regel 4), pushen.
9. Ergebnisbericht im vom Task geforderten Format ausgeben.
