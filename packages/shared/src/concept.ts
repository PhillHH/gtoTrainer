/**
 * Verträge des Konzept-Graphen (AP3.T3.2).
 *
 * Der Konzept-Graph ist das Rückgrat des Lernpfads: AP4 führt Mastery und
 * Skill-Ratings je Themenbereich, AP5 unterrichtet entlang der Prerequisites.
 * Beides braucht dieselben Konstanten wie Backend und Review-Ansicht — deshalb
 * liegen sie hier und nirgendwo sonst.
 */

/* -------------------------------------------------------------------------
 * Themenbereiche — die Achsen des späteren Skill-Ratings (AP4/F09)
 * ---------------------------------------------------------------------- */

/**
 * Feste Liste der Themenbereiche. **Jedes Konzept hat genau einen.**
 *
 * Die Liste ist bewusst kurz und deckt das Buch vollständig ab. Sie ist nach
 * AP4 nur noch schwer zu ändern, weil dort Ratings je Bereich geführt werden —
 * Begründung und Zuschnitt siehe ADR-0031 in `docs/DECISIONS.md`.
 */
export const CONCEPT_TOPIC_AREAS = [
  { id: 'grundlagen-mathematik', label: 'Grundlagen und Mathematik' },
  { id: 'spieltheorie', label: 'Spieltheorie' },
  { id: 'software-werkzeuge', label: 'Software und Werkzeuge' },
  { id: 'preflop-ranges', label: 'Preflop-Ranges' },
  { id: 'preflop-verteidigung', label: 'Preflop-Verteidigung' },
  { id: 'spiel-gegen-3bets', label: 'Spiel gegen 3-Bets' },
  { id: 'turnier-metriken-icm', label: 'Turnier-Metriken und ICM' },
  { id: 'postflop-grundlagen', label: 'Postflop-Grundlagen' },
  { id: 'flop-spiel', label: 'Flop-Spiel' },
  { id: 'turn-spiel', label: 'Turn' },
  { id: 'river-spiel', label: 'River' },
  { id: 'mental-game', label: 'Mental Game' },
] as const;

export type ConceptTopicArea = (typeof CONCEPT_TOPIC_AREAS)[number]['id'];

/** Nur die Kennungen, in der Reihenfolge der Liste. */
export const CONCEPT_TOPIC_AREA_IDS: readonly ConceptTopicArea[] = CONCEPT_TOPIC_AREAS.map(
  (area) => area.id,
);

export function isConceptTopicArea(value: unknown): value is ConceptTopicArea {
  return typeof value === 'string' && (CONCEPT_TOPIC_AREA_IDS as readonly string[]).includes(value);
}

/** Beschriftung eines Themenbereichs; fällt auf die Kennung zurück. */
export function conceptTopicAreaLabel(id: string): string {
  return CONCEPT_TOPIC_AREAS.find((area) => area.id === id)?.label ?? id;
}

/* -------------------------------------------------------------------------
 * Level, Zustand, Herkunft
 * ---------------------------------------------------------------------- */

/**
 * Ab welchem Niveau ein Konzept sinnvoll ist. Die Stufen entsprechen den
 * Level-Fassungen der Lehrer-Persona aus T2.4.
 */
export const CONCEPT_LEVELS = ['einsteiger', 'fortgeschritten', 'experte'] as const;
export type ConceptLevel = (typeof CONCEPT_LEVELS)[number];

export function isConceptLevel(value: unknown): value is ConceptLevel {
  return typeof value === 'string' && (CONCEPT_LEVELS as readonly string[]).includes(value);
}

/** `draft` = KI-Vorschlag, noch nicht bestätigt. `approved` = menschlich geprüft. */
export const CONCEPT_STATES = ['draft', 'approved'] as const;
export type ConceptState = (typeof CONCEPT_STATES)[number];

export function isConceptState(value: unknown): value is ConceptState {
  return typeof value === 'string' && (CONCEPT_STATES as readonly string[]).includes(value);
}

/** Woher das Konzept stammt. */
export const CONCEPT_ORIGINS = ['ai', 'manual'] as const;
export type ConceptOrigin = (typeof CONCEPT_ORIGINS)[number];

/* -------------------------------------------------------------------------
 * JSON-Schema der KI-Vorschläge
 * ---------------------------------------------------------------------- */

