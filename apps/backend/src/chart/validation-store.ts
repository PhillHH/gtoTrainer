import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { ALL_CHECKS } from '@gto/shared';
import type {
  ChartCheckOptions,
  ChartMatrix,
  ChartState,
  ChartValidationResult,
} from '@gto/shared';
import type { Database } from '../db/client.js';
import { bookAsset, chartFinding, rangeChart, rangeChartCell } from '../db/schema.js';
import { captionActionsToLegend } from './spot.js';
import { validateChart } from './validate.js';

/**
 * Validierung gegen den echten Bestand (AP3.T3.4).
 *
 * Deterministischer Code. Die Zustandsübergänge liegen hier an **einer**
 * Stelle, damit es keinen zweiten Weg nach `approved` gibt.
 */

/* -------------------------------------------------------------------------
 * Laden
 * ---------------------------------------------------------------------- */

export interface LoadedChart {
  readonly id: string;
  readonly assetId: string;
  readonly state: ChartState;
  readonly captionNumber: number | null;
  readonly captionRaw: string | null;
  readonly matrix: ChartMatrix;
  /** Caption-Prozente je Aktionsart - die unabhängige Gegenprobe aus T3.1. */
  readonly captionTotals: Record<string, number>;
  /**
   * Die im Bild gedruckte Legende - die zweite, unabhängige Gegenprobe
   * (AP3.T3.6-fix). Sie wird hier nur gelesen, nie berechnet.
   */
  readonly legendTotals: Record<string, number>;
  readonly legendPresent: boolean;
  /** Blätter, deren Werte ein Mensch korrigiert hat. */
  readonly manualHands: readonly string[];
}

/**
 * Liest die Caption-Prozente eines Assets als `{ aktionsart: prozent }`.
 *
 * Die Werte stammen unverändert aus T3.1. Sie werden hier nur auf die
 * geschlossene Aktionsmenge abgebildet — kein Modell hat sie je gesehen, und
 * genau das macht sie als Gegenprobe brauchbar.
 */
export function captionTotalsOf(
  captionActions: readonly { action: string; percent: number }[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const entry of captionActions) {
    const parsed = captionActionsToLegend([entry]).actions[0];
    if (parsed === undefined) continue;
    totals[parsed.kind] = (totals[parsed.kind] ?? 0) + entry.percent;
  }
  return totals;
}

/** Lädt ein Chart samt Matrix und Gegenprobe. */
export async function loadChart(db: Database, chartId: string): Promise<LoadedChart | undefined> {
  const [row] = await db
    .select({
      id: rangeChart.id,
      assetId: rangeChart.assetId,
      state: rangeChart.state,
      captionNumber: bookAsset.captionNumber,
      captionRaw: bookAsset.captionRaw,
      captionActions: bookAsset.captionActions,
      legendTotals: rangeChart.legendTotals,
      legendPresent: rangeChart.legendPresent,
    })
    .from(rangeChart)
    .innerJoin(bookAsset, eq(rangeChart.assetId, bookAsset.id))
    .where(eq(rangeChart.id, chartId));
  if (!row) return undefined;

  const cells = await db
    .select()
    .from(rangeChartCell)
    .where(eq(rangeChartCell.chartId, chartId))
    .orderBy(asc(rangeChartCell.hand));

  const byHand = new Map<string, { kind: string; sizing: string; percent: number }[]>();
  const manualHands = new Set<string>();
  for (const cell of cells) {
    const list = byHand.get(cell.hand) ?? [];
    list.push({ kind: cell.actionKind, sizing: cell.sizing, percent: cell.percent });
    byHand.set(cell.hand, list);
    if (cell.source === 'manual') manualHands.add(cell.hand);
  }

  const matrix: ChartMatrix = [...byHand.entries()].map(([hand, actions]) => ({
    hand,
    actions: actions.map((entry) => ({
      action: { kind: entry.kind as never, sizing: entry.sizing === '' ? null : entry.sizing },
      percent: entry.percent,
    })),
  }));

  return {
    id: row.id,
    assetId: row.assetId,
    state: row.state as ChartState,
    captionNumber: row.captionNumber,
    captionRaw: row.captionRaw,
    matrix,
    captionTotals: captionTotalsOf(
      Array.isArray(row.captionActions)
        ? (row.captionActions as { action: string; percent: number }[])
        : [],
    ),
    // Unveraendert aus der Datenbank - kein Ableiten, kein Ergaenzen.
    legendTotals:
      typeof row.legendTotals === 'object' && row.legendTotals !== null
        ? (row.legendTotals as Record<string, number>)
        : {},
    legendPresent: row.legendPresent,
    manualHands: [...manualHands],
  };
}

