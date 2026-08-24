/**
 * Verträge der Chart-Daten (AP3.T3.3).
 *
 * Ab hier sind diese Daten die **einzige Wahrheitsquelle** für jede objektiv
 * prüfbare Frage im Tool: Drills, Bewertungen, Szenarien und Handanalyse lesen
 * Frequenzen ausschließlich von hier. Deshalb ist das Schema streng — eine
 * unvollständige Matrix oder eine unbekannte Aktion ist ein Fehler, kein
 * Sonderfall.
 */

/* -------------------------------------------------------------------------
 * Die 169 Zellen der 13x13-Matrix
 * ---------------------------------------------------------------------- */

/** Kartenränge, absteigend — die Achsen des Rasters. */
export const CARD_RANKS = [
  'A',
  'K',
  'Q',
  'J',
  'T',
  '9',
  '8',
  '7',
  '6',
  '5',
  '4',
  '3',
  '2',
] as const;

export type CardRank = (typeof CARD_RANKS)[number];

/**
 * Alle 169 Startblätter in der üblichen Notation, in Rasterreihenfolge:
 * Diagonale = Paare (`AA`), oberhalb = suited (`AKs`), unterhalb = offsuit
 * (`AKo`). Zeile für Zeile, wie das Chart gelesen wird.
 */
export const CHART_HANDS: readonly string[] = CARD_RANKS.flatMap((row, rowIndex) =>
  CARD_RANKS.map((column, columnIndex) => {
    if (rowIndex === columnIndex) return `${row}${column}`;
    return rowIndex < columnIndex ? `${row}${column}s` : `${column}${row}o`;
  }),
);

/** Anzahl der Zellen. Eine Matrix mit weniger ist unvollständig. */
export const CHART_HAND_COUNT = 169;

/** Schnelle Zugehörigkeitsprüfung. */
const CHART_HAND_SET: ReadonlySet<string> = new Set(CHART_HANDS);

export function isChartHand(value: unknown): value is string {
  return typeof value === 'string' && CHART_HAND_SET.has(value);
}

/**
 * Combo-Gewicht eines Blattes: Paare 6, suited 4, offsuit 12.
 *
 * Wird in T3.4 für die gewichtete Gegenprobe gegen die Caption-Prozente
 * gebraucht; hier steht es, damit beide Seiten dieselbe Zahl verwenden.
 */
export function handComboWeight(hand: string): number {
  if (hand.endsWith('s')) return 4;
  if (hand.endsWith('o')) return 12;
  return 6;
}

/* -------------------------------------------------------------------------
 * Aktionen
 * ---------------------------------------------------------------------- */

/**
 * Geschlossene Menge der Aktionsarten.
 *
 * Abgeleitet aus den tatsächlich im Buch vorkommenden Bildunterschriften —
 * nicht erfunden und nicht offen gelassen. Freier Text wäre später nicht
 * vergleichbar: „3-bet", „3Bet 10bb" und „3-bet all-in" sind dieselbe Art mit
 * unterschiedlicher Größe. Begründung: ADR-0032.
 */
export const CHART_ACTION_KINDS = [
  'fold',
  'check',
  'call',
  'limp',
  'bet',
  'raise',
  'three_bet',
  'four_bet',
  'five_bet',
  'all_in',
] as const;

export type ChartActionKind = (typeof CHART_ACTION_KINDS)[number];

export function isChartActionKind(value: unknown): value is ChartActionKind {
  return typeof value === 'string' && (CHART_ACTION_KINDS as readonly string[]).includes(value);
}

/**
 * Eine Aktion des Charts: Art plus optionale Größenangabe.
 *
 * `sizing` ist bewusst eine normalisierte Zeichenkette und keine geschlossene
 * Menge — Bet-Größen sind Zahlen (`2.5x`, `10bb`, `pot`) und lassen sich nicht
 * sinnvoll aufzählen. Die **Art** ist geschlossen, und darauf stützen sich
 * Vergleiche und Suche.
 */
export interface ChartAction {
  readonly kind: ChartActionKind;
  /** z. B. `2.5x`, `3.3x`, `10bb`, `pot`; `null`, wenn ohne Größenangabe. */
  readonly sizing: string | null;
}

/** Stabile Kennung einer Aktion, z. B. `raise@2.5x` oder `fold`. */
export function chartActionKey(action: ChartAction): string {
  return action.sizing === null || action.sizing === ''
    ? action.kind
    : `${action.kind}@${action.sizing}`;
}

/** Anzeigename einer Aktion. */
const ACTION_LABELS: Readonly<Record<ChartActionKind, string>> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  limp: 'Limp',
  bet: 'Bet',
  raise: 'Raise',
  three_bet: '3-Bet',
  four_bet: '4-Bet',
  five_bet: '5-Bet',
  all_in: 'All-in',
};

