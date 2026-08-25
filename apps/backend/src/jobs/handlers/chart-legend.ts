import { eq } from 'drizzle-orm';
import type { LlmProviderRegistry } from '../../llm/registry.js';
import type { LlmSettingsReader } from '../../llm/settings.js';
import type { TemplateRegistry } from '../../prompts/registry.js';
import { rangeChart } from '../../db/schema.js';
import { captionActionsToLegend, legendTotalsOf } from '../../chart/spot.js';
import { loadCandidate, readChartImage } from '../../chart/store.js';
import { loadChart, validateAndStore } from '../../chart/validation-store.js';
import { readLegendValues, renderActions } from './chart-digitize.js';
import { JobPayloadError } from '../types.js';
import type { JobType } from '../types.js';

/**
 * Legenden-Nachzug für bereits digitalisierte Charts (AP3.T3.6-fix).
 *
 * Neue Charts bekommen die gedruckte Legende seit Fassung 2 des Templates im
 * **selben** Vision-Aufruf wie die Matrix — alles andere würde den
 * Kontingentbedarf des Vollausbaus verdoppeln. Dieser Job ist ausschließlich
 * für die 30 Charts da, die vor der Umstellung entstanden sind: ein kleiner
 * Aufruf ohne Blattliste und ohne Rasterarbeit, der nur die Legende liest.
 *
 * **Die Matrix wird dabei nicht angefasst.** Der Job schreibt in
 * `legend_totals`, `legend_present` und `legend_labels` — und stößt danach die
 * Validierung an, damit der neue Befund sofort sichtbar ist.
 */

export const CHART_LEGEND_JOB = 'chart.legend';

export interface ChartLegendPayload {
  readonly chartId: string;
  readonly runId: string;
  readonly model?: string;
}

export interface ChartLegendOptions {
  readonly providers: LlmProviderRegistry;
  readonly templates: TemplateRegistry;
  readonly defaultModel: string;
  readonly maxTokens?: number;
  readonly settings?: LlmSettingsReader;
  readonly sourceDir?: string;
}

/**
 * Die Legende ist ein Kasten mit einer Handvoll Zeilen — 2 048 Token reichen
 * mit weitem Abstand. Die Grenze ist der eigentliche Sparhebel dieses Jobs:
 * `chart.digitize` braucht 32 768.
 */
const DEFAULT_MAX_TOKENS = 2048;

export function createChartLegendJob(options: ChartLegendOptions): JobType<ChartLegendPayload> {
  return {
    type: CHART_LEGEND_JOB,

    parsePayload(raw: unknown): ChartLegendPayload {
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
      if (chart.legendPresent) {
        // Kein Kontingent fuer Erledigtes: Der Job prueft das selbst, statt
        // sich auf den Aufrufer zu verlassen.
        throw new JobPayloadError(
          `Chart ${payload.chartId} hat bereits eine gelesene Legende. Der Nachzug ` +
            `verarbeitet ausschliesslich Charts ohne Legendenwerte.`,
        );
      }

      const asset = await loadCandidate(context.db, chart.assetId);
      if (asset === undefined) {
        throw new JobPayloadError(`Asset ${chart.assetId} ist nicht mehr verarbeitbar.`);
      }

      const legend = captionActionsToLegend(asset.captionActions);
      const image = readChartImage(asset.relativePath, options.sourceDir);
      const settings = await options.settings?.read();
      const timeoutMs = settings?.timeoutMs;

      const request = options.templates.renderRequest(
        'task/chart-legend',
        {
          unterschrift: asset.captionRaw ?? '(keine Unterschrift im Buch)',
          aktionen: renderActions(legend.actions),
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
      const raw = response.json ?? parseJson(response.text);
      const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
        string,
        unknown
      >;

      const values = readLegendValues(record['legendenwerte']);
      const present = record['legendenwerte_vorhanden'] === true && values.length > 0;
      const { totals, labels } = legendTotalsOf(values);

      await context.db
        .update(rangeChart)
        .set({
          legendTotals: totals,
          legendPresent: present,
          legendLabels: labels,
          updatedAt: new Date(),
        })
        .where(eq(rangeChart.id, payload.chartId));

      // Der neue Befund soll sofort sichtbar sein.
      const outcome = await validateAndStore(context.db, payload.chartId);

      context.log(
        `Legende Chart ${chart.captionNumber ?? chart.id}: ` +
          `${present ? labels.join(' / ') : 'keine im Bild'}; ` +
          `danach ${outcome?.state ?? '?'} mit ${outcome?.errors ?? '?'} Fehlern ` +
          `(${response.meta.provider}/${response.meta.model}, ${response.meta.durationMs} ms, ` +
          `${response.meta.totalTokens ?? '?'} Tokens).`,
      );
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JobPayloadError('Die Antwort war kein JSON.');
  }
}