/* -------------------------------------------------------------------------
 * Validieren und Zustand setzen
 * ---------------------------------------------------------------------- */

export interface ValidationOutcome {
  readonly chartId: string;
  readonly captionNumber: number | null;
  readonly passed: boolean;
  readonly state: ChartState;
  readonly errors: number;
  readonly warnings: number;
  readonly result: ChartValidationResult;
}

/**
 * Validiert ein Chart und setzt den Zustand.
 *
 * Zustandsregeln, bewusst eng:
 *
 * - Nur `raw` und `validated` werden überhaupt geprüft. `approved`,
 *   `unusable` und `failed` bleiben unangetastet — eine Freigabe wird durch
 *   einen erneuten Lauf **nicht** zurückgenommen, und ein von Hand verworfenes
 *   Chart nicht wiederbelebt.
 * - Kein `error`-Befund → `validated`.
 * - Mindestens ein `error`-Befund → zurück auf `raw`.
 * - `approved` vergibt diese Funktion **nie**. Das ist ein eigener Schritt.
 */
export async function validateAndStore(
  db: Database,
  chartId: string,
  options: ChartCheckOptions = ALL_CHECKS,
): Promise<ValidationOutcome | undefined> {
  const chart = await loadChart(db, chartId);
  if (chart === undefined) return undefined;

  const result = validateChart(chart.matrix, chart.captionTotals, options, chart.legendTotals);
  const errors = result.findings.filter((entry) => entry.severity === 'error').length;
  const warnings = result.findings.filter((entry) => entry.severity === 'warning').length;

  await db.delete(chartFinding).where(eq(chartFinding.chartId, chartId));
  if (result.findings.length > 0) {
    await db.insert(chartFinding).values(
      result.findings.map((entry) => ({
        chartId,
        check: entry.check,
        kind: entry.kind,
        severity: entry.severity,
        hand: entry.hand,
        actionKind: entry.actionKind,
        measured: entry.measured,
        expected: entry.expected,
        detail: entry.detail,
      })),
    );
  }

  // Freigegebene, verworfene und technisch gescheiterte Charts behalten ihren
  // Zustand. Der Lauf schreibt fuer sie nur die Befunde fort.
  const frozen: ChartState[] = ['approved', 'unusable', 'failed'];
  const state: ChartState = frozen.includes(chart.state)
    ? chart.state
    : result.passed
      ? 'validated'
      : 'raw';

  await db
    .update(rangeChart)
    .set({ state, validatedAt: new Date(), updatedAt: new Date() })
    .where(eq(rangeChart.id, chartId));

  return {
    chartId,
    captionNumber: chart.captionNumber,
    passed: result.passed,
    state,
    errors,
    warnings,
    result,
  };
}

/** IDs der Charts, die eine Validierung braucht. */
export async function chartsToValidate(
  db: Database,
  options: { readonly includeApproved?: boolean; readonly limit?: number } = {},
): Promise<string[]> {
  const states =
    options.includeApproved === true ? ['raw', 'validated', 'approved'] : ['raw', 'validated'];
  const query = db
    .select({ id: rangeChart.id })
    .from(rangeChart)
    .where(inArray(rangeChart.state, states))
    .orderBy(asc(rangeChart.createdAt))
    .$dynamic();
  const rows = await (options.limit === undefined ? query : query.limit(options.limit));
  return rows.map((row) => row.id);
}

