import { eq } from 'drizzle-orm';
import { LLM_LOG_TRUNCATION_MARKER } from '@gto/shared';
import type { LLMProvider, LlmContent, LlmRequest, LlmResponse } from '@gto/shared';
import type { Database } from '../db/client.js';
import { llmCallLog } from '../db/schema.js';
import { isLlmError } from './errors.js';

/**
 * Zentrales Protokollieren jedes Provider-Aufrufs (AP2.T2.5).
 *
 * Der Dekorator sitzt **in der Provider-Registry** und legt sich um jeden
 * Adapter. Damit landet jeder Aufruf in `llm_call_log`, egal wer ihn absetzt -
 * niemand kann ihn "vergessen". Fachliche Module sehen davon nichts; sie
 * bekommen weiterhin einen `LLMProvider`.
 *
 * Zwei Schreibvorgaenge je Aufruf: zuerst eine Zeile mit `status: 'pending'`,
 * danach das Ergebnis. So ist ein laufender Aufruf in der Oberflaeche sichtbar,
 * und ein Absturz mitten im Aufruf hinterlaesst eine Spur statt gar nichts.
 */

/**
 * Obergrenze fuer Prompt und Antwort im Protokoll.
 *
 * Ohne Grenze wuerden die Base64-Bilder aus AP3 (rund 336 Chart-Aufrufe) die
 * Tabelle sprengen. Bildbloecke werden ohnehin nie im Klartext protokolliert -
 * sie erscheinen als Kurzvermerk mit Groesse. Ueberschreitet der Rest die
 * Grenze, wird er sichtbar gekuerzt (ADR-0028).
 */
export const LLM_LOG_MAX_CHARS = Number(process.env['LLM_LOG_MAX_CHARS'] ?? 20_000);

/** Wohin protokolliert wird. Austauschbar, damit Tests ohne DB auskommen. */
export interface CallLogSink {
  /** Legt den Eintrag an und liefert seine Kennung. */
  start(entry: {
    readonly provider: string;
    readonly model: string;
    readonly prompt: string;
  }): Promise<string>;
  /** Schliesst den Eintrag ab. */
  finish(
    id: string,
    entry: {
      readonly status: 'success' | 'error';
      readonly model?: string;
      readonly response?: string;
      readonly error?: string;
      readonly durationMs?: number;
      readonly promptTokens?: number | null;
      readonly completionTokens?: number | null;
      readonly totalTokens?: number | null;
    },
  ): Promise<void>;
}

/** Protokoll-Senke gegen die Tabelle `llm_call_log`. */
export function createDbCallLogSink(db: Database): CallLogSink {
  return {
    async start(entry): Promise<string> {
      const rows = await db
        .insert(llmCallLog)
        .values({
          provider: entry.provider,
          model: entry.model,
          prompt: entry.prompt,
          status: 'pending',
        })
        .returning({ id: llmCallLog.id });
      return rows[0]?.id ?? '';
    },
    async finish(id, entry): Promise<void> {
      await db
        .update(llmCallLog)
        .set({
          status: entry.status,
          ...(entry.model === undefined ? {} : { model: entry.model }),
          response: entry.response ?? null,
          error: entry.error ?? null,
          durationMs: entry.durationMs ?? null,
          promptTokens: entry.promptTokens ?? null,
          completionTokens: entry.completionTokens ?? null,
          totalTokens: entry.totalTokens ?? null,
        })
        .where(eq(llmCallLog.id, id));
    },
  };
}

/** Wird nach jedem Aufruf gerufen - der Worker haengt daran die Job-Ereignisse. */
export type CallLogObserver = (info: { readonly callId: string }) => void;

export interface CallLogOptions {
  readonly sink: CallLogSink;
  /**
   * Ein Fehler beim Protokollieren darf den Aufruf **nie** scheitern lassen.
   * Er wird hierhin gemeldet und sonst verschluckt.
   */
  readonly onLogFailure?: (error: unknown) => void;
  readonly onStarted?: CallLogObserver;
  readonly maxChars?: number;
}

/**
 * Legt das Protokollieren um einen Provider. Die Signatur bleibt exakt
 * `LLMProvider`, damit der Dekorator ueberall dort passt, wo ein Adapter passt.
 */
export function withCallLog(provider: LLMProvider, options: CallLogOptions): LLMProvider {
  const maxChars = options.maxChars ?? LLM_LOG_MAX_CHARS;
  const report = options.onLogFailure ?? (() => undefined);

  return {
    id: provider.id,
    async complete<TJson>(request: LlmRequest): Promise<LlmResponse<TJson>> {
      const startedAt = Date.now();

      let callId: string | undefined;
      try {
        callId = await options.sink.start({
          provider: provider.id,
          model: request.model,
          prompt: truncate(formatPrompt(request), maxChars),
        });
        options.onStarted?.({ callId });
      } catch (error) {
        report(error);
      }

      try {
        const response = await provider.complete<TJson>(request);
        await safely(report, async () => {
          if (callId === undefined) return;
          await options.sink.finish(callId, {
            status: 'success',
            model: response.meta.model,
            response: truncate(response.text, maxChars),
            durationMs: response.meta.durationMs,
            promptTokens: response.meta.promptTokens,
            completionTokens: response.meta.completionTokens,
            totalTokens: response.meta.totalTokens,
          });
        });
        return response;
      } catch (error) {
        // Gerade die Fehlschlaege sind fuer die Fehlersuche wichtig.
        await safely(report, async () => {
          if (callId === undefined) return;
          await options.sink.finish(callId, {
            status: 'error',
            error: truncate(describeError(error), maxChars),
            durationMs: Date.now() - startedAt,
          });
        });
        throw error;
      }
    },
  };
}

/**
 * Bringt eine Anfrage in eine lesbare Form fuers Protokoll.
 *
 * Bildbloecke werden **nie** im Klartext geschrieben - stattdessen steht dort
 * ein Vermerk mit Medientyp und Groesse. Das haelt die Tabelle klein und
 * verhindert, dass ein einzelner Chart-Aufruf megabyteweise Base64 ablegt.
 */
export function formatPrompt(request: LlmRequest): string {
  const parts = [`[system]\n${request.system}`];
  for (const message of request.messages) {
    parts.push(`[${message.role}]\n${message.content.map(formatBlock).join('\n')}`);
  }
  if (request.jsonSchema !== undefined) {
    parts.push(`[jsonSchema]\n${JSON.stringify(request.jsonSchema)}`);
  }
  return parts.join('\n\n');
}

function formatBlock(block: LlmContent): string {
  if (block.type === 'text') return block.text;
  return `[bild ${block.mediaType}, ${block.data.length} Zeichen base64 - nicht protokolliert]`;
}

/** Kuerzt sichtbar: Wer die Markierung sieht, weiss, dass etwas fehlt. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… ${LLM_LOG_TRUNCATION_MARKER}: ${text.length - maxChars} von ${text.length} Zeichen entfernt`;
}

function describeError(error: unknown): string {
  if (isLlmError(error)) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function safely(report: (error: unknown) => void, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    report(error);
  }
}
