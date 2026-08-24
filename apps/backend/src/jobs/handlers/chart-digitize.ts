import { CHART_HANDS, chartActionLabel } from '@gto/shared';
import type { ChartAction, ChartSpot } from '@gto/shared';
import type { LlmProviderRegistry } from '../../llm/registry.js';
import type { LlmSettingsReader } from '../../llm/settings.js';
import type { TemplateRegistry } from '../../prompts/registry.js';
import { captionActionsToLegend, parseChartSpot, toChartMatrix } from '../../chart/spot.js';
import {
  isComplete,
  legendOf,
  loadCandidate,
  matrixIssues,
  persistChart,
  readChartImage,
} from '../../chart/store.js';
import type { ChartCandidate } from '../../chart/store.js';
import { JobPayloadError } from '../types.js';
import type { JobType } from '../types.js';

/**
 * Chart-Digitalisierung je Bild (AP3.T3.3, Subtask 5).
 *
 * **Ein Job je Chart**, nicht einer fuer die ganze Charge: So wirkt ein Retry
 * gezielt, ein Abbruch verliert hoechstens den laufenden Chart, und ein
 * `rate_limit` legt genau diesen einen Job wieder vor, statt die Charge zu
 * beenden.
 *
 * Der Aufruf laeuft ueber die Provider-Registry; das Bild geht als
 * Vision-Baustein mit. Das Aufruf-Protokoll aus T2.5 kuerzt Bilder auf einen
 * Kurzvermerk - diese Kuerzung wird hier nicht umgangen.
 *
 * Der Zustand des Ergebnisses ist **immer `raw`**. Die Freigabe haengt an der
 * Validierung aus T3.4; hier wird nichts approved.
 */

/** Kennung dieses Job-Typs. */
export const CHART_DIGITIZE_JOB = 'chart.digitize';

export interface ChartDigitizePayload {
  /** `book_asset.id` des Chart-Bildes. */
  readonly assetId: string;
  /** Kennung des Laufs - fuer die Herkunft am Datensatz. */
  readonly runId: string;
  /** Modell fuer diesen Job; ohne Angabe gilt die Laufzeit-Einstellung. */
  readonly model?: string;
}

export interface ChartDigitizeOptions {
  readonly providers: LlmProviderRegistry;
  readonly templates: TemplateRegistry;
  readonly defaultModel: string;
  /**
   * Antwortgrenze.
   *
   * **Dieser Wert ist die tatsaechliche Obergrenze der CLI**, nicht nur ein
   * Hinweis: Der CLI-Adapter setzt daraus `CLAUDE_CODE_MAX_OUTPUT_TOKENS` je
   * Aufruf (`src/llm/invocation.ts`) und ueberschreibt damit, was in der
   * Umgebung des Host-Runners steht.
   *
   * 169 Zellen als JSON sind rund 8 000 Tokens; mit innerem Ueberlegen
   * deutlich mehr. Bei 16 384 brachen die dichtesten Raster im Massenlauf mit
   * `Claude's response exceeded the 16384 output token maximum` ab - deshalb
   * 32 768. Ein zu hoher Wert kostet nichts; die CLI kuerzt nicht, sie bricht
   * ab (T2.2).
   */
  readonly maxTokens?: number;
  readonly settings?: LlmSettingsReader;
  /**
   * Abweichendes Quellverzeichnis der Bilder. Nur fuer Tests - im Betrieb
   * gilt `data/book-source/` wie in T3.1.
   */
  readonly sourceDir?: string;
}

const DEFAULT_MAX_TOKENS = 32768;

/** Der Spot als lesbarer Prompt-Block. */
export function renderSpot(spot: ChartSpot): string {
  const lines = [
    ['Spielform', spot.format],
    ['Position', spot.heroPosition],
    ['Gegenposition', spot.villainPosition],
    ['Stacktiefe', spot.stackDepthBb === null ? null : `${spot.stackDepthBb}bb`],
    ['Aktionsfolge', spot.actionSequence],
    ['Sizings', spot.sizings.length > 0 ? spot.sizings.join(', ') : null],
  ] as const;

  const known = lines
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) => `- ${label}: ${String(value)}`);

  return known.length > 0 ? known.join('\n') : '- (die Unterschrift nennt keine Spot-Angaben)';
}

/** Die Aktionen der Unterschrift als Prompt-Block. */
export function renderActions(actions: readonly ChartAction[]): string {
  if (actions.length === 0) {
    return '- (die Unterschrift nennt keine Aktionen; nimm die Legende des Bildes)';
  }
  return actions
    .map(
      (action) =>
        `- \`${action.kind}\`${action.sizing ? ` (${action.sizing})` : ''} — ${chartActionLabel(action)}`,
    )
    .join('\n');
}

/** Die 169 gueltigen Blattbezeichnungen, zeilenweise wie im Raster. */
export function renderHandList(): string {
  const lines: string[] = [];
  for (let index = 0; index < CHART_HANDS.length; index += 13) {
    lines.push(CHART_HANDS.slice(index, index + 13).join(' '));
  }
  return lines.join('\n');
}

