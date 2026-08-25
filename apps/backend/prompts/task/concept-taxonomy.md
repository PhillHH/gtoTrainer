---
{
  "id": "task/concept-taxonomy",
  "version": 1,
  "kind": "task",
  "description": "Schlaegt fachliche Lerneinheiten (Konzepte) zu einem Kapitelabschnitt vor: Titel, Kurzdefinition, Themenbereich, Voraussetzungen, Sektionsbezug. Grundlage des Konzept-Graphen aus AP3.T3.2.",
  "system": "persona/taxonomist",
  "placeholders": [
    "kapitel",
    "zielanzahl",
    "themenbereiche",
    "bekannte_konzepte",
    "abschnitte"
  ],
  "jsonSchema": {
    "type": "object",
    "properties": {
      "konzepte": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "titel": { "type": "string" },
            "kurzdefinition": { "type": "string" },
            "themenbereich": {
              "type": "string",
              "enum": [
                "grundlagen-mathematik",
                "spieltheorie",
                "software-werkzeuge",
                "preflop-ranges",
                "preflop-verteidigung",
                "spiel-gegen-3bets",
                "turnier-metriken-icm",
                "postflop-grundlagen",
                "flop-spiel",
                "turn-spiel",
                "river-spiel",
                "mental-game"
              ]
            },
            "ab_level": { "type": "string", "enum": ["einsteiger", "fortgeschritten", "experte"] },
            "voraussetzungen": { "type": "array", "items": { "type": "string" } },
            "sektionen": { "type": "array", "items": { "type": "string" } }
          },
          "required": [
            "titel",
            "kurzdefinition",
            "themenbereich",
            "ab_level",
            "voraussetzungen",
            "sektionen"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": ["konzepte"],
    "additionalProperties": false
  }
}
---

Zerlege den folgenden Buchabschnitt in fachliche Lerneinheiten (Konzepte).

Kapitel: {{kapitel}}

Gib **höchstens {{zielanzahl}} Konzepte** zurück. Diese Zahl ist eine
Obergrenze, keine Zielvorgabe:

- Findest du mehr Kandidaten, dann wähle die {{zielanzahl}} **wichtigsten** aus
  und lass die übrigen weg. Wichtig ist, was den Abschnitt trägt — nicht, was
  am meisten Zeilen einnimmt.
- Findest du weniger, ist die kürzere Liste das richtige Ergebnis. Fülle nicht
  auf.
- Sortiere die Liste nach Wichtigkeit, das wichtigste Konzept zuerst.

Was ein Konzept ist:

- Etwas, das man **verstehen, anwenden und prüfen** kann. Zu jedem Konzept
  ließe sich eine Frage stellen, die eindeutig richtig oder falsch beantwortet
  werden kann.
- Ein Fachbegriff oder ein Wirkzusammenhang, kein Kapitelabschnitt.
  „Minimum Defense Frequency" ist ein Konzept. „Kapitel 5, Teil 2" ist keines,
  „Einleitung" ist keines, „Weitere Überlegungen" ist keines.
- Eine Einheit, keine Aufzählung. Wenn deine Kurzdefinition ein „und" braucht,
  um zwei unabhängige Dinge zu verbinden, sind es zwei Konzepte.

Kurzdefinition:

- Zwei bis vier Sätze, prüfbar formuliert: was es ist, wozu es dient, woran man
  es erkennt.
- **Ohne konkrete Zahlenwerte.** Keine Frequenzen, keine Prozentangaben, keine
  Handbereiche, keine Chart-Werte. Diese Wahrheiten liegen in den Chart-Daten
  und werden dort gelesen — nicht hier abgeschrieben und schon gar nicht
  geschätzt. Wo eine Zahl nötig wäre, schreibe stattdessen, worauf sie beruht
  („die Frequenz ergibt sich aus dem zugehörigen Range-Chart").

Felder je Konzept:

1. `titel` — der Fachbegriff, wie ihn der Abschnitt verwendet. Kurz.
2. `kurzdefinition` — siehe oben.
3. `themenbereich` — genau **eine** Kennung aus dieser festen Liste:

{{themenbereiche}}

   Eine Kennung, die nicht in der Liste steht, wird verworfen. Passt nichts
   genau, nimm den nächstliegenden Bereich aus der Liste.

4. `ab_level` — ab welchem Niveau das Konzept sinnvoll ist:
   `einsteiger`, `fortgeschritten` oder `experte`.
5. `voraussetzungen` — Titel anderer Konzepte, die man vorher verstanden haben
   muss. Verwende bevorzugt Titel aus der Liste bereits bekannter Konzepte
   unten oder Titel, die du in derselben Antwort vergibst. Keine Selbstverweise,
   keine gegenseitigen Verweise (A setzt B voraus und B setzt A voraus).
   Leere Liste ist ein gültiges Ergebnis.
6. `sektionen` — die Schlüssel der Abschnitte unten, aus denen das Konzept
   stammt. Übernimm sie **wörtlich** aus der Zeile `[sektion: …]`. Mindestens
   einer, mehrere sind erlaubt.

Bereits bekannte Konzepte aus vorherigen Kapiteln (nicht erneut vorschlagen,
aber als Voraussetzung verwendbar):

{{bekannte_konzepte}}

Abschnitte (deine einzige Faktenquelle):

{{abschnitte}}

{{> partial/data-truth}}

{{> partial/json-output}}
