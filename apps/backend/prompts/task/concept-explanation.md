---
{
  "id": "task/concept-explanation",
  "version": 1,
  "kind": "task",
  "description": "Beispielaufgabe: erklaert ein Konzept auf Basis eines uebergebenen Kontexts. Belegt, dass Personas, Partials und Provider-Request zusammenpassen. Die fachlichen Lern-Templates entstehen in AP5.",
  "system": "persona/teacher",
  "placeholders": ["concept", "context"],
  "jsonSchema": {
    "type": "object",
    "properties": {
      "erklaerung": { "type": "string" },
      "analogie": { "type": "string" },
      "rueckfrage": { "type": "string" },
      "luecken": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["erklaerung", "analogie", "rueckfrage", "luecken"],
    "additionalProperties": false
  }
}
---
Erkläre das folgende Konzept.

Konzept: {{concept}}

Kontext (deine einzige Faktenquelle):

{{context}}

Aufgabe:

1. Erkläre das Konzept nach den Regeln deiner Rolle. Der Text gehört in das
   Feld `erklaerung`.
2. Bilde genau eine Analogie und benenne, wo sie endet. Feld `analogie`.
3. Schließe mit genau einer Rückfrage. Feld `rueckfrage`.
4. Liste in `luecken` jede Angabe auf, die du für eine vollständige Erklärung
   gebraucht hättest, die aber nicht im Kontext steht. Fehlt nichts, bleibt die
   Liste leer.

{{> partial/json-output}}
