import { CHART_POSITIONS, EMPTY_CHART_SPOT, isChartActionKind } from '@gto/shared';
import type { ChartAction, ChartActionKind, ChartPosition, ChartSpot } from '@gto/shared';

/**
 * Spot-Metadaten und Aktionen aus der Bildunterschrift (AP3.T3.3).
 *
 * **Deterministisch, ohne KI.** Was die Unterschrift hergibt, wird gelesen und
 * nicht geraten — das Modell bekommt diese Angaben als Kontext mit, damit es
 * den Spot richtig einordnet, aber es bestimmt sie nicht. Was die Unterschrift
 * nicht hergibt, bleibt `null`.
 *
 * Beispiele aus der Quelle:
 *
 *     Hand Range 96: SB vs BB (15bb)
 *     Hand Range 99: SB vs BB (25bb)          • Raise 3.3x 30% …
 *     Hand Range 7:  BB defend vs CO 2.25x (40bb)
 *     Hand Range 300: CO 25bb (2x vs SB 3x 3-bet)
 */

/* -------------------------------------------------------------------------
 * Aktionen
 * ---------------------------------------------------------------------- */

/**
 * Ordnet die Aktionsbeschriftung der Unterschrift einer Aktionsart zu.
 *
 * Die Zuordnungstabelle stammt aus den tatsächlich vorkommenden
 * Beschriftungen (siehe ADR-0032); alles, was nicht passt, ergibt `null` und
 * gilt als nicht zuordenbar — es wird nicht auf `fold` oder `raise` geraten.
 */
export function parseChartAction(label: string): ChartAction | null {
  const text = label.trim().toLowerCase();
  if (text === '') return null;

  const sizing = extractSizing(text);
  const kind = actionKindOf(text);
  if (kind === null) return null;
  return { kind, sizing };
}

function actionKindOf(text: string): ChartActionKind | null {
  // Reihenfolge zaehlt: "5-bet all-in" ist ein 5-Bet, nicht ein All-in;
  // "call all-in" ist ein Call.
  if (/^fold|^folded/.test(text)) return 'fold';
  if (/^check/.test(text)) return 'check';
  if (/^call|^defend/.test(text)) return 'call';
  if (/^limp/.test(text)) return 'limp';
  if (/^5-?\s?bet/.test(text)) return 'five_bet';
  if (/^4-?\s?bet/.test(text)) return 'four_bet';
  if (/^3-?\s?bet/.test(text)) return 'three_bet';
  if (/^all-?in|^push|^jam|^shove/.test(text)) return 'all_in';
  if (/^bet/.test(text)) return 'bet';
  if (/^raise|^\d/.test(text)) return 'raise';
  return null;
}

/** Liest die Groessenangabe: `2.5x`, `10bb`, `pot`. */
function extractSizing(text: string): string | null {
  const multiple = /(\d+(?:[.,]\d+)?)\s*x\b/.exec(text);
  if (multiple) return `${(multiple[1] as string).replace(',', '.')}x`;

  const blinds = /(\d+(?:[.,]\d+)?)\s*bb\b/.exec(text);
  if (blinds) return `${(blinds[1] as string).replace(',', '.')}bb`;

  if (/\bfull pot\b/.test(text)) return 'pot';
  if (/\bpot\b/.test(text)) return 'pot';
  if (/\ball-?in\b/.test(text) && !/^all-?in/.test(text)) return 'all-in';
  return null;
}

