---
{
  "id": "task/chart-recheck",
  "version": 1,
  "kind": "task",
  "description": "Liest ein Range-Chart ein zweites Mal ab, mit Hinweis auf die konkrete Beanstandung aus der Validierung (AP3.T3.4).",
  "system": "persona/chart-reader",
  "placeholders": ["unterschrift", "spot", "aktionen", "blattliste", "beanstandung"],
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

Lies das beigefügte Range-Chart **erneut** ab.

Eine erste Ablesung liegt bereits vor und ist bei der Prüfung beanstandet
worden. Du bekommst die Beanstandung, damit du weißt, worauf zu achten ist —
**nicht**, damit du dein Ergebnis daran anpasst.

Beanstandung aus der Prüfung:

{{beanstandung}}

Wie du damit umgehst:

- Lies das Raster **vollständig neu**, Zelle für Zelle. Übernimm nichts aus der
  ersten Ablesung; du siehst sie ohnehin nicht.
- Bei den genannten Blättern nimm dir mehr Zeit: Prüfe die Farbe genau, achte
  auf **Mischfrequenzen** (mehrfarbige Zellen) und auf schmale Farbstreifen am
  Zellenrand. Genau dort entstehen die meisten Fehler.
- Wenn die Beanstandung eine Gesamtfrequenz nennt, die nicht zu deiner Ablesung
  passt: Das ist ein Hinweis, keine Vorgabe. **Ändere deine Ablesung nicht, um
  eine Zahl zu treffen.** Passt es nicht zusammen, schreibst du das nach
  `unsicher` und lieferst, was du siehst.

Bildunterschrift aus dem Buch:

{{unterschrift}}

Was aus der Unterschrift bereits bekannt ist:

{{spot}}

Aktionen, die dieses Chart laut Unterschrift verwendet:

{{aktionen}}

Aufgabe:

1. Gib in `zellen` **alle 169 Blätter** zurück, in genau dieser Schreibweise:

   {{blattliste}}

2. Je Zelle die Aktionsverteilung in `aktionen` (`art`, optional `sizing`,
   `prozent`); die Werte einer Zelle ergeben zusammen 100.
3. In `legende` die Farbzuordnung, die du gelesen hast.
4. In `unsicher` jede Stelle, die du nicht zweifelsfrei lesen konntest — mit
   Blattbezeichnung und Grund.

{{> partial/data-truth}}

{{> partial/json-output}}
