import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CHART_ACTION_KINDS, isChartActionKind } from '@gto/shared';
import type {
  ChartApproveResponse,
  ChartCellUpdateRequest,
  ChartErrorResponse,
  ChartFinding,
  ChartUnusableRequest,
  ReviewCell,
  ReviewChartDetail,
  ReviewChartSummary,
  ReviewListResponse,
} from '@gto/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { sendAuthError } from '../auth/plugin.js';
import type { Database } from '../db/client.js';
import { bookAsset, chartFinding, chartRecheck, rangeChart, rangeChartCell } from '../db/schema.js';
import { resolveBookSource } from '../book/source.js';
import { weightedTotals } from './validate.js';
import {
  ApprovalRefused,
  approveAllValidated,
  approveChart,
  captionTotalsOf,
  correctCells,
  loadChart,
  markUnusable,
  validateAndStore,
  validationProgress,
} from './validation-store.js';

/**
 * Review-Ansicht der Chart-Validierung (AP3.T3.4, Subtask 6).
 *
 * **Abgrenzung zu T3.5:** Das hier ist die Prüfoberfläche — Liste, Bild neben
 * Matrix, Korrektur, Freigabe. Die Content-API für Folge-APs (gezielter Abruf,
 * Spot-Suche, öffentliches Asset-Serving mit Caching-Headern) entsteht in T3.5
 * unter `/api/content` und ist hier bewusst **nicht** vorweggenommen. Das
 * Bild-Endpunkt hier liefert ausschließlich an den angemeldeten Prüfer und
 * setzt bewusst `no-store`.
 */

export interface ChartReviewRoutesOptions {
  readonly db: Database;
  /** Abweichendes Quellverzeichnis der Bilder - nur für Tests. */
  readonly sourceDir?: string;
}

export function registerChartReviewRoutes(
  app: FastifyInstance,
  options: ChartReviewRoutesOptions,
): void {
  const { db } = options;

  /** `GET /api/charts` - Liste mit Zuständen und Befundzahlen. */
  app.get('/api/charts', { preHandler: app.requireSession }, async (_request, reply) => {
    return reply.send(await buildList(db));
  });

  /** `GET /api/charts/:id` - alles, was die Korrektur braucht. */
  app.get<{ Params: { id: string } }>(
    '/api/charts/:id',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const detail = await buildDetail(db, request.params.id);
      if (detail === undefined) {
        return sendAuthError(reply, 404, 'invalid_request', 'Chart nicht gefunden.');
      }
      return reply.send(detail);
    },
  );

  /**
   * `GET /api/charts/:id/image` - das Original-Chart-Bild.
   *
   * Nur für den angemeldeten Prüfer. Buchinhalte bleiben auf dem Server:
   * `no-store` verhindert, dass ein Zwischenspeicher das Bild vorhält.
   */
  app.get<{ Params: { id: string } }>(
    '/api/charts/:id/image',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const [row] = await db
        .select({ path: bookAsset.relativePath })
        .from(rangeChart)
        .innerJoin(bookAsset, eq(rangeChart.assetId, bookAsset.id))
        .where(eq(rangeChart.id, request.params.id));
      if (!row) return sendAuthError(reply, 404, 'invalid_request', 'Chart nicht gefunden.');

      try {
        const source = resolveBookSource(options.sourceDir);
        const data = readFileSync(join(source.rootDir, row.path));
        const type = row.path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        return reply.header('content-type', type).header('cache-control', 'no-store').send(data);
      } catch {
        return sendAuthError(reply, 404, 'invalid_request', 'Bilddatei nicht lesbar.');
      }
    },
  );

  /** `PATCH /api/charts/:id/cells` - manuelle Korrektur einzelner Zellen. */
  app.patch<{ Params: { id: string }; Body: ChartCellUpdateRequest }>(
    '/api/charts/:id/cells',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const chart = await loadChart(db, request.params.id);
      if (chart === undefined) {
        return sendAuthError(reply, 404, 'invalid_request', 'Chart nicht gefunden.');
      }

      const cells = request.body?.cells;
      const fields: { field: string; message: string }[] = [];
      if (!Array.isArray(cells) || cells.length === 0) {
        fields.push({ field: 'cells', message: 'Erwartet wird eine nichtleere Liste von Zellen.' });
      } else {
        for (const cell of cells) {
          if (typeof cell?.hand !== 'string') {
            fields.push({ field: 'cells', message: 'Jede Zelle braucht ein Blatt.' });
            continue;
          }
          for (const action of cell.actions ?? []) {
            if (!isChartActionKind(action?.kind)) {
              fields.push({
                field: 'cells',
                message: `Zelle ${cell.hand}: unbekannte Aktionsart "${String(action?.kind)}". Erlaubt: ${CHART_ACTION_KINDS.join(', ')}.`,
              });
            }
            if (typeof action?.percent !== 'number' || action.percent < 0 || action.percent > 100) {
              fields.push({
                field: 'cells',
                message: `Zelle ${cell.hand}: Frequenz ${String(action?.percent)} liegt außerhalb 0-100.`,
              });
            }
          }
        }
      }

      if (fields.length > 0) {
        const body: ChartErrorResponse = {
          error: 'invalid_chart',
          message: 'Die Korrektur wurde abgelehnt.',
          fields,
        };
        return reply.code(400).send(body);
      }

      await correctCells(db, request.params.id, cells as never);
      // Die Korrektur startet die Pruefung neu - sonst bliebe der Befund
      // stehen, obwohl er behoben ist.
      await validateAndStore(db, request.params.id);

      const detail = await buildDetail(db, request.params.id);
      return reply.send(detail);
    },
  );

  /** `POST /api/charts/:id/validate` - Prüfung eines Charts erneut fahren. */
  app.post<{ Params: { id: string } }>(
    '/api/charts/:id/validate',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const outcome = await validateAndStore(db, request.params.id);
      if (outcome === undefined) {
        return sendAuthError(reply, 404, 'invalid_request', 'Chart nicht gefunden.');
      }
      return reply.send(await buildDetail(db, request.params.id));
    },
  );

  /** `POST /api/charts/:id/approve` - Freigabe eines einzelnen Charts. */
  app.post<{ Params: { id: string } }>(
    '/api/charts/:id/approve',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      try {
        await approveChart(db, request.params.id);
      } catch (error) {
        if (!(error instanceof ApprovalRefused)) throw error;
        const body: ChartErrorResponse = {
          error: 'invalid_chart',
          message: error.message,
          fields: [{ field: 'state', message: error.message }],
        };
        return reply.code(400).send(body);
      }
      const response: ChartApproveResponse = { approved: 1 };
      return reply.send(response);
    },
  );

  /** `POST /api/charts/approve-validated` - Sammelfreigabe. */
  app.post(
    '/api/charts/approve-validated',
    { preHandler: app.requireSession },
    async (_request, reply: FastifyReply) => {
      const response: ChartApproveResponse = { approved: await approveAllValidated(db) };
      return reply.send(response);
    },
  );

  /** `POST /api/charts/:id/unusable` - Chart mit Begründung verwerfen. */
  app.post<{ Params: { id: string }; Body: ChartUnusableRequest }>(
    '/api/charts/:id/unusable',
    { preHandler: app.requireSession },
    async (request, reply: FastifyReply) => {
      const reason = request.body?.reason;
      if (typeof reason !== 'string' || reason.trim() === '') {
        const body: ChartErrorResponse = {
          error: 'invalid_chart',
          message: 'Eine Begründung ist Pflicht - der Rest muss dokumentiert sein.',
          fields: [{ field: 'reason', message: 'Begründung fehlt.' }],
        };
        return reply.code(400).send(body);
      }
      await markUnusable(db, request.params.id, reason);
      return reply.send(await buildDetail(db, request.params.id));
    },
  );
}

