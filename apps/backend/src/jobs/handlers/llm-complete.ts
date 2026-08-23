import type { LlmProviderRegistry } from '../../llm/registry.js';
import type { TemplateRegistry } from '../../prompts/registry.js';
import { JobPayloadError } from '../types.js';
import type { JobType } from '../types.js';

/**
 * Referenz-Job-Typ: ein einzelner KI-Aufruf (AP2.T2.5).
 *
 * Bewusst der einfachste Fall - er belegt, dass Job-Queue, Template-Registry
 * und Provider-Registry zusammenpassen. Die fachlichen Job-Typen
 * (Chart-Digitalisierung, HH-Analyse, PDF-Erzeugung) entstehen in AP3, AP8
 * und AP9 und werden nach demselben Muster registriert; die Anleitung steht in
 * docs/INTERFACES.md Abschnitt 10.
 */

/** Kennung dieses Job-Typs. */
export const LLM_COMPLETE_JOB = 'llm.complete';

export interface LlmCompletePayload {
  /** Kennung eines `task`-Templates. */
  readonly templateId: string;
  /** Werte fuer die Platzhalter des Templates. */
  readonly values: Readonly<Record<string, string>>;
  /** Ueberschreibt das Standardmodell aus der Konfiguration. */
  readonly model?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
}

export interface LlmCompleteOptions {
  readonly providers: LlmProviderRegistry;
  readonly templates: TemplateRegistry;
  /** Vorgaben, wenn die Nutzlast nichts sagt. */
  readonly defaultModel: string;
  readonly defaultMaxTokens: number;
}

/**
 * Baut den Job-Typ.
 *
 * Der Aufruf laeuft ueber die Provider-Registry - damit greift das
 * Aufruf-Protokoll automatisch, ohne dass dieser Handler etwas davon weiss.
 */
export function createLlmCompleteJob(options: LlmCompleteOptions): JobType<LlmCompletePayload> {
  return {
    type: LLM_COMPLETE_JOB,

    parsePayload(raw: unknown): LlmCompletePayload {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new JobPayloadError('Die Nutzlast muss ein Objekt sein.');
      }
      const candidate = raw as Record<string, unknown>;

      const templateId = candidate['templateId'];
      if (typeof templateId !== 'string' || templateId.trim() === '') {
        throw new JobPayloadError('Feld "templateId" fehlt oder ist leer.');
      }

      const values = candidate['values'] ?? {};
      if (typeof values !== 'object' || values === null || Array.isArray(values)) {
        throw new JobPayloadError('Feld "values" muss ein Objekt sein.');
      }
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== 'string') {
          throw new JobPayloadError(`Platzhalterwert "${key}" muss eine Zeichenkette sein.`);
        }
      }

      const model = candidate['model'];
      if (model !== undefined && typeof model !== 'string') {
        throw new JobPayloadError('Feld "model" muss eine Zeichenkette sein.');
      }

      const maxTokens = candidate['maxTokens'];
      if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1)) {
        throw new JobPayloadError('Feld "maxTokens" muss eine positive Ganzzahl sein.');
      }

      const timeoutMs = candidate['timeoutMs'];
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1)) {
        throw new JobPayloadError('Feld "timeoutMs" muss eine positive Ganzzahl sein.');
      }

      return {
        templateId,
        values: values as Record<string, string>,
        ...(model === undefined ? {} : { model: model }),
        ...(maxTokens === undefined ? {} : { maxTokens: maxTokens as number }),
        ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
      };
    },

    async run(payload, context): Promise<void> {
      const request = options.templates.renderRequest(payload.templateId, payload.values, {
        model: payload.model ?? options.defaultModel,
        maxTokens: payload.maxTokens ?? options.defaultMaxTokens,
        ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
      });

      const provider = await options.providers.getActive();
      const response = await provider.complete(request);

      context.log(
        `Job ${context.job.id}: ${payload.templateId} ueber ${response.meta.provider}/${response.meta.model} ` +
          `in ${response.meta.durationMs} ms.`,
      );
    },
  };
}
