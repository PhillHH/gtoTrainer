---
{
  "id": "task/chart-digitize",
  "version": 2,
  "kind": "task",
  "description": "Liest ein 13x13-Range-Chart vom Bild ab: je Blatt die Aktionsverteilung in Prozent, dazu die im Bild gedruckte Legende mit ihren Gesamtprozenten. Grundlage der Chart-Datenbank aus AP3.T3.3, Legendenwerte ab AP3.T3.6-fix.",
  "system": "persona/chart-reader",
  "placeholders": [
    "unterschrift",
    "spot",
    "aktionen",
    "blattliste"
  ],
  "jsonSchema": {
    "type": "object",
    "properties": {
      "zellen": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "hand": {
              "type": "string"
            },
            "aktionen": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "art": {
                    "type": "string",
                    "enum": [
                      "fold",
                      "check",
                      "call",
                      "limp",
                      "bet",
                      "raise",
                      "three_bet",
                      "four_bet",
                      "five_bet",
                      "all_in"
                    ]
                  },
                  "sizing": {
                    "type": "string"
                  },
                  "prozent": {
                    "type": "number"
                  }
                },
                "required": [
                  "art",
                  "prozent"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "hand",
            "aktionen"
          ],
          "additionalProperties": false
        }
      },
      "unsicher": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "legende": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "legendenwerte": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "art": {
              "type": "string",
              "enum": [
                "fold",
                "check",
                "call",
                "limp",
                "bet",
                "raise",
                "three_bet",
                "four_bet",
                "five_bet",
                "all_in"
              ]
            },
            "sizing": {
              "type": "string"
            },
            "prozent": {
              "type": "number"
            },
            "beschriftung": {
              "type": "string"
            }
          },
          "required": [
            "art",
            "prozent",
            "beschriftung"
          ],
          "additionalProperties": false
        }
      },
      "legendenwerte_vorhanden": {
        "type": "boolean"
      }
    },
    "required": [
      "zellen",
      "unsicher",
      "legende",
      "legendenwerte",
      "legendenwerte_vorhanden"
    ],
    "additionalProperties": false
  }
}
---

Lies das beigefügte Range-Chart ab.

Bildunterschrift aus dem Buch:

{{unterschrift}}

Was aus der Unterschrift bereits bekannt ist (du musst es nicht ableiten):

{{spot}}

Aktionen, die dieses Chart laut Unterschrift verwendet:

{{aktionen}}

Aufgabe:

1. Gib in `zellen` **alle 169 Blätter** zurück — auch die, die zu 100 % gefoldet
   werden. Eine fehlende Zelle ist ein Fehler, kein zulässiges Ergebnis.
   Die gültigen Blattbezeichnungen sind exakt diese, in dieser Schreibweise:

   {{blattliste}}

2. Je Zelle die Aktionsverteilung in `aktionen`:
   - `art` ist eine der Kennungen aus dem Schema (`fold`, `check`, `call`,
     `limp`, `bet`, `raise`, `three_bet`, `four_bet`, `five_bet`, `all_in`).
   - `sizing` nur, wenn das Chart eine Größe nennt (`2.5x`, `10bb`, `pot`).
     Sonst weglassen.
   - `prozent` ist der Flächenanteil dieser Aktion in der Zelle. Die Werte
     einer Zelle ergeben zusammen 100.
   - Einfarbige Zelle: genau eine Aktion mit 100.
3. In `legende` schreibst du, welche Farbe du welcher Aktion zugeordnet hast —
   eine Zeile je Farbe, zum Beispiel `grün = raise 2.5x`. Das ist der Beleg
   dafür, dass du die Legende des Bildes gelesen hast und nicht geraten.
4. In `legendenwerte` gibst du die **im Bild gedruckte Legende** wieder — den
   Kasten unter oder neben dem Raster, der jede Farbe benennt und ihren
   Gesamtanteil in Prozent nennt (etwa `Call 59.65 %` / `Off Range 40.35 %`).
   - Je Eintrag: `beschriftung` ist der Text **wörtlich so, wie er im Bild
     steht**; `art` ist die passende Kennung aus dem Schema; `prozent` ist die
     gedruckte Zahl.
   - **Lies diese Zahlen ab. Rechne sie nicht aus.** Sie sind eine von deiner
     Matrix unabhängige Beobachtung und werden später genau dagegen gehalten.
     Eine aus der Matrix hergeleitete Zahl macht diese Prüfung wertlos.
   - Steht im Bild **keine** Legende mit Prozentwerten, setzt du
     `legendenwerte_vorhanden` auf `false` und `legendenwerte` auf eine leere
     Liste. Das ist ein gültiges Ergebnis; eine geschätzte Zahl wäre es nicht.
   - Nennt die Legende nur Farben ohne Prozente, gilt dasselbe: keine Prozente,
     also `false` und leere Liste.
5. In `unsicher` listest du jede Stelle, die du nicht zweifelsfrei lesen
   konntest, mit Blattbezeichnung und Grund. Ist alles klar lesbar, bleibt die
   Liste leer. **Rate nicht** — eine Zelle, bei der du dir unsicher bist,
   gehört mit deinem besten Wert **und** einem Eintrag in `unsicher` in die
   Antwort.

Zeigt das Bild kein Raster mit Aktionsfarben, sondern etwa nur die
Blattbezeichnungen oder eine reine Beispiel-Illustration, dann gib `zellen`
leer zurück und schreibe den Grund in `unsicher`. Das ist ein gültiges
Ergebnis; eine erfundene Matrix wäre es nicht.

{{> partial/data-truth}}

{{> partial/json-output}}
