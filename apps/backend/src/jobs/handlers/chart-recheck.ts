import { and, eq } from 'drizzle-orm';
import { chartActionKey } from '@gto/shared';
import type { ChartFinding, ChartMatrix } from '@gto/shared';
import type { LlmProviderRegistry } from '../../llm/registry.js';
import type { LlmSettingsReader } from '../../llm/settings.js';
import type { TemplateRegistry } from '../../prompts/registry.js';
import { chartFinding, chartRecheck, rangeChart, rangeChartCell } from '../../db/schema.js';
import { captionActionsToLegend, parseChartSpot, toChartMatrix } from '../../chart/spot.js';
import { loadCandidate, readChartImage } from '../../chart/store.js';
import { loadChart, validateAndStore } from '../../chart/validation-store.js';
import { readExtraction, renderActions, renderHandList, renderSpot } from './chart-digitize.js';
import { JobPayloadError } from '../types.js';
import type { JobType } from '../types.js';

/**
 * Gezielter Zweitdurchlauf beanstandeter Charts (AP3.T3.4, Subtask 5).
 *
 * Verarbeitet **ausschliesslich** Charts, die bei der Validierung einen
 * Fehlerbefund bekommen haben - der Job prueft das selbst noch einmal, statt
 * sich auf den Aufrufer zu verlassen. Kontingent geht damit nur in das, was
 * tatsaechlich beanstandet ist.
 *
 * Die zweite Ablesung wird gegen die erste gestellt:
 *
 * - Stimmen beide ueberein, ist der Befund vermutlich echt - das Chart bleibt
 *   beanstandet und geht in die Review.
 * - Unterscheiden sie sich, gilt der zweite Wert. Er entstand mit einem Prompt,
 *   der auf die Schwachstelle hingewiesen hat, und ist damit der
 *   wahrscheinlichere.
 *
 * Beides wird in `chart_recheck` protokolliert. Ohne diese Zeile waere "der
 * zweite Wert gilt" ein stilles Ueberschreiben.
 *
 * **Von Hand korrigierte Zellen bleiben unangetastet.**
 */

/** Kennung dieses Job-Typs. */
export const CHART_RECHECK_JOB = 'chart.recheck';

export interface ChartRecheckPayload {
  readonly chartId: string;
  readonly runId: string;
  readonly model?: string;
}

export interface ChartRecheckOptions {
  readonly providers: LlmProviderRegistry;
  readonly templates: TemplateRegistry;
  readonly defaultModel: string;
  readonly maxTokens?: number;
  readonly settings?: LlmSettingsReader;
  readonly sourceDir?: string;
}

const DEFAULT_MAX_TOKENS = 32768;

/** Die Beanstandung als Prompt-Block. */
export function renderFindings(findings: readonly ChartFinding[]): string {
  const errors = findings.filter((entry) => entry.severity === 'error');
  if (errors.length === 0) return '- (keine Beanstandung)';

  const lines = errors.slice(0, 15).map((entry) => `- ${entry.detail}`);
  if (errors.length > 15) lines.push(`- … und ${errors.length - 15} weitere Beanstandungen.`);

  const hands = [
    ...new Set(errors.map((entry) => entry.hand).filter((hand): hand is string => hand !== null)),
  ];
  if (hands.length > 0) {
    lines.push('', `Besonders zu prüfende Blätter: ${hands.slice(0, 40).join(', ')}`);
  }
  return lines.join('\n');
}

export function createChartRecheckJob(options: ChartRecheckOptions): JobType<ChartRecheckPayload> {
  return {
    type: CHART_RECHECK_JOB,

    parsePayload(raw: unknown): ChartRecheckPayload {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new JobPayloadError('Die Nutzlast muss ein Objekt sein.');
      }
      const candidate = raw as Record<string, unknown>;
      const chartId = candidate['chartId'];
      if (typeof chartId !== 'string' || chartId.trim() === '') {
        throw new JobPayloadError('Feld "chartId" fehlt oder ist leer.');
      }
      const runId = candidate['runId'];
      if (typeof runId !== 'string' || runId.trim() === '') {
        throw new JobPayloadError('Feld "runId" fehlt oder ist leer.');
      }
      const model = candidate['model'];
      if (model !== undefined && typeof model !== 'string') {
        throw new JobPayloadError('Feld "model" muss eine Zeichenkette sein.');
      }
      return { chartId, runId, ...(model === undefined ? {} : { model }) };
    },

    async run(payload, context): Promise<void> {
      const chart = await loadChart(context.db, payload.chartId);
      if (chart === undefined) {
        throw new JobPayloadError(`Chart ${payload.chartId} existiert nicht.`);
      }

      const findings = await context.db
        .select()
        .from(chartFinding)
        .where(and(eq(chartFinding.chartId, payload.chartId), eq(chartFinding.severity, 'error')));

      if (findings.length === 0) {
        // Kein Kontingent fuer Unbeanstandetes: Der Job prueft das selbst.
        throw new JobPayloadError(
          `Chart ${payload.chartId} hat keinen Fehlerbefund. Der Zweitdurchlauf ` +
            `verarbeitet ausschliesslich beanstandete Charts.`,
        );
      }

      const asset = await loadCandidate(context.db, chart.assetId);
      if (asset === undefined) {
        throw new JobPayloadError(`Asset ${chart.assetId} ist nicht mehr verarbeitbar.`);
      }

      const spot = parseChartSpot(asset.captionSpot, asset.captionActions);
      const legend = captionActionsToLegend(asset.captionActions);
      const image = readChartImage(asset.relativePath, options.sourceDir);

      const settings = await options.settings?.read();
      const timeoutMs = settings?.timeoutMs;

      const request = options.templates.renderRequest(
        'task/chart-recheck',
        {
          unterschrift: asset.captionRaw ?? '(keine Unterschrift im Buch)',
          spot: renderSpot(spot),
          aktionen: renderActions(legend.actions),
          blattliste: renderHandList(),
          beanstandung: renderFindings(findings as unknown as ChartFinding[]),
        },
        {
          model: payload.model ?? settings?.model ?? options.defaultModel,
          maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          images: [{ type: 'image', mediaType: image.mediaType, data: image.data }],
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
      );

      const provider = await options.providers.getActive();
      const response = await provider.complete(request);
      const parsed = readExtraction(response.json ?? response.text);
      const second = toChartMatrix(parsed.zellen) as ChartMatrix;

      const comparison = await applySecondReading(
        context.db,
        payload,
        chart.matrix,
        second,
        new Set(chart.manualHands),
        response.meta.model,
        findings.map((entry) => entry.hand).filter((hand): hand is string => hand !== null),
      );

      // Nach dem Zweitdurchlauf laufen die Pruefungen erneut.
      const outcome = await validateAndStore(context.db, payload.chartId);

      context.log(
        `Zweitdurchlauf Chart ${chart.captionNumber ?? chart.id}: ` +
          `${comparison.cellsAgreed}/${comparison.cellsCompared} Zellen bestaetigt, ` +
          `${comparison.cellsChanged} geaendert, ${comparison.cellsProtected} manuell geschuetzt; ` +
          `danach ${outcome?.state ?? '?'} mit ${outcome?.errors ?? '?'} Fehlern ` +
          `(${response.meta.provider}/${response.meta.model}, ${response.meta.durationMs} ms).`,
      );
    },
  };
}