/* -------------------------------------------------------------------------
 * Lesepfad
 * ---------------------------------------------------------------------- */

/** Baut die Liste für `GET /api/charts`. */
export async function buildList(db: Database): Promise<ReviewListResponse> {
  const rows = await db
    .select({
      id: rangeChart.id,
      captionNumber: bookAsset.captionNumber,
      captionRaw: bookAsset.captionRaw,
      state: rangeChart.state,
      model: rangeChart.model,
      cellCount: rangeChart.cellCount,
      unusableReason: rangeChart.unusableReason,
      ordinal: bookAsset.ordinal,
    })
    .from(rangeChart)
    .innerJoin(bookAsset, eq(rangeChart.assetId, bookAsset.id))
    .orderBy(asc(bookAsset.ordinal));

  const findingCounts = await db
    .select({
      chartId: chartFinding.chartId,
      severity: chartFinding.severity,
      n: sql<number>`count(*)::int`,
    })
    .from(chartFinding)
    .groupBy(chartFinding.chartId, chartFinding.severity);

  const manualCounts = await db
    .select({
      chartId: rangeChartCell.chartId,
      n: sql<number>`count(distinct ${rangeChartCell.hand})::int`,
    })
    .from(rangeChartCell)
    .where(eq(rangeChartCell.source, 'manual'))
    .groupBy(rangeChartCell.chartId);

  const recheckCounts = await db
    .select({ chartId: chartRecheck.chartId, n: sql<number>`count(*)::int` })
    .from(chartRecheck)
    .groupBy(chartRecheck.chartId);

  const errors = new Map<string, number>();
  const warnings = new Map<string, number>();
  for (const row of findingCounts) {
    if (row.severity === 'error') errors.set(row.chartId, row.n);
    if (row.severity === 'warning') warnings.set(row.chartId, row.n);
  }
  const manual = new Map(manualCounts.map((row) => [row.chartId, row.n]));
  const rechecks = new Map(recheckCounts.map((row) => [row.chartId, row.n]));

  const charts: ReviewChartSummary[] = rows.map((row) => ({
    id: row.id,
    captionNumber: row.captionNumber,
    captionRaw: row.captionRaw,
    state: row.state,
    model: row.model,
    cellCount: row.cellCount,
    errorCount: errors.get(row.id) ?? 0,
    warningCount: warnings.get(row.id) ?? 0,
    manualCells: manual.get(row.id) ?? 0,
    recheckCount: rechecks.get(row.id) ?? 0,
    unusableReason: row.unusableReason,
  }));

  const progress = await validationProgress(db);

  return {
    charts,
    totals: {
      handRangeAssets: progress.handRangeAssets,
      digitized: progress.digitized,
      raw: progress.byState['raw'] ?? 0,
      validated: progress.byState['validated'] ?? 0,
      approved: progress.byState['approved'] ?? 0,
      failed: progress.byState['failed'] ?? 0,
      unusable: progress.byState['unusable'] ?? 0,
      approvedShare: progress.approvedShare,
    },
    findingsByCheck: progress.findingsByCheck,
  };
}

