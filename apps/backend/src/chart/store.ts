import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { CHART_HAND_COUNT, chartActionKey, validateChartMatrix } from '@gto/shared';
import type { ChartAction, ChartMatrix, ChartSpot, ChartState } from '@gto/shared';
import type { Database } from '../db/client.js';
import { bookAsset, bookChapter, bookSection, rangeChart, rangeChartCell } from '../db/schema.js';
import { resolveBookSource } from '../book/source.js';

/**
 * Datenzugriffe der Chart-Digitalisierung (AP3.T3.3).
 *
 * Alles hier ist deterministischer Code; der einzige KI-Anteil steckt im
 * Job-Handler.
 */

/* -------------------------------------------------------------------------
 * Auswahl der zu verarbeitenden Charts
 * ---------------------------------------------------------------------- */

export interface ChartCandidate {
  readonly assetId: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly captionRaw: string | null;
  readonly captionNumber: number | null;
  readonly captionSpot: string | null;
  readonly captionActions: readonly { action: string; percent: number }[];
  readonly chapterNumber: number | null;
  readonly ordinal: number;
}

export interface CandidateFilter {
  /** Nur ein bestimmtes Kapitel. */
  readonly chapterNumber?: number;
  /** Nur diese Assets (UUIDs). */
  readonly assetIds?: readonly string[];
  /** Hoechstzahl - fuer Chargen. */
  readonly limit?: number;
  /**
   * Bereits digitalisierte Charts einschliessen. Standard `false` - genau das
   * ist die Wiederaufnahme: Ein zweiter Lauf ruft nichts noch einmal auf.
   */
  readonly includeDone?: boolean;
}

/**
 * Liefert die zu verarbeitenden Charts.
 *
 * **Nur `hand_range`.** Assets anderer Typen werden gar nicht erst geladen;
 * unsicher klassifizierte (`classification_confidence = 'uncertain'`) sind
 * ausgenommen und werden getrennt gezaehlt - sie laufen nicht stillschweigend
 * mit, sondern erscheinen im Bericht.
 */
export async function selectCandidates(
  db: Database,
  filter: CandidateFilter = {},
): Promise<ChartCandidate[]> {
  const conditions = [
    eq(bookAsset.assetType, 'hand_range'),
    eq(bookAsset.classificationConfidence, 'certain'),
    eq(bookAsset.filePresent, true),
    isNull(bookAsset.removedAt),
  ];

  if (filter.chapterNumber !== undefined) {
    conditions.push(eq(bookChapter.chapterNumber, filter.chapterNumber));
  }
  if (filter.assetIds !== undefined) {
    if (filter.assetIds.length === 0) return [];
    conditions.push(inArray(bookAsset.id, [...filter.assetIds]));
  }
  if (filter.includeDone !== true) {
    // Wiederaufnahme: Was schon einen Chart-Datensatz hat, wird uebersprungen.
    // Ein durch ein Wochenlimit gestoppter Lauf setzt damit genau dort fort,
    // wo er aufhoerte, ohne Kontingent fuer Erledigtes zu verbrennen.
    conditions.push(
      sql`not exists (select 1 from ${rangeChart} where ${rangeChart.assetId} = ${bookAsset.id})`,
    );
  }

  const query = db
    .select({
      assetId: bookAsset.id,
      relativePath: bookAsset.relativePath,
      fileName: bookAsset.fileName,
      captionRaw: bookAsset.captionRaw,
      captionNumber: bookAsset.captionNumber,
      captionSpot: bookAsset.captionSpot,
      captionActions: bookAsset.captionActions,
      chapterNumber: bookChapter.chapterNumber,
      ordinal: bookAsset.ordinal,
    })
    .from(bookAsset)
    .leftJoin(bookSection, eq(bookAsset.sectionId, bookSection.id))
    .leftJoin(bookChapter, eq(bookSection.chapterId, bookChapter.id))
    .where(and(...conditions))
    .orderBy(asc(bookAsset.ordinal))
    .$dynamic();

  const rows = await (filter.limit === undefined ? query : query.limit(filter.limit));

  return rows.map((row) => ({
    assetId: row.assetId,
    relativePath: row.relativePath,
    fileName: row.fileName,
    captionRaw: row.captionRaw,
    captionNumber: row.captionNumber,
    captionSpot: row.captionSpot,
    captionActions: Array.isArray(row.captionActions)
      ? (row.captionActions as { action: string; percent: number }[])
      : [],
    chapterNumber: row.chapterNumber,
    ordinal: row.ordinal,
  }));
}