export function chartActionLabel(action: ChartAction): string {
  const base = ACTION_LABELS[action.kind];
  return action.sizing ? `${base} ${action.sizing}` : base;
}

/* -------------------------------------------------------------------------
 * Matrix
 * ---------------------------------------------------------------------- */

/** Anteil einer Aktion an einer Zelle, in Prozent (0-100). */
export interface ChartCellAction {
  readonly action: ChartAction;
  readonly percent: number;
}

/** Eine Zelle: ein Blatt und seine Aktionsverteilung. */
export interface ChartCell {
  readonly hand: string;
  readonly actions: readonly ChartCellAction[];
}

/** Die vollständige Matrix: genau 169 Zellen, jedes Blatt genau einmal. */
export type ChartMatrix = readonly ChartCell[];

/* -------------------------------------------------------------------------
 * Spot-Metadaten
 * ---------------------------------------------------------------------- */

/** Tischpositionen im 9-max/6-max-Raster. */
export const CHART_POSITIONS = [
  'UTG',
  'UTG+1',
  'UTG+2',
  'LJ',
  'HJ',
  'CO',
  'BN',
  'SB',
  'BB',
] as const;

export type ChartPosition = (typeof CHART_POSITIONS)[number];

export function isChartPosition(value: unknown): value is ChartPosition {
  return typeof value === 'string' && (CHART_POSITIONS as readonly string[]).includes(value);
}

/** Spielform. */
export const CHART_FORMATS = ['cash', 'mtt'] as const;
export type ChartFormat = (typeof CHART_FORMATS)[number];

/**
 * Was sich aus der Bildunterschrift über den Spot sagen lässt.
 *
 * Alles hier wird **deterministisch aus der Unterschrift gelesen**, nicht vom
 * Modell geraten (`apps/backend/src/chart/spot.ts`). Was die Unterschrift nicht
 * hergibt, bleibt `null` — eine ehrliche Lücke statt einer plausiblen Erfindung.
 */
export interface ChartSpot {
  readonly format: ChartFormat | null;
  /** Position, deren Strategie das Chart zeigt. */
  readonly heroPosition: ChartPosition | null;
  /** Gegenposition, sofern die Unterschrift eine nennt. */
  readonly villainPosition: ChartPosition | null;
  /** Effektive Stacktiefe in Big Blinds. */
  readonly stackDepthBb: number | null;
  /** Aktionsfolge im Klartext der Unterschrift, z. B. `Limp vs 3x Raise`. */
  readonly actionSequence: string | null;
  /** In der Unterschrift genannte Größen, z. B. `['2.25x']`. */
  readonly sizings: readonly string[];
}

/** Leerer Spot — alles unbekannt. */
export const EMPTY_CHART_SPOT: ChartSpot = {
  format: null,
  heroPosition: null,
  villainPosition: null,
  stackDepthBb: null,
  actionSequence: null,
  sizings: [],
};

/* -------------------------------------------------------------------------
 * Zustand
 * ---------------------------------------------------------------------- */

/**
 * Lebenszyklus eines Charts.
 *
 * - `raw`        — vom Modell gelesen, ungeprüft. Entsteht in T3.3.
 * - `validated`  — die automatischen Prüfungen aus T3.4 sind bestanden.
 * - `approved`   — menschlich freigegeben. **Nur dieser Zustand ist ab T3.5
 *   nach außen sichtbar.**
 * - `failed`     — Digitalisierung nicht verwertbar; der Grund steht am Chart.
 *   Das entscheidet die Pipeline, nicht ein Mensch.
 * - `unusable`   — ein Mensch hat das Chart in der Review verworfen, mit
 *   Begruendung. Bewusst getrennt von `failed`: Das eine ist ein technischer
 *   Fehlschlag, das andere ein fachliches Urteil. T3.6 muss beides
 *   auseinanderhalten koennen.
 */
export const CHART_STATES = ['raw', 'validated', 'approved', 'failed', 'unusable'] as const;
export type ChartState = (typeof CHART_STATES)[number];

