---
{
  "id": "task/error-patterns",
  "version": 1,
  "kind": "task",
  "description": "Verdichtet aggregierte Fehlerkennzahlen zu drei bis fuenf belegten Mustern mit Beobachtung, Deutung und Handlungsempfehlung. Grundlage des Muster-Reports aus AP4.T4.6.",
  "system": "persona/analyst",
  "placeholders": [
    "kennzahlen",
    "zeitraum"
  ],
  "jsonSchema": {
    "type": "object",
    "properties": {
      "muster": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "titel": {
              "type": "string"
            },
            "beobachtung": {
              "type": "string"
            },
            "deutung": {
              "type": "string"
            },
            "empfehlung": {
              "type": "string"
            },
            "konzepte": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "themenbereiche": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "anzahl": {
              "type": "integer"
            },
            "zeitraum": {
              "type": "string"
            },
            "vertrauen": {
              "type": "string",
              "enum": [
                "niedrig",
                "mittel",
                "hoch"
              ]
            }
          },
          "required": [
            "titel",
            "beobachtung",
            "deutung",
            "empfehlung",
            "konzepte",
            "themenbereiche",
            "anzahl",
            "zeitraum",
            "vertrauen"
          ],
          "additionalProperties": false
        }
      },
      "hinweis": {
        "type": "string"
      }
    },
    "required": [
      "muster",
      "hinweis"
    ],
    "additionalProperties": false
  }
}
---
Du bekommst die **aggregierten** Fehlerkennzahlen eines einzelnen Lernenden
aus einem abgegrenzten Zeitraum. Rohprotokolle, Antworttexte oder einzelne
Hände siehst du bewusst nicht — es geht um Muster, nicht um Einzelfälle.

Zeitraum der Auswertung: {{zeitraum}}

Kennzahlen:

{{kennzahlen}}

Aufgabe:

1. Benenne **drei bis fünf Muster**. Ein Muster ist etwas, das sich über
   mehrere Konzepte, mehrere Wochen oder mehrere Kontexte hinweg wiederholt.
   Ein einzelnes auffälliges Konzept ist kein Muster.
2. Gib je Muster getrennt an:
   - `beobachtung` — **nur was in den Zahlen steht**, nachzählbar. Nenne die
     Konzepte und die Anzahlen, aus denen du es abliest.
   - `deutung` — was es fachlich bedeuten könnte, mit deiner Begründung. Hier
     darfst du Poker-Wissen einbringen; kennzeichne es als Schluss, nicht als
     Befund.
   - `empfehlung` — ein konkreter nächster Schritt, keine Allgemeinplätze.
3. Belege jedes Muster in `konzepte`, `themenbereiche`, `anzahl` und
   `zeitraum` — mit **genau den Bezeichnungen, die oben stehen**. Erfinde keine
   Konzepte und keine Zahlen.
4. Setze `vertrauen` ehrlich: `hoch` nur, wenn das Muster auf vielen
   Beobachtungen über mehrere Wochen beruht.

Worauf du zuerst schaust:

- **Wiederholte Fehler trotz zwischenzeitlich gelungener Wiederholung.** Das
  ist das stärkste Signal im Datensatz: Das Konzept saß schon einmal und ist
  wieder gekippt — ein festsitzender Denkfehler, keine Wissenslücke.
- **Unterschiede zwischen den Kontexten.** Wer in der Theorie sicher ist und im
  Drill scheitert, hat ein anderes Problem als umgekehrt: Das eine ist
  fehlende Anwendung unter Zeitdruck, das andere fehlendes Verständnis hinter
  einer auswendig gelernten Regel.
- **Die Entwicklung über die Wochen.** Ein häufiger Fehler, der abnimmt,
  braucht keine Empfehlung mehr.
- **Schwere Fehler vor häufigen.** Ein seltener, teurer Fehler wiegt mehr als
  ein häufiger, billiger.

Wenn die Daten kein tragfähiges Muster hergeben — zu wenige Beobachtungen, zu
breit gestreut, kein erkennbarer Zusammenhang —, dann gib eine **kürzere Liste
oder eine leere Liste** zurück und schreibe den Grund nach `hinweis`. Ein
erfundenes Muster ist schlimmer als gar keins: Es lenkt Lernzeit in die falsche
Richtung, und der Lernende hat keine Möglichkeit, den Fehler zu bemerken.

Steht kein Hinweis an, lass `hinweis` leer.

{{> partial/data-truth}}

{{> partial/json-output}}