/** Assets, die als `hand_range` gelten, aber unsicher klassifiziert sind. */
export async function uncertainHandRangeAssets(
  db: Database,
): Promise<{ id: string; relativePath: string }[]> {
  return db
    .select({ id: bookAsset.id, relativePath: bookAsset.relativePath })
    .from(bookAsset)
    .where(
      and(
        eq(bookAsset.assetType, 'hand_range'),
        eq(bookAsset.classificationConfidence, 'uncertain'),
        isNull(bookAsset.removedAt),
      ),
    )
    .orderBy(asc(bookAsset.ordinal));
}

/** Ein einzelnes Asset laden - fuer den Job-Handler. */
export async function loadCandidate(
  db: Database,
  assetId: string,
): Promise<ChartCandidate | undefined> {
  const [row] = await selectCandidates(db, { assetIds: [assetId], includeDone: true });
  return row;
}

/* -------------------------------------------------------------------------
 * Bild laden
 * ---------------------------------------------------------------------- */

/** Zulaessige Bildendungen und ihr Medientyp. */
const MEDIA_TYPES: Readonly<Record<string, 'image/jpeg' | 'image/png'>> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
};

/**
 * Liest ein Chart-Bild als Base64.
 *
 * Die Buchquellen werden ausschliesslich gelesen - hier wie in T3.1.
 */
export function readChartImage(
  relativePath: string,
  sourceDir?: string,
): { mediaType: 'image/jpeg' | 'image/png'; data: string } {
  const source = resolveBookSource(sourceDir);
  const extension = relativePath.split('.').pop()?.toLowerCase() ?? '';
  const mediaType = MEDIA_TYPES[extension];
  if (mediaType === undefined) {
    throw new Error(`Unbekannter Bildtyp "${extension}" fuer ${relativePath}.`);
  }
  return { mediaType, data: readFileSync(join(source.rootDir, relativePath)).toString('base64') };
}

/* -------------------------------------------------------------------------
 * Persistenz
 * ---------------------------------------------------------------------- */

export interface PersistChartInput {
  readonly assetId: string;
  readonly model: string;
  readonly runId: string;
  readonly spot: ChartSpot;
  readonly actions: readonly ChartAction[];
  readonly matrix: ChartMatrix;
  readonly uncertain: readonly string[];
  readonly durationMs?: number;
  readonly promptTokens?: number | null;
  readonly completionTokens?: number | null;
  readonly totalTokens?: number | null;
  /** Gesetzt, wenn die Digitalisierung unbrauchbar war. */
  readonly failureReason?: string;
}

/**
 * Schreibt ein Chart samt Zellen.
 *
 * Der Zustand ist **immer `raw`** (oder `failed`) - die Freigabe haengt an der
 * Validierung aus T3.4. Ein bereits vorhandener Datensatz wird ersetzt, damit
 * ein gezielter zweiter Durchlauf nicht an der Eindeutigkeit scheitert.
 */
