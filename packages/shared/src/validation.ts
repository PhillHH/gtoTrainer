/**
 * Verträge der Chart-Validierung (AP3.T3.4).
 *
 * Die Chart-Daten aus T3.3 sind ungeprüfte Modellausgabe. Hier entscheidet
 * sich, ob sie zur Wahrheit werden dürfen — das ist die Gegenmaßnahme zu
 * Risiko R2 aus dem Gesamtscope.
 *
 * **Drei unabhängige Prüfungen.** Unabhängig heißt: Keine speist sich aus den
 * Daten, die sie prüft. Die Frequenzsumme rechnet innerhalb der Matrix, der
 * Caption-Abgleich hält sie gegen die Prozentwerte aus T3.1 (die kein Modell je
 * gesehen hat), die Plausibilität prüft die Form gegen Pokerwissen.
 */

/* -------------------------------------------------------------------------
 * Prüfarten und Befunde
 * ---------------------------------------------------------------------- */

/** Die drei Prüfarten. */
export const CHART_CHECKS = [
  'frequency-sum',
  'caption-match',
  'legend-match',
  'plausibility',
] as const;
export type ChartCheck = (typeof CHART_CHECKS)[number];

export function isChartCheck(value: unknown): value is ChartCheck {
  return typeof value === 'string' && (CHART_CHECKS as readonly string[]).includes(value);
}

/**
 * Schweregrad eines Befunds.
 *
 * - `error`   — verhindert `validated`. Das Chart bleibt `raw`.
 * - `warning` — Hinweis; blockiert nicht. Die Heuristiken aus Prüfung 3 melden
 *   auf dieser Stufe, weil sie Hinweisgeber sind und keine Beweise.
 * - `info`    — Sachverhalt ohne Schuldzuweisung, etwa „nicht prüfbar".
 */
export const CHART_FINDING_SEVERITIES = ['error', 'warning', 'info'] as const;
export type ChartFindingSeverity = (typeof CHART_FINDING_SEVERITIES)[number];

/** Art eines Befunds. Jede Art gehört zu genau einer Prüfung. */
export const CHART_FINDING_KINDS = [
  // Prüfung 1
  'frequency-sum-off',
  // Prüfung 2
  'caption-mismatch',
  'caption-missing-action',
  'caption-not-checkable',
  'legend-mismatch',
  'legend-missing-action',
  'legend-not-checkable',
  // Prüfung 3
  'incomplete-matrix',
  'empty-cell',
  'monotonicity',
  'outlier',
] as const;
export type ChartFindingKind = (typeof CHART_FINDING_KINDS)[number];

/** Welche Prüfung eine Befundart erzeugt. */
export const FINDING_CHECK: Readonly<Record<ChartFindingKind, ChartCheck>> = {
  'frequency-sum-off': 'frequency-sum',
  'caption-mismatch': 'caption-match',
  'caption-missing-action': 'caption-match',
  'caption-not-checkable': 'caption-match',
  'legend-mismatch': 'legend-match',
  'legend-missing-action': 'legend-match',
  'legend-not-checkable': 'legend-match',
  'incomplete-matrix': 'plausibility',
  'empty-cell': 'plausibility',
  monotonicity: 'plausibility',
  outlier: 'plausibility',
};

/** Ein einzelner Befund. */
export interface ChartFinding {
  readonly check: ChartCheck;
  readonly kind: ChartFindingKind;
  readonly severity: ChartFindingSeverity;
  /** Betroffenes Blatt, wenn der Befund zellgenau ist. */
  readonly hand: string | null;
  /** Betroffene Aktionsart, wenn der Befund aktionsgenau ist. */
  readonly actionKind: string | null;
  /** Gemessener Wert (Prozent bzw. Prozentpunkte). */
  readonly measured: number | null;
  /** Erwarteter Wert. */
  readonly expected: number | null;
  /** Klartext für die Review-Ansicht. */
  readonly detail: string;
}

