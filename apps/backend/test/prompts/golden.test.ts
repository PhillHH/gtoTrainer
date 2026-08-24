import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { TemplateRegistry } from '../../src/prompts/index.js';
import type { RenderedRequest, TemplateValues } from '../../src/prompts/index.js';

/**
 * Golden-Tests: Template + Beispiel-Input -> abgelegte erwartete Ausgabe.
 *
 * Sinn: Eine Aenderung an einem Prompt soll **sichtbar** sein. Wer eine
 * Formulierung anpasst, sieht im Diff genau, was sich am gerenderten Prompt
 * aendert - statt die Didaktik unbemerkt zu verschieben.
 *
 * Erwartete Dateien bewusst neu schreiben:
 *
 *   pnpm prompts:golden
 *
 * In der CI ist das gesperrt (siehe Wache unten): Golden-Dateien duerfen sich
 * nur durch eine bewusste lokale Aktion aendern, nie durch einen Testlauf.
 */

const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url));
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';
const IN_CI =
  process.env['CI'] !== undefined && process.env['CI'] !== '' && process.env['CI'] !== 'false';

if (UPDATE && IN_CI) {
  throw new Error(
    'UPDATE_GOLDEN=1 ist in der CI nicht zulaessig: Golden-Dateien wuerden dort ' +
      'stillschweigend neu geschrieben und die Absicherung waere wertlos.',
  );
}

/** Beispiel-Input je Template. Jeder Fall bekommt eine Golden-Datei. */
interface TextCase {
  readonly name: string;
  readonly templateId: string;
  readonly values?: TemplateValues;
}

const TEXT_CASES: readonly TextCase[] = [
  { name: 'partial-language', templateId: 'partial/language' },
  { name: 'partial-data-truth', templateId: 'partial/data-truth' },
  { name: 'partial-json-output', templateId: 'partial/json-output' },
  {
    name: 'persona-teacher-einsteiger',
    templateId: 'persona/teacher',
    values: { level: 'Einsteiger: erste Beruehrung mit dem Thema' },
  },
  {
    name: 'persona-teacher-fortgeschritten',
    templateId: 'persona/teacher',
    values: { level: 'Fortgeschritten: kennt die Grundbegriffe sicher' },
  },
  { name: 'persona-grader', templateId: 'persona/grader' },
  { name: 'persona-analyst', templateId: 'persona/analyst' },
  { name: 'persona-taxonomist', templateId: 'persona/taxonomist' },
  { name: 'persona-chart-reader', templateId: 'persona/chart-reader' },
];

interface RequestCase {
  readonly name: string;
  readonly templateId: string;
  readonly values: TemplateValues;
}

const REQUEST_CASES: readonly RequestCase[] = [
  {
    // Chart-Digitalisierung (AP3.T3.3). Bewusst ohne Bild: Das Bild ist
    // Nutzlast, keine Prompt-Fassung - der Golden-Fall sichert den Text.
    name: 'task-chart-digitize',
    templateId: 'task/chart-digitize',
    values: {
      unterschrift:
        '*Hand Range 96: SB vs BB (15bb)*\n*• All-in 23.7% / • Limp 61.5% / • Fold 14.8%*',
      spot: ['- Position: SB', '- Gegenposition: BB', '- Stacktiefe: 15bb'].join('\n'),
      aktionen: ['- `all_in` — All-in', '- `limp` — Limp', '- `fold` — Fold'].join('\n'),
      blattliste: 'AA AKs AQs …\nAKo KK KQs …',
    },
  },
  {
    // Konzept-Taxonomie (AP3.T3.2). Die Werte sind bewusst erfunden und kurz -
    // Buchtext gehoert nicht in eine versionierte Golden-Datei.
    name: 'task-concept-taxonomy',
    templateId: 'task/concept-taxonomy',
    values: {
      kapitel: '02 — Beispielkapitel (Teil 1 von 2)',
      zielanzahl: '8',
      themenbereiche: [
        '   - `grundlagen-mathematik` — Grundlagen und Mathematik',
        '   - `spieltheorie` — Spieltheorie',
      ].join('\n'),
      bekannte_konzepte: '- Position am Tisch (Kapitel 1)',
      abschnitte:
        '[sektion: ch02/beispielabschnitt] Beispielabschnitt\n\n' +
        'Zwei Saetze Platzhaltertext fuer den Golden-Fall.',
    },
  },
  {
    name: 'task-concept-explanation',
    templateId: 'task/concept-explanation',
    values: {
      level: 'Einsteiger: erste Beruehrung mit dem Thema',
      concept: 'Position am Tisch',
      context:
        'Aus dem Kursmaterial: Wer spaeter handelt, hat mehr Information.\n' +
        'Diese Information laesst sich in bessere Entscheidungen umsetzen.',
    },
  },
];

let registry: TemplateRegistry;

beforeAll(() => {
  registry = TemplateRegistry.load();
});

/** Vergleicht gegen die Golden-Datei oder schreibt sie im Update-Modus neu. */
function assertGolden(name: string, actual: string): void {
  const file = join(GOLDEN_DIR, `${name}.txt`);

  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, actual, 'utf8');
    return;
  }

  if (!existsSync(file)) {
    throw new Error(
      `Golden-Datei fehlt: ${file}. Einmalig erzeugen mit "pnpm prompts:golden" und den Inhalt pruefen.`,
    );
  }
  expect(actual).toBe(readFileSync(file, 'utf8'));
}

/** Lesbare, stabile Darstellung eines Provider-Requests. */
function formatRequest(request: RenderedRequest): string {
  const blocks = request.messages.map((message) => {
    const text = message.content
      .map((block) => (block.type === 'text' ? block.text : `[bild ${block.mediaType}]`))
      .join('\n');
    return `=== message (${message.role}) ===\n${text}`;
  });

  return [
    '=== system ===',
    request.system,
    ...blocks,
    '=== jsonSchema ===',
    request.jsonSchema === undefined ? '(keines)' : JSON.stringify(request.jsonSchema, null, 2),
    '',
  ].join('\n');
}

describe('Golden-Tests: gerenderte Texte', () => {
  it.each(TEXT_CASES)('$name', ({ name, templateId, values }) => {
    assertGolden(name, `${registry.renderText(templateId, values ?? {})}\n`);
  });
});

describe('Golden-Tests: gerenderte Provider-Requests', () => {
  it.each(REQUEST_CASES)('$name', ({ name, templateId, values }) => {
    const request = registry.renderRequest(templateId, values, {
      model: 'claude-sonnet-5',
      maxTokens: 2048,
    });
    assertGolden(name, formatRequest(request));
  });
});

describe('Abdeckung', () => {
  it('deckt jedes Template mit mindestens einem Golden-Fall ab', () => {
    const covered = new Set([
      ...TEXT_CASES.map((entry) => entry.templateId),
      ...REQUEST_CASES.map((entry) => entry.templateId),
    ]);
    expect([...covered].sort()).toEqual(registry.ids());
  });

  it('ist im Update-Modus nur ausserhalb der CI erlaubt', () => {
    // Belegt die Wache am Dateianfang: beides zusammen ist ausgeschlossen.
    expect(UPDATE && IN_CI).toBe(false);
  });
});
