---
{
  "id": "task/chart-digitize",
  "version": 1,
  "kind": "task",
  "description": "Liest ein 13x13-Range-Chart vom Bild ab: je Blatt die Aktionsverteilung in Prozent. Grundlage der Chart-Datenbank aus AP3.T3.3.",
  "system": "persona/chart-reader",
  "placeholders": ["unterschrift", "spot", "aktionen", "blattliste"],
  "jsonSchema": {
    "type": "object",
    "properties": {
      "zellen": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "hand": { "type": "string" },
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
                  "sizing": { "type": "string" },
                  "prozent": { "type": "number" }
                },
                "required": ["art", "prozent"],
                "additionalProperties": false
              }
            }
          },
          "required": ["hand", "aktionen"],
          "additionalProperties": false
        }
      },
      "unsicher": { "type": "array", "items": { "type": "string" } },
      "legende": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["zellen", "unsicher", "legende"],
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
4. In `unsicher` listest du jede Stelle, die du nicht zweifelsfrei lesen
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