/* -------------------------------------------------------------------------
 * Toleranzen
 * ---------------------------------------------------------------------- */

/**
 * Toleranzen der Prüfungen. Bewusst **vorab** festgelegt und begründet
 * (ADR-0034) — sie werden nicht nachträglich an ein Ergebnis angepasst.
 */
export const CHART_TOLERANCES = {
  /**
   * Frequenzsumme je Zelle in Prozentpunkten.
   *
   * Das Buch rundet seine Anteile; ein Chart mit drei Aktionen zu je einer
   * Nachkommastelle kann legitim 99,9 oder 100,1 ergeben. 2,0 pp lässt Raum
   * für gerundete Drittel (33,3 × 3 = 99,9) und für die Schätzung von
   * Flächenanteilen bei Mischzellen, ohne echte Lesefehler durchzulassen —
   * eine vergessene Aktion verschiebt die Summe um ein Vielfaches davon.
   */
  frequencySumPp: 2.0,
  /**
   * Combo-gewichteter Abgleich gegen die Caption-Prozente in Prozentpunkten.
   * Der Wert ist von der AP-Datei vorgegeben.
   */
  captionMatchPp: 1.5,
  /**
   * Combo-gewichteter Abgleich gegen die **im Bild gedruckte Legende** in
   * Prozentpunkten (AP3.T3.6-fix).
   *
   * Derselbe Wert wie beim Caption-Abgleich, und aus demselben Grund: Der
   * Messfehler sitzt nicht im Vergleichswert, sondern in der Matrix. Die
   * gedruckte Legende ist gesetzter Text mit zwei Nachkommastellen
   * (`59.65 %`) — Ziffern abzulesen ist etwas anderes, als einen Farbanteil zu
   * schätzen. Die Unsicherheit stammt also allein aus der combo-gewichteten
   * Summe über 169 Zellen, und für die hat T3.4 bereits 1,5 pp begründet.
   *
   * Am Bestand geprüft: 15 der 21 automatisch bestandenen Charts trafen ihren
   * gedruckten Wert auf ≤ 0,09 pp, HR 16 nach der Korrektur auf 0,53 pp — alle
   * weit innerhalb. Die fünf nachweislich falsch gelesenen Charts lagen
   * zwischen 1,81 und 11,39 pp und werden damit alle erkannt.
   */
  legendMatchPp: 1.5,
  /**
   * Monotonie: Um wie viele Prozentpunkte darf eine **dominierte** Hand
   * aggressiver gespielt werden als die dominierende, bevor es auffällt.
   * Großzügig, weil echte Strategien lokale Ausnahmen kennen (Blocker,
   * Playability); 25 pp trifft vertauschte Zeilen, nicht Feinheiten.
   */
  monotonicityPp: 25,
  /**
   * Ausreißer: Abweichung einer Zelle vom Mittel ihrer Rasternachbarn, ab der
   * gemeldet wird — und nur, wenn die Nachbarn untereinander einig sind.
   */
  outlierPp: 60,
} as const;

/* -------------------------------------------------------------------------
 * Ergebnis eines Validierungslaufs
 * ---------------------------------------------------------------------- */

/** Welche Prüfungen liefen und was sie ergaben. */
export interface ChartValidationResult {
  readonly findings: readonly ChartFinding[];
  /** Combo-gewichtete Gesamtfrequenz je Aktionsart, wie gemessen. */
  readonly weightedTotals: Readonly<Record<string, number>>;
  /** Die Caption-Prozente, gegen die geprüft wurde. */
  readonly captionTotals: Readonly<Record<string, number>>;
  /** Die gedruckten Legendenwerte, gegen die geprüft wurde. */
  readonly legendTotals: Readonly<Record<string, number>>;
  /** `true`, wenn kein Befund mit Schweregrad `error` vorliegt. */
  readonly passed: boolean;
}