/** Wandelt die geparsten Caption-Aktionen in die Legende des Charts. */
export function captionActionsToLegend(
  captionActions: readonly { action: string; percent: number }[],
): { actions: ChartAction[]; unmapped: string[] } {
  const actions: ChartAction[] = [];
  const unmapped: string[] = [];
  const seen = new Set<string>();

  for (const entry of captionActions) {
    const parsed = parseChartAction(entry.action);
    if (parsed === null) {
      unmapped.push(entry.action);
      continue;
    }
    const key = `${parsed.kind}@${parsed.sizing ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(parsed);
  }

  return { actions, unmapped };
}

/* -------------------------------------------------------------------------
 * Spot
 * ---------------------------------------------------------------------- */

/** Positionsschreibweisen, wie sie im Buch vorkommen. */
const POSITION_ALIASES: readonly (readonly [RegExp, ChartPosition])[] = [
  [/\bUTG\s*\+\s*1\b/i, 'UTG+1'],
  [/\bUTG\s*\+\s*2\b/i, 'UTG+2'],
  [/\bUTG\b/i, 'UTG'],
  [/\bLJ\b|\blojack\b/i, 'LJ'],
  [/\bHJ\b|\bhijack\b/i, 'HJ'],
  [/\bCO\b|\bcutoff\b/i, 'CO'],
  [/\bBN\b|\bBTN\b|\bbutton\b/i, 'BN'],
  [/\bSB\b/i, 'SB'],
  [/\bBB\b(?!\s*\))/i, 'BB'],
];

/**
 * Liest den Spot aus dem beschreibenden Teil der Unterschrift.
 *
 * @param spotText Der Teil hinter `Hand Range N:` und vor den
 *   Aktions-Prozenten — in T3.1 als `caption_spot` gespeichert.
 * @param captionActions Die geparsten Aktions-Prozente; ihre Groessenangaben
 *   ergaenzen die Sizings.
 */
export function parseChartSpot(
  spotText: string | null,
  captionActions: readonly { action: string; percent: number }[] = [],
): ChartSpot {
  if (spotText === null || spotText.trim() === '') {
    return { ...EMPTY_CHART_SPOT, sizings: sizingsOf([], captionActions) };
  }

  const text = spotText.trim();

  // Positionen in Textreihenfolge: die erste ist die Heldenposition, eine
  // zweite hinter "vs" die Gegenposition.
  const found: { position: ChartPosition; index: number }[] = [];
  for (const [pattern, position] of POSITION_ALIASES) {
    const match = pattern.exec(text);
    if (!match) continue;
    // Eine laengere Schreibweise gewinnt gegen die kuerzere an derselben
    // Stelle (UTG+1 vor UTG).
    if (found.some((entry) => overlaps(entry.index, match.index))) continue;
    found.push({ position, index: match.index });
  }
  found.sort((a, b) => a.index - b.index);

  const stackDepthBb = parseStackDepth(text);
  const sizings = sizingsOf(collectSizings(text), captionActions);

  return {
    format: parseFormat(text),
    heroPosition: found[0]?.position ?? null,
    villainPosition: found[1]?.position ?? null,
    stackDepthBb,
    actionSequence: parseActionSequence(text),
    sizings,
  };
}

function overlaps(a: number, b: number): boolean {
  return Math.abs(a - b) < 3;
}

/** `(15bb)`, `25bb`, `10-25bb` → die (obere) Stacktiefe. */
function parseStackDepth(text: string): number | null {
  const range = /(\d+)\s*-\s*(\d+)\s*bb\b/i.exec(text);
  if (range) return Number(range[2]);
  const single = /(\d+(?:[.,]\d+)?)\s*bb\b/i.exec(text);
  if (single) return Number((single[1] as string).replace(',', '.'));
  return null;
}

/**
 * Cash oder Turnier.
 *
 * Das Buch trennt beides über die Kapitel, nicht über die Unterschrift;
 * hier wird nur ausgewertet, was ausdrücklich dasteht. Sonst `null` — die
 * Kapitelzuordnung liefert die Antwort später zuverlässiger als eine Heuristik
 * auf einer Zeile Text.
 */
function parseFormat(text: string): 'cash' | 'mtt' | null {
  if (/\bcash\b|\b100bb\b/i.test(text)) return 'cash';
  if (/\bMTT\b|\bICM\b/i.test(text)) return 'mtt';
  return null;
}

/** Der Teil in Klammern bzw. hinter `vs` beschreibt die Aktionsfolge. */
function parseActionSequence(text: string): string | null {
  const parenthesis = /\(([^)]*(?:vs|raise|limp|3-bet|4-bet|all-in|open|rejam)[^)]*)\)/i.exec(text);
  if (parenthesis) return (parenthesis[1] as string).trim();

  const versus = /\b(vs\b.*)$/i.exec(text.replace(/\([^)]*\)\s*$/, '').trim());
  if (versus) return (versus[1] as string).trim();

  return null;
}

/** Groessenangaben im beschreibenden Text. */
function collectSizings(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(/(\d+(?:[.,]\d+)?)\s*x\b/gi)) {
    result.push(`${(match[1] as string).replace(',', '.')}x`);
  }
  return result;
}

function sizingsOf(
  fromText: readonly string[],
  captionActions: readonly { action: string; percent: number }[],
): string[] {
  const result = new Set<string>(fromText);
  for (const entry of captionActions) {
    const sizing = parseChartAction(entry.action)?.sizing;
    if (sizing !== null && sizing !== undefined && sizing !== 'all-in') result.add(sizing);
  }
  return [...result];
}

/* -------------------------------------------------------------------------
 * Antwort des Modells
 * ---------------------------------------------------------------------- */

/** Rohform einer Zelle, wie sie das Template liefert. */
interface RawCell {
  hand?: unknown;
  aktionen?: unknown;
}

/**
 * Wandelt die Modellantwort in die Matrix des Schemas.
 *
 * Bewusst tolerant beim Einlesen und streng bei der Pruefung: Hier wird nur
 * umgeformt, die Vollstaendigkeit prueft `validateChartMatrix()`.
 */
export function toChartMatrix(cells: unknown): {
  hand: string;
  actions: { action: ChartAction; percent: number }[];
}[] {
  if (!Array.isArray(cells)) return [];

  return cells.map((raw: RawCell) => {
    const hand = typeof raw?.hand === 'string' ? raw.hand.trim() : '';
    const list = Array.isArray(raw?.aktionen) ? raw.aktionen : [];

    const actions = list
      .map((entry) => {
        const record = entry as { art?: unknown; sizing?: unknown; prozent?: unknown };
        const kind = record?.art;
        if (!isChartActionKind(kind)) return null;
        const sizing =
          typeof record.sizing === 'string' && record.sizing.trim() !== ''
            ? record.sizing.trim()
            : null;
        const percent = typeof record.prozent === 'number' ? record.prozent : Number.NaN;
        return { action: { kind, sizing }, percent };
      })
      .filter((entry): entry is { action: ChartAction; percent: number } => entry !== null);

    return { hand, actions };
  });
}

/** Alle Positionen als Liste - fuer den Prompt. */
export function renderPositions(): string {
  return CHART_POSITIONS.join(', ');
}