export async function persistChart(db: Database, input: PersistChartInput): Promise<string> {
  const state: ChartState = input.failureReason === undefined ? 'raw' : 'failed';

  const values = {
    assetId: input.assetId,
    state,
    model: input.model,
    runId: input.runId,
    actions: input.actions,
    spot: input.spot,
    uncertain: input.uncertain,
    cellCount: input.matrix.length,
    failureReason: input.failureReason ?? null,
    durationMs: input.durationMs ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(rangeChart)
    .values(values)
    .onConflictDoUpdate({ target: rangeChart.assetId, set: values })
    .returning({ id: rangeChart.id });
  const chartId = (row as { id: string }).id;

  await db.delete(rangeChartCell).where(eq(rangeChartCell.chartId, chartId));

  const cells = input.matrix.flatMap((cell) =>
    cell.actions.map((entry) => ({
      chartId,
      hand: cell.hand,
      actionKind: entry.action.kind,
      sizing: entry.action.sizing ?? '',
      percent: entry.percent,
    })),
  );

  // Doppelte (Blatt, Aktion) waeren ein Primaerschluesselkonflikt; das Modell
  // liefert das gelegentlich. Der letzte Wert gewinnt, gezaehlt wird einmal.
  const unique = new Map(
    cells.map((cell) => [`${cell.hand}|${cell.actionKind}|${cell.sizing}`, cell]),
  );

  const batch = [...unique.values()];
  for (let index = 0; index < batch.length; index += 500) {
    await db.insert(rangeChartCell).values(batch.slice(index, index + 500));
  }

  return chartId;
}

/** Legende aus einer Matrix ableiten - alle vorkommenden Aktionen. */
export function legendOf(matrix: ChartMatrix): ChartAction[] {
  const seen = new Map<string, ChartAction>();
  for (const cell of matrix) {
    for (const entry of cell.actions) {
      seen.set(chartActionKey(entry.action), entry.action);
    }
  }
  return [...seen.values()];
}

/** Strukturprüfung der Matrix - dieselbe wie im Vertrag. */
export function matrixIssues(matrix: ChartMatrix): string[] {
  return validateChartMatrix(matrix).map((issue) => issue.message);
}

/** Ist die Matrix vollstaendig (169 Zellen, keine Verstoesse)? */
export function isComplete(matrix: ChartMatrix): boolean {
  return matrix.length === CHART_HAND_COUNT && validateChartMatrix(matrix).length === 0;
}

/* -------------------------------------------------------------------------
 * Fortschritt
 * ---------------------------------------------------------------------- */

export interface ChartProgress {
  readonly handRangeTotal: number;
  readonly uncertainSkipped: number;
  readonly byState: Record<string, number>;
  readonly remaining: number;
  readonly complete: number;
  readonly incomplete: number;
  /** Bilder ohne Aktionsraster - kein Modellfehler, sondern kein Chart. */
  readonly noGrid: number;
  readonly byModel: Record<string, number>;
}

/** Zaehlstaende fuer den Bericht und das CLI. */
export async function chartProgress(db: Database): Promise<ChartProgress> {
  const [totals] = await db
    .select({
      total: sql<number>`count(*) filter (where ${bookAsset.classificationConfidence} = 'certain')::int`,
      uncertain: sql<number>`count(*) filter (where ${bookAsset.classificationConfidence} = 'uncertain')::int`,
    })
    .from(bookAsset)
    .where(and(eq(bookAsset.assetType, 'hand_range'), isNull(bookAsset.removedAt)));

  const states = await db
    .select({ state: rangeChart.state, n: sql<number>`count(*)::int` })
    .from(rangeChart)
    .groupBy(rangeChart.state);

  const models = await db
    .select({ model: rangeChart.model, n: sql<number>`count(*)::int` })
    .from(rangeChart)
    .groupBy(rangeChart.model);

  const [completeness] = await db
    .select({
      complete: sql<number>`count(*) filter (where ${rangeChart.cellCount} = ${CHART_HAND_COUNT})::int`,
      incomplete: sql<number>`count(*) filter (where ${rangeChart.cellCount} <> ${CHART_HAND_COUNT} and ${rangeChart.cellCount} > 0)::int`,
      noGrid: sql<number>`count(*) filter (where ${rangeChart.cellCount} = 0)::int`,
    })
    .from(rangeChart);

  const done = states.reduce((sum, row) => sum + row.n, 0);

  return {
    handRangeTotal: totals?.total ?? 0,
    uncertainSkipped: totals?.uncertain ?? 0,
    byState: Object.fromEntries(states.map((row) => [row.state, row.n])),
    remaining: Math.max(0, (totals?.total ?? 0) - done),
    complete: completeness?.complete ?? 0,
    incomplete: completeness?.incomplete ?? 0,
    noGrid: completeness?.noGrid ?? 0,
    byModel: Object.fromEntries(models.map((row) => [row.model, row.n])),
  };
}
