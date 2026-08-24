import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { CHART_HANDS, EMPTY_CHART_SPOT } from '@gto/shared';
import type {
  CellResponse,
  ChartAction,
  ChartDetail,
  ChartListResponse,
  ChartSpot,
  ChartState,
  ChartSummary,
  ContentCell,
} from '@gto/shared';
import type { ChartCellSource } from '@gto/shared';
import type { Database } from '../db/client.js';
import {
  bookAsset,
  bookChapter,
  bookSection,
  concept,
  conceptChart,
  rangeChart,
  rangeChartCell,
} from '../db/schema.js';
import { captionTotalsOf } from '../chart/validation-store.js';
import { weightedTotals } from '../chart/validate.js';
import { assetImageUrl } from './urls.js';
import { isUuid } from './book-queries.js';

/**
 * Lesepfade auf die Charts (AP3.T3.5).
 *
 * > **Die Regel, die dieser Datei ihre Form gibt:** Ohne den ausdrücklichen
 * > Parameter `includeUnapproved` kommen **ausschließlich `approved` Charts**
 * > heraus. Der Parameter existiert für die Review-Ansicht aus T3.4 und für
 * > nichts sonst. Ein Folge-AP, der ihn nicht setzt, kann gar nicht
 * > versehentlich auf ungeprüfte Frequenzen zugreifen.
 *
 * Die Regel steht an **einer** Stelle: `stateCondition()`. Jeder Lesepfad
 * dieser Datei geht durch sie hindurch.
 */

export interface ChartFilter {
  readonly chapter?: number | undefined;
  /** Slug oder ID eines Konzepts. */
  readonly concept?: string | undefined;
  /**
   * **Nur für die Review-Ansicht (T3.4).** Öffnet die Antwort für Charts, die
   * kein Mensch freigegeben hat.
   */
  readonly includeUnapproved?: boolean | undefined;
}

/** Die Approved-Regel, an genau einer Stelle. */
function stateCondition(includeUnapproved: boolean) {
  return includeUnapproved ? sql`true` : eq(rangeChart.state, 'approved');
}

/** Die gemeinsame Auswahl der Listen- und Detailform - **ohne** Matrix. */
function summarySelection() {
  return {
    id: rangeChart.id,
    assetId: rangeChart.assetId,
    state: rangeChart.state,
    model: rangeChart.model,
    spot: rangeChart.spot,
    actions: rangeChart.actions,
    cellCount: rangeChart.cellCount,
    uncertain: rangeChart.uncertain,
    approvedAt: rangeChart.approvedAt,
    captionRaw: bookAsset.captionRaw,
    captionNumber: bookAsset.captionNumber,
    captionActions: bookAsset.captionActions,
    chapterNumber: bookChapter.chapterNumber,
    sectionKey: bookSection.sectionKey,
    // Voll qualifiziert - siehe die Anmerkung in `book-queries.ts`.
    manualCells: sql<number>`(
      select count(distinct rcc.hand)::int from range_chart_cell rcc
      where rcc.chart_id = range_chart.id and rcc.source = 'manual'
    )`,
  };
}

type SummaryRow = Awaited<ReturnType<typeof selectSummaries>>[number];

function selectSummaries(db: Database) {
  return db
    .select(summarySelection())
    .from(rangeChart)
    .innerJoin(bookAsset, eq(rangeChart.assetId, bookAsset.id))
    .leftJoin(bookSection, eq(bookAsset.sectionId, bookSection.id))
    .leftJoin(bookChapter, eq(bookSection.chapterId, bookChapter.id));
}

function toSummary(row: SummaryRow): ChartSummary {
  return {
    id: row.id,
    assetId: row.assetId,
    captionNumber: row.captionNumber,
    captionRaw: row.captionRaw,
    state: row.state as ChartState,
    spot: { ...EMPTY_CHART_SPOT, ...((row.spot ?? {}) as Partial<ChartSpot>) },
    actions: (Array.isArray(row.actions) ? row.actions : []) as ChartAction[],
    cellCount: row.cellCount,
    model: row.model,
    manualCells: row.manualCells,
    chapterNumber: row.chapterNumber,
    sectionKey: row.sectionKey,
    imageUrl: assetImageUrl(row.assetId),
  };
}

/** Chartliste — **ohne** Matrix. Eine Übersicht mit 30 Matrizen wäre unlesbar. */
export async function listCharts(
  db: Database,
  filter: ChartFilter = {},
): Promise<ChartListResponse> {
  const includeUnapproved = filter.includeUnapproved === true;
  const conditions = [stateCondition(includeUnapproved)];

  if (filter.chapter !== undefined) conditions.push(eq(bookChapter.chapterNumber, filter.chapter));

  if (filter.concept !== undefined) {
    const [row] = await db
      .select({ id: concept.id })
      .from(concept)
      .where(
        isUuid(filter.concept) ? eq(concept.id, filter.concept) : eq(concept.slug, filter.concept),
      );
    if (!row) {
      return {
        charts: [],
        totals: { matched: 0, approved: await countApproved(db) },
        filters: {
          chapter: filter.chapter ?? null,
          concept: filter.concept,
          includeUnapproved,
        },
      };
    }
    const assets = await db
      .select({ assetId: conceptChart.assetId })
      .from(conceptChart)
      .where(eq(conceptChart.conceptId, row.id));
    if (assets.length === 0) {
      return {
        charts: [],
        totals: { matched: 0, approved: await countApproved(db) },
        filters: { chapter: filter.chapter ?? null, concept: filter.concept, includeUnapproved },
      };
    }
    conditions.push(
      inArray(
        rangeChart.assetId,
        assets.map((entry) => entry.assetId),
      ),
    );
  }

  const rows = await selectSummaries(db)
    .where(and(...conditions))
    .orderBy(asc(bookAsset.captionNumber), asc(bookAsset.ordinal));

  return {
    charts: rows.map(toSummary),
    totals: { matched: rows.length, approved: await countApproved(db) },
    filters: {
      chapter: filter.chapter ?? null,
      concept: filter.concept ?? null,
      includeUnapproved,
    },
  };
}

