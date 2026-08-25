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

Die Ingestion aus AP3.T3.1 erkennt **zwei** Ablageformen und nennt die
gefundene im Import-Report.

**A) flach** — die ursprünglich vorgesehene Form:

```
data/book-source/
├── README.md          # versioniert (diese Datei)
├── book.md            # Buch-Volltext als Markdown
├── p0042_01.jpeg      # Abbildung 1 auf Seite 42
├── p0042_02.jpeg      # Abbildung 2 auf Seite 42
└── p0137_01.jpeg      # Abbildung 1 auf Seite 137
```

**B) Bilder in genau einem Unterverzeichnis** — so liefert es der
PDF-nach-Markdown-Export, und so zeigen dann auch die Bildbezüge im Markdown
(`![…](<verzeichnis>/p0042_01.jpeg)`):

```
data/book-source/
├── README.md
├── <Buchtitel>.md
└── <Buchtitel>_images/
    ├── p0042_01.jpeg
    └── p0137_01.jpeg
```

Beides ist zulässig. **Nicht** zulässig ist mehr als ein Unterverzeichnis mit
Bildern oder mehr als eine Buch-Markdown-Datei — dann ist die Struktur
mehrdeutig, und der Import bricht mit einer entsprechenden Meldung ab, statt
zu raten.

## Zeitpunkt

- Dieses Verzeichnis wird **erst in AP3** gelesen. Vorher greift kein Code
  darauf zu.
- Es muss jedoch **vor dem Start von AP3 vollständig befüllt** sein, sonst
  kann AP3 nicht beginnen.

## Regeln

- Keine Buchdaten ins Git-Repository committen — die Quelle ist urheberrechtlich
  geschützt und bleibt lokal.
- Dateinamen der Bilder exakt nach dem Schema `pXXXX_YY.jpeg`; abweichende
  Namen werden von der AP3-Ingestion nicht zugeordnet (Seitenzahl und Zähler
  werden aus dem Dateinamen gelesen).
- Die Ingestion liest dieses Verzeichnis **ausschließlich**; sie schreibt hier
  niemals. Der Import-Report landet unter `data/reports/book-import.md`.
- Der Coding-Agent liest hier **niemals Volltexte am Stück** ein
  (siehe `docs/AGENT_GUIDE.md`, Abschnitt Kontextdisziplin).