/** Charts mit mindestens einem Fehlerbefund - die Kandidaten des Zweitdurchlaufs. */
export async function chartsWithErrors(
  db: Database,
  limit?: number,
): Promise<{ chartId: string; assetId: string; hands: string[] }[]> {
  const rows = await db
    .select({
      chartId: rangeChart.id,
      assetId: rangeChart.assetId,
      hand: chartFinding.hand,
    })
    .from(chartFinding)
    .innerJoin(rangeChart, eq(chartFinding.chartId, rangeChart.id))
    .where(and(eq(chartFinding.severity, 'error'), eq(rangeChart.state, 'raw')))
    .orderBy(asc(rangeChart.createdAt));

  const byChart = new Map<string, { chartId: string; assetId: string; hands: Set<string> }>();
  for (const row of rows) {
    const entry = byChart.get(row.chartId) ?? {
      chartId: row.chartId,
      assetId: row.assetId,
      hands: new Set<string>(),
    };
    if (row.hand !== null) entry.hands.add(row.hand);
    byChart.set(row.chartId, entry);
  }

  const list = [...byChart.values()].map((entry) => ({
    chartId: entry.chartId,
    assetId: entry.assetId,
    hands: [...entry.hands],
  }));
  return limit === undefined ? list : list.slice(0, limit);
}

/* -------------------------------------------------------------------------
 * Freigabe
 * ---------------------------------------------------------------------- */

/** Grund, warum eine Freigabe abgelehnt wurde. */
export class ApprovalRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRefused';
  }
}

/**
 * Setzt ein Chart auf `approved`.
 *
 * **Nur aus `validated` heraus.** Ein Chart mit offenem Fehlerbefund lässt
 * sich nicht freigeben — auch nicht von Hand über die Review-Ansicht. Wer es
 * trotzdem will, korrigiert erst die beanstandeten Zellen; die Korrektur
 * startet die Prüfung neu, und erst wenn sie besteht, ist die Freigabe
 * möglich. Das ist die Stelle, an der Risiko R2 tatsächlich abgefangen wird.
 */