async function countApproved(db: Database): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rangeChart)
    .where(eq(rangeChart.state, 'approved'));
  return row?.n ?? 0;
}

/** Alle freigegebenen Charts als Rohform — Grundlage der Spot-Suche. */
export async function approvedSummaries(
  db: Database,
  includeUnapproved = false,
): Promise<ChartSummary[]> {
  const rows = await selectSummaries(db)
    .where(stateCondition(includeUnapproved))
    .orderBy(asc(bookAsset.captionNumber));
  return rows.map(toSummary);
}

/** Chartdetail mit vollständiger 13×13-Matrix. */
export async function getChart(
  db: Database,
  chartId: string,
  includeUnapproved = false,
): Promise<ChartDetail | undefined> {
  if (!isUuid(chartId)) return undefined;

  const [row] = await selectSummaries(db).where(
    and(eq(rangeChart.id, chartId), stateCondition(includeUnapproved)),
  );
  if (!row) return undefined;

  const cells = await db
    .select({
      hand: rangeChartCell.hand,
      actionKind: rangeChartCell.actionKind,
      sizing: rangeChartCell.sizing,
      percent: rangeChartCell.percent,
      source: rangeChartCell.source,
    })
    .from(rangeChartCell)
    .where(eq(rangeChartCell.chartId, chartId));

  const byHand = new Map<string, ContentCell>();
  for (const cell of cells) {
    const existing = byHand.get(cell.hand);
    const action = {
      kind: cell.actionKind,
      sizing: cell.sizing === '' ? null : cell.sizing,
      percent: cell.percent,
    };
    if (existing === undefined) {
      byHand.set(cell.hand, {
        hand: cell.hand,
        actions: [action],
        source: cell.source as ChartCellSource,
      });
      continue;
    }
    byHand.set(cell.hand, {
      hand: cell.hand,
      actions: [...existing.actions, action],
      // Eine Zelle gilt als korrigiert, sobald eine ihrer Aktionen es ist.
      source: cell.source === 'manual' ? 'manual' : existing.source,
    });
  }

  // Rasterreihenfolge, nicht Datenbankreihenfolge: Ein Renderer soll die
  // Antwort ohne Umsortieren zeichnen koennen.
  const matrix = CHART_HANDS.map(
    (hand): ContentCell => byHand.get(hand) ?? { hand, actions: [], source: 'model' },
  ).filter((cell) => byHand.has(cell.hand));

  const summary = toSummary(row);
  const captionActions = Array.isArray(row.captionActions)
    ? (row.captionActions as { action: string; percent: number }[])
    : [];

  return {
    ...summary,
    matrix,
    uncertain: (Array.isArray(row.uncertain) ? row.uncertain : []) as string[],
    weightedTotals: weightedTotals(
      matrix.map((cell) => ({
        hand: cell.hand,
        actions: cell.actions.map((action) => ({
          action: { kind: action.kind as never, sizing: action.sizing },
          percent: action.percent,
        })),
      })),
    ),
    captionTotals: captionTotalsOf(captionActions),
    approvedAt: row.approvedAt === null ? null : row.approvedAt.toISOString(),
  };
}

/**
 * Gezielter Zellabruf: „Welche Aktion hat Hand X in Chart Y?"
 *
 * Der Baustein für objektiv prüfbare Fragen in AP5 und AP7. Die Antwort kommt
 * deterministisch aus den gespeicherten Zahlen — hier wird nichts gerechnet,
 * geschätzt oder interpretiert. Und sie lädt nicht die ganze Matrix: eine
 * Zeile statt 169.
 */
export async function getCell(
  db: Database,
  chartId: string,
  hand: string,
  includeUnapproved = false,
): Promise<CellResponse | undefined> {
  if (!isUuid(chartId)) return undefined;

  const [chart] = await db
    .select({
      id: rangeChart.id,
      state: rangeChart.state,
      spot: rangeChart.spot,
    })
    .from(rangeChart)
    .where(and(eq(rangeChart.id, chartId), stateCondition(includeUnapproved)));
  if (!chart) return undefined;

  const cells = await db
    .select({
      actionKind: rangeChartCell.actionKind,
      sizing: rangeChartCell.sizing,
      percent: rangeChartCell.percent,
      source: rangeChartCell.source,
      correctedAt: rangeChartCell.correctedAt,
    })
    .from(rangeChartCell)
    .where(and(eq(rangeChartCell.chartId, chartId), eq(rangeChartCell.hand, hand)))
    .orderBy(asc(rangeChartCell.actionKind));
  if (cells.length === 0) return undefined;

  const corrected = cells.find((cell) => cell.correctedAt !== null)?.correctedAt ?? null;

  return {
    chartId,
    hand,
    actions: cells.map((cell) => ({
      kind: cell.actionKind,
      sizing: cell.sizing === '' ? null : cell.sizing,
      percent: cell.percent,
    })),
    source: cells.some((cell) => cell.source === 'manual') ? 'manual' : 'model',
    correctedAt: corrected === null ? null : corrected.toISOString(),
    spot: { ...EMPTY_CHART_SPOT, ...((chart.spot ?? {}) as Partial<ChartSpot>) },
    state: chart.state as ChartState,
  };
}
