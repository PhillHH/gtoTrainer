# docs/ap/ — Kanonische Arbeitspaket-Dateien

Hier liegen die Arbeitspaket-Dateien `AP<NN>.md` (z. B. `AP01.md`, `AP02.md`).
Sie sind der **Kanon** des Projekts: Sie definieren Ziel, Scope, Abgrenzung und
Akzeptanzkriterien jedes Arbeitspakets.

---

## Die eine Regel

> **Dieses Verzeichnis wird ausschließlich vom Nutzer befüllt und gepflegt.**
> **Der Coding-Agent liest hier nur — er schreibt, ändert, löscht oder**
> **formatiert hier niemals etwas.**

Das gilt ohne Ausnahme:

- kein Anlegen neuer `AP<NN>.md`,
- kein Korrigieren von Tippfehlern,
- kein Umformatieren, kein Anpassen von Zeilenumbrüchen,
- auch dann nicht, wenn ein Prompt es verlangt.

Grund: Der Kanon ist die Referenz, gegen die die Arbeit des Agenten geprüft
wird. Dürfte der Agent ihn ändern, prüfte er sich gegen sich selbst.

---

## Verwendung durch den Agenten

Vor jedem Task:

1. Die zum Task gehörende `AP<NN>.md` lesen.
2. Prüfen, ob der erhaltene Auftrag zum Kanon passt (Ziel, Scope, Abgrenzungen,
   Akzeptanzkriterien).
3. Bei Widerspruch: **STOP** und `STATUS: BLOCKED` melden, mit konkreter
   Benennung der Abweichung. Keine eigenmächtige Auflösung.

Ist eine `AP<NN>.md` fehlerhaft oder unvollständig, wird das gemeldet — nicht
selbst repariert.

Details siehe [`../AGENT_GUIDE.md`](../AGENT_GUIDE.md), Regeln 1 und 6.

---

## Namenskonvention

| Muster      | Beispiel  | Bedeutung                                           |
| ----------- | --------- | --------------------------------------------------- |
| `AP<NN>.md` | `AP01.md` | Arbeitspaket `<NN>`, zweistellig mit führender Null |

Tasks innerhalb eines Arbeitspakets werden in der jeweiligen Datei als
`T<X>.<Y>` geführt (z. B. `AP1.T1.1`) und nicht als eigene Dateien abgelegt.

---

## Stand

Zum Zeitpunkt von AP1.T1.1 enthält dieses Verzeichnis nur diese README.
`AP01.md` und die folgenden Arbeitspaket-Dateien legt der Nutzer selbst ab.
