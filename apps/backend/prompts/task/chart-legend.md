---
{
  "id": "task/chart-legend",
  "version": 1,
  "kind": "task",
  "description": "Liest ausschliesslich die im Chart-Bild gedruckte Legende mit ihren Gesamtprozenten. Nachzug fuer bereits digitalisierte Charts (AP3.T3.6-fix).",
  "system": "persona/chart-reader",
  "placeholders": ["unterschrift", "aktionen"],
  "jsonSchema": {
    "type": "object",
    "properties": {
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
            "sizing": { "type": "string" },
            "prozent": { "type": "number" },
            "beschriftung": { "type": "string" }
          },
          "required": ["art", "prozent", "beschriftung"],
          "additionalProperties": false
        }
      },
      "legendenwerte_vorhanden": { "type": "boolean" },
      "unsicher": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["legendenwerte", "legendenwerte_vorhanden", "unsicher"],
    "additionalProperties": false
  }
}
---

Im beigefügten Bild steht ein Range-Chart. **Du liest heute nicht das Raster.**

Deine einzige Aufgabe ist die **Legende**: der Kasten unter oder neben dem
Raster, der jede Farbe benennt und ihren Gesamtanteil in Prozent nennt. Typisch
sieht er so aus:

    ▉  Call        59.65%
    □  Off Range   40.35%

Bildunterschrift aus dem Buch (nur zur Einordnung — die Zahlen dort sind
**nicht** gemeint):

{{unterschrift}}

Aktionen, die dieses Chart laut Unterschrift verwendet:

{{aktionen}}

Aufgabe:

1. Gib je Legendenzeile mit Prozentwert einen Eintrag in `legendenwerte`:
   - `beschriftung` ist der Text **wörtlich so, wie er im Bild steht**
     (`Off Range`, `2.5x`, `3-bet all-in`).
   - `art` ist die passende Kennung aus dem Schema. Alles, was nicht gespielt
     wird — `Fold`, `Off Range`, `Unselected` —, ist `fold`.
   - `sizing` nur, wenn die Beschriftung eine Größe nennt (`2.5x`, `10bb`).
   - `prozent` ist die gedruckte Zahl, unverändert und ungerundet.
2. Setze `legendenwerte_vorhanden` auf `true`, wenn du mindestens einen
   Prozentwert **im Bild** gefunden hast, sonst auf `false`.
3. Steht im Bild keine Legende, oder nennt sie nur Farben ohne Prozente, dann
   ist `false` mit leerer Liste die richtige Antwort. Schreibe den Grund nach
   `unsicher`.

**Diese Zahlen werden gleich gegen eine unabhängig davon abgelesene Matrix
gehalten.** Deshalb: Du liest ab, was gedruckt ist. Du rechnest nichts aus, du
schätzt nichts, und du ergänzt keinen fehlenden Wert aus den anderen. Eine
geratene Zahl macht die Prüfung wertlos — eine ehrliche Lücke nicht.

{{> partial/data-truth}}

{{> partial/json-output}}