/** Schalter je Heuristik — jede einzeln abschaltbar. */
export interface ChartCheckOptions {
  readonly frequencySum?: boolean;
  readonly captionMatch?: boolean;
  /** Abgleich gegen die im Bild gedruckte Legende (AP3.T3.6-fix). */
  readonly legendMatch?: boolean;
  readonly completeness?: boolean;
  readonly monotonicity?: boolean;
  readonly outlier?: boolean;
}

/** Alle Prüfungen an. */
export const ALL_CHECKS: Required<ChartCheckOptions> = {
  frequencySum: true,
  captionMatch: true,
  legendMatch: true,
  completeness: true,
  monotonicity: true,
  outlier: true,
};

/* -------------------------------------------------------------------------
 * Herkunft einer Zelle
 * ---------------------------------------------------------------------- */

/**
 * Woher der Wert einer Zelle stammt.
 *
 * `manual` ist gegen jedes automatische Überschreiben geschützt — weder ein
 * erneuter Validierungslauf noch ein Zweitdurchlauf fasst solche Zellen an.
 */
export const CHART_CELL_SOURCES = ['model', 'manual'] as const;
export type ChartCellSource = (typeof CHART_CELL_SOURCES)[number];

/* -------------------------------------------------------------------------
 * Review-Ansicht
 * ---------------------------------------------------------------------- */

/** Eine Zelle, wie die Review-Ansicht sie zeigt. */
export interface ReviewCell {
  readonly hand: string;
  readonly actions: readonly { kind: string; sizing: string | null; percent: number }[];
  readonly source: ChartCellSource;
  readonly correctedAt: string | null;
  /** `true`, wenn zu diesem Blatt ein Befund vorliegt. */
  readonly flagged: boolean;
}

/** Kurzform eines Charts für die Liste. */
export interface ReviewChartSummary {
  readonly id: string;
  readonly captionNumber: number | null;
  readonly captionRaw: string | null;
  readonly state: string;
  readonly model: string;
  readonly cellCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly manualCells: number;
  readonly recheckCount: number;
  readonly unusableReason: string | null;
}

/** Ein Chart mit allem, was die Korrektur braucht. */
export interface ReviewChartDetail extends ReviewChartSummary {
  readonly spot: Record<string, unknown>;
  readonly actions: readonly { kind: string; sizing: string | null }[];
  readonly cells: readonly ReviewCell[];
  readonly findings: readonly ChartFinding[];
  readonly weightedTotals: Readonly<Record<string, number>>;
  readonly captionTotals: Readonly<Record<string, number>>;
  /** URL des Original-Bildes — nur für angemeldete Nutzer abrufbar. */
  readonly imageUrl: string;
}

export interface ReviewListResponse {
  readonly charts: readonly ReviewChartSummary[];
  readonly totals: {
    readonly handRangeAssets: number;
    readonly digitized: number;
    readonly raw: number;
    readonly validated: number;
    readonly approved: number;
    readonly failed: number;
    readonly unusable: number;
    /** Anteil `approved` an allen `hand_range`-Assets, 0-1. */
    readonly approvedShare: number;
  };
  readonly findingsByCheck: Readonly<Record<string, number>>;
}

/** Korrektur einer Zelle durch den Menschen. */
export interface ChartCellUpdate {
  readonly hand: string;
  readonly actions: readonly { kind: string; sizing?: string | null; percent: number }[];
}

export interface ChartCellUpdateRequest {
  readonly cells: readonly ChartCellUpdate[];
}

export interface ChartApproveResponse {
  readonly approved: number;
}

export interface ChartUnusableRequest {
  readonly reason: string;
}

/** Fehlerantwort der Review-Endpunkte. */
export interface ChartErrorResponse {
  readonly error: 'invalid_chart';
  readonly message: string;
  readonly fields: readonly { field: string; message: string }[];
}

export function isChartErrorResponse(value: unknown): value is ChartErrorResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { error?: unknown }).error === 'invalid_chart' &&
    Array.isArray((value as { fields?: unknown }).fields)
  );
}
