import type { LlmJsonSchema } from '@gto/shared';

/**
 * Robustes Herausloesen einer JSON-Nutzlast aus einem Antworttext und eine
 * schlanke Schemapruefung.
 *
 * Die CLI liefert bei `--json-schema` bereits ein geparstes `structured_output`
 * (in T2.1 beobachtet). Diese Funktionen sind das Sicherheitsnetz fuer den
 * Fall, dass die Nutzlast doch nur im Antworttext steht - in Code-Fences oder
 * von Fliesstext umgeben.
 */

/**
 * Sucht die JSON-Nutzlast in `text`. Reihenfolge:
 *
 * 1. der ganze Text ist bereits JSON,
 * 2. ein umschliessender Code-Fence (```json … ``` oder ``` … ```),
 * 3. das erste vollstaendige Objekt oder Array im Text (Wrapper-Text).
 *
 * Gibt `undefined` zurueck, wenn nichts Auswertbares gefunden wird.
 */
export function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct.value;

  const fenced = stripCodeFence(trimmed);
  if (fenced !== undefined) {
    const parsed = tryParse(fenced);
    if (parsed !== undefined) return parsed.value;
  }

  const embedded = findBalanced(trimmed);
  if (embedded !== undefined) {
    const parsed = tryParse(embedded);
    if (parsed !== undefined) return parsed.value;
  }

  return undefined;
}

function tryParse(candidate: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(candidate) };
  } catch {
    return undefined;
  }
}

/** Entfernt einen Markdown-Code-Fence samt optionaler Sprachangabe. */
function stripCodeFence(text: string): string | undefined {
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  return match?.[1]?.trim();
}

/**
 * Findet das erste vollstaendige `{…}` oder `[…]` im Text und beachtet dabei
 * Zeichenketten und Escapes, damit eine Klammer in einem String die Zaehlung
 * nicht verdreht.
 */
function findBalanced(text: string): string | undefined {
  const start = firstIndexOfAny(text, ['{', '[']);
  if (start === undefined) return undefined;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return undefined;
}

function firstIndexOfAny(text: string, chars: readonly string[]): number | undefined {
  const found = chars
    .map((char) => text.indexOf(char))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  return found[0];
}

/**
 * Schlanke Pruefung gegen eine **Teilmenge** von JSON Schema.
 *
 * Geprueft werden: `type` (object, array, string, number, integer, boolean,
 * null), `required`, `properties` (rekursiv), `items` (rekursiv), `enum` und
 * `additionalProperties: false`. Alles andere wird bewusst ignoriert.
 *
 * Die **massgebliche** Durchsetzung leistet die CLI selbst ueber
 * `--json-schema`; diese Pruefung faengt nur ab, wenn die Nutzlast aus dem
 * Antworttext rekonstruiert werden musste. Deshalb reicht die Teilmenge, und
 * deshalb rechtfertigt der Fall keine Schema-Validator-Dependency
 * (siehe ADR-0023).
 *
 * Rueckgabe: Liste der Verstoesse, leer bei Erfolg.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: LlmJsonSchema,
  path = '$',
): readonly string[] {
  const problems: string[] = [];
  const expectedType = typeof schema['type'] === 'string' ? (schema['type'] as string) : undefined;

  if (expectedType !== undefined && !matchesType(value, expectedType)) {
    problems.push(`${path}: erwartet ${expectedType}, ist ${describe(value)}`);
    // Bei falschem Grundtyp bringt eine Detailpruefung nichts mehr.
    return problems;
  }

  const allowed = schema['enum'];
  if (Array.isArray(allowed) && !allowed.some((entry) => deepEqual(entry, value))) {
    problems.push(`${path}: Wert ${JSON.stringify(value)} ist nicht in enum`);
  }

  if (isRecord(value)) {
    const properties = isRecord(schema['properties']) ? schema['properties'] : undefined;
    const required = Array.isArray(schema['required']) ? schema['required'] : [];

    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) {
        problems.push(`${path}: Pflichtfeld "${key}" fehlt`);
      }
    }

    if (properties !== undefined) {
      if (schema['additionalProperties'] === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) problems.push(`${path}: unerwartetes Feld "${key}"`);
        }
      }
      for (const [key, sub] of Object.entries(properties)) {
        if (!(key in value) || !isRecord(sub)) continue;
        problems.push(...validateAgainstSchema(value[key], sub, `${path}.${key}`));
      }
    }
  }

  if (Array.isArray(value) && isRecord(schema['items'])) {
    const items = schema['items'];
    value.forEach((entry, index) => {
      problems.push(...validateAgainstSchema(entry, items, `${path}[${index}]`));
    });
  }

  return problems;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      // Unbekannte oder zusammengesetzte Typangaben werden nicht geprueft.
      return true;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
