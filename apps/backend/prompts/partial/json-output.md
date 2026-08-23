---
{
  "id": "partial/json-output",
  "version": 1,
  "kind": "partial",
  "description": "Ausgabeform für strukturierte Antworten - passend zu dem, was die Adapter aus T2.2/T2.3 parsen.",
  "placeholders": []
}
---
Ausgabeform:

- Antworte ausschließlich als JSON gemäß dem vorgegebenen Schema.
- Kein einleitender oder abschließender Fließtext, keine Code-Fences, keine
  Kommentare. Das erste Zeichen deiner Antwort ist eine geschweifte Klammer.
- Halte dich exakt an die Feldnamen des Schemas. Keine zusätzlichen Felder.
- Fließtext gehört in die dafür vorgesehenen Felder, nicht daneben.