/**
 * Schema, gegen das das Template `task/concept-taxonomy` antwortet.
 *
 * Bewusst flach und ohne IDs: Das Modell kennt keine Datenbankschlüssel. Es
 * verweist auf Voraussetzungen und Sektionen über **Titel** bzw.
 * **Sektionsschlüssel**; die Auflösung auf echte IDs ist deterministischer
 * Code (`apps/backend/src/concept/resolve.ts`), keine Modellaufgabe.
 */
export const CONCEPT_SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    konzepte: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titel: { type: 'string' },
          kurzdefinition: { type: 'string' },
          themenbereich: { type: 'string', enum: [...CONCEPT_TOPIC_AREA_IDS] },
          ab_level: { type: 'string', enum: [...CONCEPT_LEVELS] },
          voraussetzungen: { type: 'array', items: { type: 'string' } },
          sektionen: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'titel',
          'kurzdefinition',
          'themenbereich',
          'ab_level',
          'voraussetzungen',
          'sektionen',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['konzepte'],
  additionalProperties: false,
} as const;

/** Ein einzelner Vorschlag, so wie ihn das Modell liefert. */
export interface ConceptSuggestion {
  readonly titel: string;
  readonly kurzdefinition: string;
  readonly themenbereich: string;
  readonly ab_level: string;
  readonly voraussetzungen: readonly string[];
  readonly sektionen: readonly string[];
}

/* -------------------------------------------------------------------------
 * Review-Ansicht (AP3.T3.2)
 * ---------------------------------------------------------------------- */

/** Ein Konzept, wie es die Review-Ansicht anzeigt. */
export interface ConceptDetail {
  readonly id: string;
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly title: string;
  readonly summary: string;
  readonly topicArea: ConceptTopicArea;
  readonly minLevel: ConceptLevel;
  readonly state: ConceptState;
  readonly origin: ConceptOrigin;
  readonly ordinal: number;
  /** Voraussetzungen als aufgelöste Konzepte (Titel für die Anzeige). */
  readonly prerequisites: readonly { id: string; title: string }[];
  /** Titel-Referenzen, die sich nicht auflösen ließen — offene Punkte. */
  readonly unresolvedPrerequisites: readonly string[];
  readonly sectionCount: number;
  readonly chartCount: number;
}

/** Art einer Auffälligkeit im Konzept-Graphen. */
export const CONCEPT_ISSUE_KINDS = [
  'unresolved-prerequisite',
  'cycle',
  'duplicate',
  'without-section',
  'chapter-empty',
] as const;
export type ConceptIssueKind = (typeof CONCEPT_ISSUE_KINDS)[number];

export interface ConceptIssue {
  readonly kind: ConceptIssueKind;
  readonly detail: string;
  /** Betroffene Konzepte, soweit benennbar. */
  readonly conceptIds: readonly string[];
}

export interface ConceptChapterGroup {
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly partNumber: number;
  readonly concepts: readonly ConceptDetail[];
}

export interface ConceptListResponse {
  readonly chapters: readonly ConceptChapterGroup[];
  readonly issues: readonly ConceptIssue[];
  readonly topicAreas: readonly { id: ConceptTopicArea; label: string }[];
  readonly levels: readonly ConceptLevel[];
  readonly totals: {
    readonly concepts: number;
    readonly draft: number;
    readonly approved: number;
    readonly withoutSection: number;
  };
}

/** Teiländerung eines Konzepts durch die Review-Ansicht. */
export interface ConceptUpdate {
  readonly title?: string;
  readonly summary?: string;
  readonly topicArea?: ConceptTopicArea;
  readonly minLevel?: ConceptLevel;
  readonly state?: ConceptState;
  /** Vollständige Ersetzung der Voraussetzungen durch Konzept-IDs. */
  readonly prerequisiteIds?: readonly string[];
}

export interface ConceptUpdateResponse {
  readonly concept: ConceptDetail;
}

export interface ConceptApproveResponse {
  /** Wie viele Konzepte durch die Aktion auf `approved` gesetzt wurden. */
  readonly approved: number;
}

/** Fehlerantwort der Review-Endpunkte mit feldweiser Begründung. */
export interface ConceptErrorResponse {
  readonly error: 'invalid_concept';
  readonly message: string;
  readonly fields: readonly { field: string; message: string }[];
}

export function isConceptErrorResponse(value: unknown): value is ConceptErrorResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { error?: unknown }).error === 'invalid_concept' &&
    Array.isArray((value as { fields?: unknown }).fields)
  );
}
