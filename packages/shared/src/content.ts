import type { ChartAction, ChartFormat, ChartPosition, ChartSpot, ChartState } from './chart.js';
import type { BookAssetType } from './book.js';
import type { ChartCellSource } from './validation.js';
import type { ConceptLevel, ConceptState, ConceptTopicArea } from './concept.js';

/**
 * Vertrag der Content-API (AP3.T3.5).
 *
 * Das ist die Schnittstelle, über die AP5 unterrichtet, AP6 rendert, AP7
 * Drills baut und AP8 Hände analysiert. Zwei Regeln prägen jeden Typ hier:
 *
 * 1. **Listenformen sind schlank.** Eine Kapitelübersicht trägt keine
 *    Volltexte, eine Chartliste keine Matrizen. Wer eine Übersicht abruft,
 *    will navigieren, nicht laden.
 * 2. **Detailformen sind vollständig.** Wer eine Sektion oder ein Chart
 *    gezielt anfordert, bekommt alles, was er dafür braucht — und nichts, was
 *    er sich anschließend nachladen müsste.
 *
 * Der Unterschied ist keine Bequemlichkeit, sondern Kontextdisziplin: Ein
 * Prompt in AP5 hat ein Token-Budget, und ein versehentlich mitgeliefertes
 * Kapitel sprengt es.
 */

/* -------------------------------------------------------------------------
 * Gemeinsame Verweise
 * ---------------------------------------------------------------------- */

/** Schlanker Verweis auf ein Konzept. */
export interface ConceptRef {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
}

/** Schlanker Verweis auf eine Sektion — ohne Volltext. */
export interface SectionRef {
  readonly id: string;
  readonly sectionKey: string;
  readonly title: string;
  readonly chapterNumber: number;
}

/** Ein Bild aus dem Buch. `imageUrl` ist auth-geschützt. */
export interface AssetRef {
  readonly id: string;
  readonly assetType: BookAssetType;
  readonly captionRaw: string | null;
  readonly captionNumber: number | null;
  readonly imageUrl: string;
  /** Gesetzt, wenn zu diesem Bild ein digitalisiertes Chart existiert. */
  readonly chartId: string | null;
  readonly chartState: ChartState | null;
}

/* -------------------------------------------------------------------------
 * Kapitel und Sektionen
 * ---------------------------------------------------------------------- */

/** Kapitel in der Übersicht — **ohne** Volltexte. */
export interface ChapterSummary {
  readonly id: string;
  readonly chapterNumber: number;
  readonly partNumber: number;
  readonly partTitle: string;
  readonly title: string;
  readonly ordinal: number;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly sectionCount: number;
  readonly conceptCount: number;
  readonly chartCount: number;
}

export interface ChapterListResponse {
  readonly chapters: readonly ChapterSummary[];
  readonly totals: {
    readonly chapters: number;
    readonly sections: number;
    readonly concepts: number;
    readonly approvedCharts: number;
  };
}

/** Sektion in der Liste — **ohne** Volltext, aber mit dessen Länge. */
export interface SectionSummary {
  readonly id: string;
  readonly sectionKey: string;
  readonly title: string;
  readonly level: number;
  readonly ordinal: number;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  /** Länge des Volltexts in Zeichen — die Grundlage für eine Budgetplanung. */
  readonly bodyChars: number;
  readonly conceptCount: number;
  readonly assetCount: number;
}

export interface SectionListResponse {
  readonly chapter: ChapterSummary;
  readonly sections: readonly SectionSummary[];
}

/** Eine einzelne Sektion mit allem, was ein Prompt braucht. */
export interface SectionDetail extends SectionSummary {
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly partNumber: number;
  /** Volltext, unverändert aus der Quelle. */
  readonly body: string;
  readonly concepts: readonly ConceptRef[];
  readonly assets: readonly AssetRef[];
}

/* -------------------------------------------------------------------------
 * Konzepte
 * ---------------------------------------------------------------------- */

/** Konzept in der Liste. Die Kurzdefinition ist kurz genug, um mitzukommen. */
export interface ContentConceptSummary {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly topicArea: ConceptTopicArea;
  readonly minLevel: ConceptLevel;
  readonly state: ConceptState;
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly ordinal: number;
  readonly prerequisiteCount: number;
  readonly dependentCount: number;
  readonly sectionCount: number;
  readonly chartCount: number;
}

export interface ContentConceptListResponse {
  readonly concepts: readonly ContentConceptSummary[];
  readonly totals: { readonly matched: number; readonly available: number };
  /** Die tatsächlich angewandten Filter — inklusive der Vorgabewerte. */
  readonly filters: {
    readonly chapter: number | null;
    readonly topicArea: ConceptTopicArea | null;
    readonly state: ConceptState;
    readonly level: ConceptLevel | null;
  };
}

/** Konzept im Detail — Voraussetzungen in **beide** Richtungen. */
export interface ContentConceptDetail extends ContentConceptSummary {
  /** Was vorher verstanden sein muss. */
  readonly prerequisites: readonly ConceptRef[];
  /** Was auf diesem Konzept aufbaut — die Gegenrichtung. */
  readonly dependents: readonly ConceptRef[];
  /** Vorgeschlagene Voraussetzungen ohne Treffer im Graphen (T3.2). */
  readonly unresolvedPrerequisites: readonly string[];
  readonly sections: readonly SectionRef[];
  readonly charts: readonly ChartSummary[];
}

/** Ein Schritt im Lernpfad. */
export interface LearningPathStep {
  /** 1-basierte Position in der Reihenfolge. */
  readonly step: number;
  /**
   * Ebene im Graphen: alles auf Ebene 0 hat keine Voraussetzungen, Ebene N
   * setzt mindestens ein Konzept aus Ebene N-1 voraus. Konzepte derselben
   * Ebene lassen sich in beliebiger Reihenfolge unterrichten.
   */
  readonly tier: number;
  readonly concept: ContentConceptSummary;
}