interface Comparison {
  cellsCompared: number;
  cellsAgreed: number;
  cellsChanged: number;
  cellsProtected: number;
}

/**
 * Stellt die zweite Ablesung gegen die erste und schreibt das Ergebnis.
 *
 * Zwei Zellen gelten als uebereinstimmend, wenn dieselben Aktionen mit
 * hoechstens 5 pp Unterschied auftreten - Flaechenschaetzung ist keine exakte
 * Wissenschaft, und ein Prozentpunkt hin oder her ist keine Meinungsverschiedenheit.
 */
async function applySecondReading(
  db: Parameters<typeof validateAndStore>[0],
  payload: ChartRecheckPayload,
  first: ChartMatrix,
  second: ChartMatrix,
  manualHands: ReadonlySet<string>,
  model: string,
  flaggedHands: readonly string[],
): Promise<Comparison> {
  const AGREEMENT_PP = 5;
  const firstByHand = new Map(first.map((cell) => [cell.hand, cell]));
  const comparison: Comparison = {
    cellsCompared: 0,
    cellsAgreed: 0,
    cellsChanged: 0,
    cellsProtected: 0,
  };

  const now = new Date();

  for (const cell of second) {
    if (manualHands.has(cell.hand)) {
      comparison.cellsProtected += 1;
      continue;
    }

    const before = firstByHand.get(cell.hand);
    comparison.cellsCompared += 1;

    const agrees =
      before !== undefined &&
      before.actions.length === cell.actions.length &&
      cell.actions.every((entry) => {
        const match = before.actions.find(
          (other) => chartActionKey(other.action) === chartActionKey(entry.action),
        );
        return match !== undefined && Math.abs(match.percent - entry.percent) <= AGREEMENT_PP;
      });

    if (agrees) {
      comparison.cellsAgreed += 1;
      continue;
    }
    comparison.cellsChanged += 1;

    await db
      .delete(rangeChartCell)
      .where(and(eq(rangeChartCell.chartId, payload.chartId), eq(rangeChartCell.hand, cell.hand)));
    if (cell.actions.length === 0) continue;

    const unique = new Map(
      cell.actions.map((entry) => [
        chartActionKey(entry.action),
        {
          chartId: payload.chartId,
          hand: cell.hand,
          actionKind: entry.action.kind,
          sizing: entry.action.sizing ?? '',
          percent: entry.percent,
          source: 'model' as const,
        },
      ]),
    );
    await db.insert(rangeChartCell).values([...unique.values()]);
  }

  const decision =
    comparison.cellsChanged === 0
      ? 'Beide Ablesungen stimmen ueberein - der Befund ist vermutlich echt und geht in die Review.'
      : `Der zweite Durchlauf weicht in ${comparison.cellsChanged} Zellen ab; diese Werte gelten, ` +
        `weil der geschaerfte Prompt auf die Beanstandung hingewiesen hat. ` +
        `${comparison.cellsAgreed} Zellen wurden bestaetigt.` +
        (comparison.cellsProtected > 0
          ? ` ${comparison.cellsProtected} von Hand korrigierte Zellen blieben unangetastet.`
          : '');

  await db.insert(chartRecheck).values({
    chartId: payload.chartId,
    model,
    runId: payload.runId,
    flaggedHands: [...flaggedHands],
    cellsCompared: comparison.cellsCompared,
    cellsAgreed: comparison.cellsAgreed,
    cellsChanged: comparison.cellsChanged,
    cellsProtected: comparison.cellsProtected,
    decision,
  });

  await db.update(rangeChart).set({ updatedAt: now }).where(eq(rangeChart.id, payload.chartId));

  return comparison;
}