export async function approveChart(db: Database, chartId: string): Promise<void> {
  const [chart] = await db.select().from(rangeChart).where(eq(rangeChart.id, chartId));
  if (!chart) throw new ApprovalRefused(`Chart ${chartId} existiert nicht.`);
  if (chart.state === 'approved') return;

  if (chart.state !== 'validated') {
    const [{ errors = 0 } = {}] = await db
      .select({ errors: sql<number>`count(*)::int` })
      .from(chartFinding)
      .where(and(eq(chartFinding.chartId, chartId), eq(chartFinding.severity, 'error')));
    throw new ApprovalRefused(
      `Chart im Zustand "${chart.state}" kann nicht freigegeben werden: ` +
        `${errors} offene Fehlerbefunde. Erst korrigieren, dann prüfen, dann freigeben.`,
    );
  }

  await db
    .update(rangeChart)
    .set({ state: 'approved', approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(rangeChart.id, chartId));
}

/** Gibt alle `validated` Charts frei. */
export async function approveAllValidated(db: Database): Promise<number> {
  const rows = await db
    .update(rangeChart)
    .set({ state: 'approved', approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(rangeChart.state, 'validated'))
    .returning({ id: rangeChart.id });
  return rows.length;
}

/** Verwirft ein Chart mit Begründung - der dokumentierte Rest der DoD. */
export async function markUnusable(db: Database, chartId: string, reason: string): Promise<void> {
  if (reason.trim() === '') {
    throw new ApprovalRefused('Eine Begründung ist Pflicht - der Rest muss dokumentiert sein.');
  }
  await db
    .update(rangeChart)
    .set({ state: 'unusable', unusableReason: reason.trim(), updatedAt: new Date() })
    .where(eq(rangeChart.id, chartId));
}

/* -------------------------------------------------------------------------
 * Manuelle Korrektur
 * ---------------------------------------------------------------------- */

/**
 * Ersetzt die Aktionen einzelner Zellen durch von Hand gesetzte Werte.
 *
 * Die Zellen werden als `manual` gekennzeichnet und mit Zeitpunkt versehen.
 * Ab dann sind sie vor jedem automatischen Schreibvorgang geschützt.
 */
export async function correctCells(
  db: Database,
  chartId: string,
  cells: readonly {
    hand: string;
    actions: readonly { kind: string; sizing?: string | null; percent: number }[];
  }[],
): Promise<number> {
  const now = new Date();
  let changed = 0;

  for (const cell of cells) {
    await db
      .delete(rangeChartCell)
      .where(and(eq(rangeChartCell.chartId, chartId), eq(rangeChartCell.hand, cell.hand)));

    if (cell.actions.length === 0) continue;
    const unique = new Map(
      cell.actions.map((entry) => [
        `${entry.kind}|${entry.sizing ?? ''}`,
        {
          chartId,
          hand: cell.hand,
          actionKind: entry.kind,
          sizing: entry.sizing ?? '',
          percent: entry.percent,
          source: 'manual' as const,
          correctedAt: now,
        },
      ]),
    );
    await db.insert(rangeChartCell).values([...unique.values()]);
    changed += 1;
  }

  return changed;
}

/** Zaehlt die von Hand korrigierten Zellen eines Charts. */
export async function manualCellCount(db: Database, chartId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${rangeChartCell.hand})::int` })
    .from(rangeChartCell)
    .where(and(eq(rangeChartCell.chartId, chartId), eq(rangeChartCell.source, 'manual')));
  return row?.n ?? 0;
}

/* -------------------------------------------------------------------------
 * Zaehlstaende
 * ---------------------------------------------------------------------- */

export interface ValidationProgress {
  readonly handRangeAssets: number;
  /** Charts mit gedruckter Legende - Abdeckung der vierten Prüfung. */
  readonly chartsWithLegend: number;
  /** Charts mit verwertbaren Caption-Prozenten - Abdeckung der zweiten. */
  readonly chartsWithCaptionPercents: number;
  readonly digitized: number;
  readonly byState: Record<string, number>;
  readonly findingsByCheck: Record<string, number>;
  readonly findingsBySeverity: Record<string, number>;
  readonly approvedShare: number;
}

export async function validationProgress(db: Database): Promise<ValidationProgress> {
  const [assets] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookAsset)
    .where(
      and(
        eq(bookAsset.assetType, 'hand_range'),
        eq(bookAsset.classificationConfidence, 'certain'),
        isNull(bookAsset.removedAt),
      ),
    );

  const states = await db
    .select({ state: rangeChart.state, n: sql<number>`count(*)::int` })
    .from(rangeChart)
    .groupBy(rangeChart.state);

  const byCheck = await db
    .select({ check: chartFinding.check, n: sql<number>`count(*)::int` })
    .from(chartFinding)
    .where(ne(chartFinding.severity, 'info'))
    .groupBy(chartFinding.check);

  const bySeverity = await db
    .select({ severity: chartFinding.severity, n: sql<number>`count(*)::int` })
    .from(chartFinding)
    .groupBy(chartFinding.severity);

  // Wie viele Charts tragen ueberhaupt eine gedruckte Legende? Das ist die
  // Abdeckung der vierten Pruefung - und die Zahl, an der sich zeigt, ob sie
  // ihren Zweck erfuellt (AP3.T3.6-fix).
  const [withLegend] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rangeChart)
    .where(eq(rangeChart.legendPresent, true));

  const [withCaption] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rangeChart)
    .innerJoin(bookAsset, eq(bookAsset.id, rangeChart.assetId))
    .where(sql`jsonb_array_length(${bookAsset.captionActions}) > 0`);

  const byState = Object.fromEntries(states.map((row) => [row.state, row.n]));
  const total = assets?.n ?? 0;

  return {
    handRangeAssets: total,
    chartsWithLegend: withLegend?.n ?? 0,
    chartsWithCaptionPercents: withCaption?.n ?? 0,
    digitized: states.reduce((sum, row) => sum + row.n, 0),
    byState,
    findingsByCheck: Object.fromEntries(byCheck.map((row) => [row.check, row.n])),
    findingsBySeverity: Object.fromEntries(bySeverity.map((row) => [row.severity, row.n])),
    approvedShare: total === 0 ? 0 : (byState['approved'] ?? 0) / total,
  };
}

/**
 * Charts, denen die gedruckte Legende noch fehlt (AP3.T3.6-fix).
 *
 * Das sind die Datensätze aus der Zeit vor Fassung 2 des
 * Digitalisierungs-Templates. Charts ohne Matrix (`failed`) bleiben außen vor —
 * für ein Bild ohne Aktionsraster gibt es nichts abzugleichen.
 */
export async function chartsWithoutLegend(db: Database, limit?: number): Promise<string[]> {
  const query = db
    .select({ id: rangeChart.id })
    .from(rangeChart)
    .where(and(eq(rangeChart.legendPresent, false), ne(rangeChart.state, 'failed')))
    .orderBy(asc(rangeChart.createdAt))
    .$dynamic();
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map((row) => row.id);
}
