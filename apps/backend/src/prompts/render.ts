import { TemplateError } from './types.js';
import type { TemplateValues } from './types.js';

/**
 * Platzhalter-Ersetzung - bewusst winzig und strikt.
 *
 * Die Syntax kennt genau zwei Formen:
 *
 * - `{{name}}`            - ein Wert, der beim Rendern eingesetzt wird,
 * - `{{> partial/id}}`    - ein Baustein, der beim **Laden** eingesetzt wird.
 *
 * Mehr braucht das Projekt nicht: keine Bedingungen, keine Schleifen, keine
 * Filter. Genau deshalb ist eine Template-Engine als Dependency nicht
 * gerechtfertigt (ADR-0025).
 */

/** Erfasst `{{name}}` und `{{> partial/id}}` in einem Durchlauf. */
const TOKEN = /\{\{\s*(>?)\s*([A-Za-z0-9_/-]+)\s*\}\}/g;

/** Ein im Text gefundener Platzhalter. */
export interface FoundToken {
  readonly kind: 'value' | 'partial';
  readonly name: string;
}

/** Listet alle Platzhalter eines Textes in Reihenfolge des Auftretens. */
export function findTokens(text: string): readonly FoundToken[] {
  const found: FoundToken[] = [];
  for (const match of text.matchAll(TOKEN)) {
    found.push({ kind: match[1] === '>' ? 'partial' : 'value', name: match[2] as string });
  }
  return found;
}

/** Die Namen aller Wert-Platzhalter, ohne Duplikate, in Fundreihenfolge. */
export function findValuePlaceholders(text: string): readonly string[] {
  const seen = new Set<string>();
  for (const token of findTokens(text)) {
    if (token.kind === 'value') seen.add(token.name);
  }
  return [...seen];
}

/**
 * Setzt Werte ein - **literal**.
 *
 * Der Ersatztext wird nicht erneut nach Platzhaltern durchsucht. Ein
 * Buchabschnitt oder eine Nutzerantwort, in der zufaellig `{{...}}` steht,
 * kann die Prompt-Struktur damit nicht veraendern.
 *
 * Strikt in beide Richtungen:
 * - ein deklarierter Platzhalter ohne Wert ist ein Fehler,
 * - ein Wert ohne passenden Platzhalter ist ein Fehler (faengt Tippfehler).
 */
export function renderBody(
  templateId: string,
  body: string,
  required: readonly string[],
  values: TemplateValues,
): string {
  assertValuesMatch(templateId, required, values);

  // Segmentweise zusammensetzen: Der eingesetzte Text landet direkt im
  // Ergebnis und wird nie wieder betrachtet.
  let result = '';
  let lastIndex = 0;

  for (const match of body.matchAll(TOKEN)) {
    const [raw, marker, name] = match;
    const index = match.index;

    if (marker === '>') {
      throw new TemplateError(
        `Template "${templateId}": Der Partial-Verweis {{> ${String(name)}}} wurde beim Laden nicht aufgeloest. ` +
          `Das ist ein Fehler im Lader, nicht in den Werten.`,
      );
    }

    const value = values[name as string];
    if (value === undefined) {
      // Kann nur auftreten, wenn `required` und der Rumpf auseinanderlaufen.
      throw new TemplateError(
        `Template "${templateId}": Fuer den Platzhalter "${String(name)}" wurde kein Wert uebergeben.`,
      );
    }

    result += body.slice(lastIndex, index) + value;
    lastIndex = index + raw.length;
  }

  return result + body.slice(lastIndex);
}

/** Prueft Werte gegen die erwarteten Platzhalter - beide Richtungen. */
export function assertValuesMatch(
  templateId: string,
  required: readonly string[],
  values: TemplateValues,
): void {
  const expected = new Set(required);
  const provided = Object.keys(values);

  const missing = required.filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    throw new TemplateError(
      `Template "${templateId}": Es fehlen Werte fuer die Platzhalter ${list(missing)}. ` +
        `Erwartet werden ${list(required)}.`,
    );
  }

  const unknown = provided.filter((name) => !expected.has(name));
  if (unknown.length > 0) {
    throw new TemplateError(
      `Template "${templateId}": Unbekannte Platzhalter ${list(unknown)} uebergeben. ` +
        `Das Template kennt ${list(required)}. Tippfehler im Namen?`,
    );
  }
}

function list(names: readonly string[]): string {
  if (names.length === 0) return '(keine)';
  return names.map((name) => `"${name}"`).join(', ');
}
