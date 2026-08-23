# data/book-source/ — Pflicht-Input für AP3

Dieses Verzeichnis ist der **einzige** Ablageort für die Buchquelle, aus der ab
**AP3** Inhalte (Ranges, Charts, Erklärtexte) eingelesen werden.

> **Wichtig:** Der Inhalt dieses Ordners wird **nicht** versioniert
> (siehe `.gitignore`: `data/book-source/*` mit Ausnahme dieser README).
> Nur diese README liegt im Repository. Die eigentlichen Buchdaten legt der
> Nutzer lokal bzw. auf dem Zielsystem selbst ab.

## Was hier abgelegt wird

1. **Die Buch-Markdown-Datei** — der Volltext des Buches als eine
   Markdown-Datei (`*.md`).
2. **Sämtliche Chart-/Abbildungs-Bilder** — im Format `pXXXX_YY.jpeg`, wobei
   - `XXXX` die vierstellige, führend mit Nullen aufgefüllte Seitenzahl ist,
   - `YY` der zweistellige, bei `01` beginnende Zähler der Abbildung auf
     dieser Seite.

   Beispiele: `p0042_01.jpeg`, `p0042_02.jpeg`, `p0137_01.jpeg`.

## Erwartete Verzeichnisstruktur

```
data/book-source/
├── README.md          # versioniert (diese Datei)
├── book.md            # Buch-Volltext als Markdown
├── p0042_01.jpeg      # Abbildung 1 auf Seite 42
├── p0042_02.jpeg      # Abbildung 2 auf Seite 42
└── p0137_01.jpeg      # Abbildung 1 auf Seite 137
```

Die Bilder liegen **flach** in diesem Verzeichnis, nicht in Unterordnern.

## Zeitpunkt

- Dieses Verzeichnis wird **erst in AP3** gelesen. Vorher greift kein Code
  darauf zu.
- Es muss jedoch **vor dem Start von AP3 vollständig befüllt** sein, sonst
  kann AP3 nicht beginnen.

## Regeln

- Keine Buchdaten ins Git-Repository committen — die Quelle ist urheberrechtlich
  geschützt und bleibt lokal.
- Dateinamen der Bilder exakt nach dem Schema `pXXXX_YY.jpeg`; abweichende
  Namen werden von der AP3-Ingestion nicht zugeordnet.
- Der Coding-Agent liest hier **niemals Volltexte am Stück** ein
  (siehe `docs/AGENT_GUIDE.md`, Abschnitt Kontextdisziplin).