/** Baut die Detailansicht für `GET /api/charts/:id`. */
export async function buildDetail(
  db: Database,
  chartId: string,
): Promise<ReviewChartDetail | undefined> {
  const [row] = await db
    .select({
      id: rangeChart.id,
      captionNumber: bookAsset.captionNumber,
      captionRaw: bookAsset.captionRaw,
      captionActions: bookAsset.captionActions,
      state: rangeChart.state,
      model: rangeChart.model,
      cellCount: rangeChart.cellCount,
      actions: rangeChart.actions,
      spot: rangeChart.spot,
      unusableReason: rangeChart.unusableReason,
    })
    .from(rangeChart)
    .innerJoin(bookAsset, eq(rangeChart.assetId, bookAsset.id))
    .where(eq(rangeChart.id, chartId));
  if (!row) return undefined;

  const cellRows = await db
    .select()
    .from(rangeChartCell)
    .where(eq(rangeChartCell.chartId, chartId))
    .orderBy(asc(rangeChartCell.hand));

  const findings = await db
    .select()
    .from(chartFinding)
    .where(eq(chartFinding.chartId, chartId))
    .orderBy(desc(chartFinding.severity), asc(chartFinding.hand));

  const flagged = new Set(
    findings.filter((entry) => entry.hand !== null).map((entry) => entry.hand as string),
  );

  const byHand = new Map<string, ReviewCell>();
  for (const cell of cellRows) {
    const existing = byHand.get(cell.hand);
    const action = {
      kind: cell.actionKind,
      sizing: cell.sizing === '' ? null : cell.sizing,
      percent: cell.percent,
    };
    if (existing) {
      byHand.set(cell.hand, { ...existing, actions: [...existing.actions, action] });
      continue;
    }
    byHand.set(cell.hand, {
      hand: cell.hand,
      actions: [action],
      source: cell.source as never,
      correctedAt: cell.correctedAt?.toISOString() ?? null,
      flagged: flagged.has(cell.hand),
    });
  }

  const chart = await loadChart(db, chartId);
  const [recheckCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chartRecheck)
    .where(eq(chartRecheck.chartId, chartId));
  const [manualCount] = await db
    .select({ n: sql<number>`count(distinct ${rangeChartCell.hand})::int` })
    .from(rangeChartCell)
    .where(and(eq(rangeChartCell.chartId, chartId), eq(rangeChartCell.source, 'manual')));

  return {
    id: row.id,
    captionNumber: row.captionNumber,
    captionRaw: row.captionRaw,
    state: row.state,
    model: row.model,
    cellCount: row.cellCount,
    errorCount: findings.filter((entry) => entry.severity === 'error').length,
    warningCount: findings.filter((entry) => entry.severity === 'warning').length,
    manualCells: manualCount?.n ?? 0,
    recheckCount: recheckCount?.n ?? 0,
    unusableReason: row.unusableReason,
    spot: (row.spot ?? {}) as Record<string, unknown>,
    actions: (row.actions ?? []) as { kind: string; sizing: string | null }[],
    cells: [...byHand.values()],
    findings: findings.map((entry): ChartFinding => ({
      check: entry.check as never,
      kind: entry.kind as never,
      severity: entry.severity as never,
      hand: entry.hand,
      actionKind: entry.actionKind,
      measured: entry.measured,
      expected: entry.expected,
      detail: entry.detail,
    })),
    weightedTotals: chart === undefined ? {} : weightedTotals(chart.matrix),
    captionTotals: captionTotalsOf(
      Array.isArray(row.captionActions)
        ? (row.captionActions as { action: string; percent: number }[])
        : [],
    ),
    imageUrl: `/api/charts/${chartId}/image`,
  };
}