export function isChartState(value: unknown): value is ChartState {
  return typeof value === 'string' && (CHART_STATES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------
 * Prüfung der Matrix
 * ---------------------------------------------------------------------- */

/** Ein einzelner Verstoß gegen das Schema. */
export interface ChartMatrixIssue {
  readonly kind:
    | 'missing-hands'
    | 'unknown-hand'
    | 'duplicate-hand'
    | 'unknown-action'
    | 'percent-out-of-range'
    | 'empty-cell';
  readonly message: string;
}

/**
 * Prüft eine Matrix gegen das Schema.
 *
 * Bewusst **nicht** enthalten: die Frequenzsummen-Prüfung (≈100 % je Hand) und
 * der Abgleich gegen die Caption-Prozente. Beides ist Inhalt von T3.4. Hier
 * geht es allein um strukturelle Vollständigkeit und zulässige Werte.
 */
export function validateChartMatrix(matrix: unknown): ChartMatrixIssue[] {
  const issues: ChartMatrixIssue[] = [];

  if (!Array.isArray(matrix)) {
    return [{ kind: 'missing-hands', message: 'Die Matrix ist keine Liste von Zellen.' }];
  }

  const seen = new Set<string>();

  for (const raw of matrix) {
    const cell = raw as Partial<ChartCell>;
    const hand = cell?.hand;

    if (!isChartHand(hand)) {
      issues.push({
        kind: 'unknown-hand',
        message: `Unbekanntes Blatt "${String(hand)}". Erlaubt sind die 169 Blätter des 13x13-Rasters.`,
      });
      continue;
    }
    if (seen.has(hand)) {
      issues.push({ kind: 'duplicate-hand', message: `Blatt "${hand}" kommt mehrfach vor.` });
      continue;
    }
    seen.add(hand);

    const actions = cell?.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      issues.push({
        kind: 'empty-cell',
        message: `Zelle "${hand}" enthält keine Aktion. Auch reines Fold wird ausgewiesen.`,
      });
      continue;
    }

    for (const entry of actions) {
      const action = (entry as Partial<ChartCellAction>)?.action;
      if (!isChartActionKind((action as ChartAction | undefined)?.kind)) {
        issues.push({
          kind: 'unknown-action',
          message:
            `Zelle "${hand}": unbekannte Aktionsart "${String((action as ChartAction | undefined)?.kind)}". ` +
            `Erlaubt: ${CHART_ACTION_KINDS.join(', ')}.`,
        });
      }
      const percent = (entry as Partial<ChartCellAction>)?.percent;
      if (
        typeof percent !== 'number' ||
        !Number.isFinite(percent) ||
        percent < 0 ||
        percent > 100
      ) {
        issues.push({
          kind: 'percent-out-of-range',
          message: `Zelle "${hand}": Frequenz ${String(percent)} liegt außerhalb 0-100.`,
        });
      }
    }
  }

  const missing = CHART_HANDS.filter((hand) => !seen.has(hand));
  if (missing.length > 0) {
    issues.push({
      kind: 'missing-hands',
      message:
        `Die Matrix ist unvollständig: ${missing.length} von ${CHART_HAND_COUNT} Blättern fehlen ` +
        `(z. B. ${missing.slice(0, 5).join(', ')}).`,
    });
  }

  return issues;
}

/** Kurzform: Erfüllt die Matrix das Schema? */
export function isValidChartMatrix(matrix: unknown): matrix is ChartMatrix {
  return validateChartMatrix(matrix).length === 0;
}

/* -------------------------------------------------------------------------
 * JSON-Schema der Vision-Antwort
 * ---------------------------------------------------------------------- */

/**
 * Schema, gegen das das Template `task/chart-digitize` antwortet.
 *
 * Das Modell liefert die Matrix und meldet unsichere Bereiche; die
 * Spot-Metadaten kommen **nicht** von hier, sondern deterministisch aus der
 * Bildunterschrift.
 */
export const CHART_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    zellen: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          hand: { type: 'string' },
          aktionen: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                art: { type: 'string', enum: [...CHART_ACTION_KINDS] },
                sizing: { type: 'string' },
                prozent: { type: 'number' },
              },
              required: ['art', 'prozent'],
              additionalProperties: false,
            },
          },
        },
        required: ['hand', 'aktionen'],
        additionalProperties: false,
      },
    },
    unsicher: { type: 'array', items: { type: 'string' } },
    legende: { type: 'array', items: { type: 'string' } },
  },
  required: ['zellen', 'unsicher', 'legende'],
  additionalProperties: false,
} as const;

/* -------------------------------------------------------------------------
 * Abruf-DTOs
 * ---------------------------------------------------------------------- */

/** Ein Chart, wie es Folge-APs lesen. */
export interface RangeChart {
  readonly id: string;
  readonly assetId: string;
  readonly captionNumber: number | null;
  readonly captionRaw: string | null;
  readonly spot: ChartSpot;
  readonly state: ChartState;
  /** Modell, das die Matrix gelesen hat. */
  readonly model: string;
  /** Aktionen, die in diesem Chart vorkommen (Legende). */
  readonly actions: readonly ChartAction[];
  readonly matrix: ChartMatrix;
  /** Vom Modell gemeldete unsichere Bereiche. */
  readonly uncertain: readonly string[];
}