export interface LearningPathResponse {
  readonly steps: readonly LearningPathStep[];
  /**
   * Konzepte, die wegen eines Zyklus in keine Reihenfolge zu bringen sind.
   * Leer, solange der Graph zyklenfrei ist (T3.2 prüft das).
   */
  readonly cyclic: readonly ConceptRef[];
  readonly totals: { readonly steps: number; readonly tiers: number };
}

/* -------------------------------------------------------------------------
 * Charts
 * ---------------------------------------------------------------------- */

/** Chart in der Liste — **ohne** Matrix. */
export interface ChartSummary {
  readonly id: string;
  readonly assetId: string;
  readonly captionNumber: number | null;
  readonly captionRaw: string | null;
  readonly state: ChartState;
  readonly spot: ChartSpot;
  readonly actions: readonly ChartAction[];
  readonly cellCount: number;
  /** Modell, das die Matrix gelesen hat — Herkunftsnachweis. */
  readonly model: string;
  /** Zahl der von Hand korrigierten Zellen. */
  readonly manualCells: number;
  readonly chapterNumber: number | null;
  readonly sectionKey: string | null;
  readonly imageUrl: string;
}

export interface ChartListResponse {
  readonly charts: readonly ChartSummary[];
  readonly totals: { readonly matched: number; readonly approved: number };
  readonly filters: {
    readonly chapter: number | null;
    readonly concept: string | null;
    readonly includeUnapproved: boolean;
  };
}

/** Eine Zelle in der Antwort der Content-API. */
export interface ContentCell {
  readonly hand: string;
  readonly actions: readonly { kind: string; sizing: string | null; percent: number }[];
  readonly source: ChartCellSource;
}

/** Chart im Detail — mit vollständiger Matrix. */
export interface ChartDetail extends ChartSummary {
  /** Genau 169 Zellen, in Rasterreihenfolge (`CHART_HANDS`). */
  readonly matrix: readonly ContentCell[];
  /** Vom Modell gemeldete unsichere Bereiche — ehrliche Lücken. */
  readonly uncertain: readonly string[];
  /** Combo-gewichtete Gesamtfrequenz je Aktion (6/4/12). */
  readonly weightedTotals: Readonly<Record<string, number>>;
  /** Die Prozentwerte der Bildunterschrift (T3.1) als Gegenprobe. */
  readonly captionTotals: Readonly<Record<string, number>>;
  readonly approvedAt: string | null;
}

/** Antwort des gezielten Zellabrufs. */
export interface CellResponse {
  readonly chartId: string;
  readonly hand: string;
  readonly actions: readonly { kind: string; sizing: string | null; percent: number }[];
  readonly source: ChartCellSource;
  readonly correctedAt: string | null;
  /** Der Spot, damit die Antwort für sich allein verständlich ist. */
  readonly spot: ChartSpot;
  readonly state: ChartState;
}

/* -------------------------------------------------------------------------
 * Spot-Suche
 * ---------------------------------------------------------------------- */

/** Vorgabe für die Stacktiefen-Umgebung, wenn der Aufruf keine nennt. */
export const SPOT_STACK_TOLERANCE_BB = 5;

/** Ein Treffer der Spot-Suche. */
export interface SpotMatch {
  readonly chart: ChartSummary;
  /** 0 bis 1 — je höher, desto besser die Übereinstimmung. */
  readonly score: number;
  /** Was gepasst hat, im Klartext. */
  readonly matched: readonly string[];
  /** Was nicht gepasst hat — ebenso wichtig für die Auswahl. */
  readonly missed: readonly string[];
}

/**
 * Was der Bestand überhaupt hergibt.
 *
 * Steht in jeder Antwort, nicht nur in der leeren: Wer nach 200bb sucht und
 * erfährt, dass das Buch bis 100bb reicht, weiß sofort, woran es lag.
 */
export interface SpotCoverage {
  readonly stackDepthBb: { readonly min: number | null; readonly max: number | null };
  readonly heroPositions: readonly ChartPosition[];
  readonly villainPositions: readonly ChartPosition[];
  readonly formats: readonly ChartFormat[];
  readonly chartsSearched: number;
}

export interface SpotSearchResponse {
  readonly matches: readonly SpotMatch[];
  readonly query: {
    readonly heroPosition: ChartPosition | null;
    readonly villainPosition: ChartPosition | null;
    readonly stackDepthBb: number | null;
    readonly stackToleranceBb: number;
    readonly action: string | null;
    readonly format: ChartFormat | null;
  };
  readonly coverage: SpotCoverage;
  /**
   * Klartext-Begründung. Bei einer leeren Trefferliste steht hier, **warum**
   * nichts passte — eine leere Antwort ohne Erklärung ist eine Sackgasse.
   */
  readonly explanation: string;
}

/* -------------------------------------------------------------------------
 * Fehler
 * ---------------------------------------------------------------------- */

export const CONTENT_ERROR_CODES = ['invalid_request', 'not_found'] as const;
export type ContentErrorCode = (typeof CONTENT_ERROR_CODES)[number];

export interface ContentErrorResponse {
  readonly error: ContentErrorCode;
  readonly message: string;
  /** Was stattdessen erlaubt ist — spart eine Runde durch die Doku. */
  readonly allowed?: readonly string[];
}

export function isContentErrorResponse(value: unknown): value is ContentErrorResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (CONTENT_ERROR_CODES as readonly unknown[]).includes((value as { error?: unknown }).error) &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}
