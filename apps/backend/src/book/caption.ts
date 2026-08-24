import type { BookCaption, BookCaptionAction } from '@gto/shared';

/**
 * Bildunterschriften zerlegen (AP3.T3.1, Subtask 4).
 *
 * Die Unterschriften tragen die eigentliche Information:
 *
 *     *Hand Range 99: SB vs BB (25bb)*
 *     *• All-in 1.8% / • Raise 3.3x 30% /*
 *     *• Limp 50.3% / • Fold 17.9%*
 *
 * Daraus werden Etikett (`Hand Range`), Nummer (`99`), Spot (`SB vs BB (25bb)`)
 * und die Aktions-Prozentwerte gelesen. Der Rohtext bleibt **unverändert**
 * erhalten: Er ist in T3.4 die unabhängige Gegenprobe zur Vision-Extraktion,
 * und was hier verloren geht, ist dort nicht mehr zu rekonstruieren.
 *
 * Unerwartet aufgebaute Unterschriften werden nicht verworfen, sondern mit
 * `label: null` gespeichert und im Import-Report gezählt.
 */

/** Bekannte Etiketten. Reihenfolge egal, Vergleich erfolgt normalisiert. */
const LABELS = ['Hand Range', 'Table', 'Diagram', 'Heatmap', 'Figure', 'Chart'] as const;

const LABEL_PATTERN = new RegExp(
  `^(${LABELS.map((label) => `${label}s?`).join('|')})\\s*(\\d+)`,
  'i',
);

/**
 * Aktions-Prozente in Aufzählungsform: `• Raise 3.3x 30%`.
 * Der Aktionsname ist alles vor der Zahl - `Raise 3.3x` bleibt vollständig.
 */
const BULLET_ACTION_PATTERN = /[•·]\s*([^•·/%]+?)\s+(\d+(?:[.,]\d+)?)\s*%/g;

/**
 * Entfernt die Markdown-Kursivzeichen. Die Buchquelle setzt sie stellenweise
 * fehlerhaft (`…A♥Q♦3*♠`), deshalb wird nicht gepaart, sondern gestrichen.
 */
function stripEmphasis(line: string): string {
  return line.replace(/\*/g, '').trim();
}

/** Ist die Zeile eine Unterschriftszeile (kursiv, nicht fett)? */
export function isCaptionLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') && !trimmed.startsWith('**') && trimmed.length > 2;
}

/** Vereinheitlicht ein Etikett auf die Schreibweise aus {@link LABELS}. */
function canonicalLabel(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/s$/, '');
  const known = LABELS.find((label) => label.toLowerCase() === normalized);
  return known ?? raw.trim();
}

/**
 * Zerlegt eine Unterschrift.
 *
 * @param rawLines Zeilen der Unterschrift **wie in der Quelle**, inklusive
 *   Kursivzeichen. Sie werden unverändert als `raw` gespeichert.
 */
export function parseCaption(rawLines: readonly string[]): BookCaption {
  const raw = rawLines.join('\n');
  const text = rawLines
    .map((line) => stripEmphasis(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const actions = extractActions(text);

  // Der Aktionsteil beginnt beim ersten Aufzählungszeichen; davor stehen
  // Etikett und Spot-Beschreibung.
  const bulletAt = text.search(/[•·]/);
  const head = (bulletAt >= 0 ? text.slice(0, bulletAt) : text).trim();

  const labelMatch = LABEL_PATTERN.exec(head);
  if (!labelMatch) {
    return { raw, label: null, number: null, spot: head === '' ? null : head, actions };
  }

  const spot = head
    .slice(labelMatch[0].length)
    .replace(/^\s*[:.\-–]\s*/, '')
    .replace(/[\s/]+$/, '')
    .trim();

  return {
    raw,
    label: canonicalLabel(labelMatch[1] as string),
    number: Number(labelMatch[2]),
    spot: spot === '' ? null : spot,
    actions,
  };
}

function extractActions(text: string): BookCaptionAction[] {
  const actions: BookCaptionAction[] = [];
  BULLET_ACTION_PATTERN.lastIndex = 0;
  for (
    let match = BULLET_ACTION_PATTERN.exec(text);
    match;
    match = BULLET_ACTION_PATTERN.exec(text)
  ) {
    const action = (match[1] as string).replace(/[\s:]+$/, '').trim();
    const percent = Number((match[2] as string).replace(',', '.'));
    if (action !== '' && Number.isFinite(percent)) actions.push({ action, percent });
  }
  return actions;
}