export function createChartDigitizeJob(
  options: ChartDigitizeOptions,
): JobType<ChartDigitizePayload> {
  return {
    type: CHART_DIGITIZE_JOB,

    parsePayload(raw: unknown): ChartDigitizePayload {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new JobPayloadError('Die Nutzlast muss ein Objekt sein.');
      }
      const candidate = raw as Record<string, unknown>;

      const assetId = candidate['assetId'];
      if (typeof assetId !== 'string' || assetId.trim() === '') {
        throw new JobPayloadError('Feld "assetId" fehlt oder ist leer.');
      }
      const runId = candidate['runId'];
      if (typeof runId !== 'string' || runId.trim() === '') {
        throw new JobPayloadError('Feld "runId" fehlt oder ist leer.');
      }
      const model = candidate['model'];
      if (model !== undefined && typeof model !== 'string') {
        throw new JobPayloadError('Feld "model" muss eine Zeichenkette sein.');
      }

      return { assetId, runId, ...(model === undefined ? {} : { model }) };
    },

    async run(payload, context): Promise<void> {
      const asset = await loadCandidate(context.db, payload.assetId);
      if (!asset) {
        // Nicht wiederholbar: Das Asset ist entweder kein `hand_range`, unsicher
        // klassifiziert, entfallen oder die Datei fehlt. Ein zweiter Versuch
        // aendert daran nichts.
        throw new JobPayloadError(
          `Asset ${payload.assetId} ist kein verarbeitbares hand_range-Chart ` +
            `(Typ, Klassifikationssicherheit oder Datei fehlen).`,
        );
      }

      const spot = parseChartSpot(asset.captionSpot, asset.captionActions);
      const legend = captionActionsToLegend(asset.captionActions);
      const image = readChartImage(asset.relativePath, options.sourceDir);

      const settings = await options.settings?.read();
      const model = payload.model ?? settings?.model ?? options.defaultModel;
      const timeoutMs = settings?.timeoutMs;

      const request = options.templates.renderRequest(
        'task/chart-digitize',
        {
          unterschrift: asset.captionRaw ?? '(keine Unterschrift im Buch)',
          spot: renderSpot(spot),
          aktionen: renderActions(legend.actions),
          blattliste: renderHandList(),
        },
        {
          model,
          maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          images: [{ type: 'image', mediaType: image.mediaType, data: image.data }],
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
      );

      const provider = await options.providers.getActive();
      const response = await provider.complete(request);

      const parsed = readExtraction(response.json ?? response.text);
      const matrix = toChartMatrix(parsed.zellen);
      const issues = matrixIssues(matrix);
      const complete = isComplete(matrix);

      // Eine leere Antwort ist zweierlei, und die Unterscheidung ist wichtig:
      // Entweder zeigt das Bild gar kein Aktionsraster (41 der 348 Bilder sind
      // Struktur- oder Beispielraster ohne Frequenzen) - dann ist die leere
      // Matrix das richtige Ergebnis -, oder das Modell hat versagt. T3.4 und
      // T3.6 muessen beides auseinanderhalten koennen, deshalb steht der Grund
      // im Klartext am Datensatz.
      const failureReason = complete
        ? undefined
        : matrix.length === 0
          ? `Kein Aktionsraster im Bild erkannt: ${parsed.unsicher.join(' | ') || 'ohne Begruendung des Modells'}`
          : issues.join(' | ') || 'Matrix unvollstaendig.';

      await persistChart(context.db, {
        assetId: asset.assetId,
        model: response.meta.model,
        runId: payload.runId,
        spot,
        actions: legend.actions.length > 0 ? legend.actions : legendOf(matrix),
        matrix,
        // Die Legendenzuordnung des Modells wird mitgeschrieben: Sie ist der
        // Beleg, welche Farbe als welche Aktion gelesen wurde.
        uncertain: [...parsed.unsicher, ...parsed.legende.map((line) => `Legende: ${line}`)],
        durationMs: response.meta.durationMs,
        promptTokens: response.meta.promptTokens,
        completionTokens: response.meta.completionTokens,
        totalTokens: response.meta.totalTokens,
        // Eine unvollstaendige Matrix ist ein Befund, kein stiller Teilerfolg.
        ...(failureReason === undefined ? {} : { failureReason }),
      });

      context.log(
        `Chart ${describe(asset)}: ${matrix.length}/169 Zellen, ` +
          `${complete ? 'vollstaendig' : matrix.length === 0 ? 'KEIN AKTIONSRASTER' : 'UNVOLLSTAENDIG'}, ` +
          `${parsed.unsicher.length} unsichere Stellen ` +
          `(${response.meta.provider}/${response.meta.model}, ${response.meta.durationMs} ms, ` +
          `${response.meta.totalTokens ?? '?'} Tokens).`,
      );
    },
  };
}

function describe(asset: ChartCandidate): string {
  return asset.captionNumber === null
    ? asset.fileName
    : `Hand Range ${asset.captionNumber} (${asset.fileName})`;
}

/** Antwort des Modells einlesen. */
export function readExtraction(source: unknown): {
  zellen: unknown;
  unsicher: string[];
  legende: string[];
} {
  let value = source;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new JobPayloadError('Die Antwort war kein JSON.');
    }
  }
  if (typeof value !== 'object' || value === null) {
    throw new JobPayloadError('Die Antwort war kein Objekt.');
  }

  const record = value as { zellen?: unknown; unsicher?: unknown; legende?: unknown };
  if (!Array.isArray(record.zellen)) {
    throw new JobPayloadError('Feld "zellen" fehlt oder ist keine Liste.');
  }

  return {
    zellen: record.zellen,
    unsicher: asStrings(record.unsicher),
    legende: asStrings(record.legende),
  };
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
