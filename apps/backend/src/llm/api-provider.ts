import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from '@anthropic-ai/sdk';
import type { LlmContent, LlmJsonSchema, LlmRequest, LlmResponse } from '@gto/shared';
import { loadLlmConfig } from '../config/env.js';
import type { LlmConfig } from '../config/env.js';
import { GuardedProvider } from './base-provider.js';
import { LlmError } from './errors.js';
import { extractJson, validateAgainstSchema } from './parse.js';

/**
 * Adapter B: Anthropic Messages API (Fallback, T2.3).
 *
 * Zweiter, gleichwertiger Weg zum Modell - damit das Werkzeug nicht an der
 * Subscription haengt (Risiko R1 im Gesamtscope). Nach aussen verhaelt er sich
 * identisch zum CLI-Adapter: dieselbe Antwortform, dieselbe Fehler-Taxonomie,
 * dieselbe Retry-Einstufung. Nebenlaeufigkeit und Retry kommen aus
 * {@link GuardedProvider} und existieren nur dort.
 */
export class AnthropicApiProvider extends GuardedProvider {
  readonly id = 'api' as const;
  readonly #client: Anthropic;
  readonly #defaultModel: string;
  /** Nur zum Ausschwaerzen in Fehlermeldungen - wird nie ausgegeben. */
  readonly #secret: string | undefined;

  constructor(config: LlmConfig, client?: Anthropic) {
    super(config);
    this.#defaultModel = config.model;
    this.#secret = config.apiKey;
    this.#client =
      client ??
      new Anthropic({
        apiKey: config.apiKey ?? '',
        ...(config.apiBaseUrl === undefined ? {} : { baseURL: config.apiBaseUrl }),
        // Wiederholungen gehoeren in GuardedProvider. Der SDK-eigene Retry
        // wuerde daneben laufen, die Taxonomie umgehen und das Zeitbudget
        // unbemerkt vervielfachen.
        maxRetries: 0,
      });
  }

  protected async attempt(request: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
    const startedAt = Date.now();

    let message: Anthropic.Message;
    try {
      message = await this.#client.messages.create(
        {
          model: request.model.trim() === '' ? this.#defaultModel : request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: request.messages.map((entry) => ({
            role: entry.role,
            content: entry.content.map(toApiBlock),
          })),
          ...(request.jsonSchema === undefined
            ? {}
            : {
                output_config: {
                  format: {
                    type: 'json_schema' as const,
                    schema: forceClosedObjects(request.jsonSchema),
                  },
                },
              }),
        },
        { timeout: timeoutMs },
      );
    } catch (error) {
      throw this.#mapError(error);
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const meta = {
      provider: this.id,
      model: message.model,
      durationMs: Date.now() - startedAt,
      promptTokens: sumOrNull([
        message.usage.input_tokens,
        message.usage.cache_creation_input_tokens,
        message.usage.cache_read_input_tokens,
      ]),
      completionTokens: message.usage.output_tokens,
      totalTokens: sumOrNull([
        message.usage.input_tokens,
        message.usage.cache_creation_input_tokens,
        message.usage.cache_read_input_tokens,
        message.usage.output_tokens,
      ]),
    };

    if (request.jsonSchema === undefined) {
      return { text, json: null, meta };
    }

    // Dieselbe Auswertung wie beim CLI-Adapter - deshalb dieselben
    // Parse-Fehler bei derselben Eingabe.
    const payload = extractJson(text);
    if (payload === undefined) {
      throw this.fail(
        'parse',
        `Die Antwort enthaelt keine auswertbare JSON-Nutzlast, obwohl ein Schema verlangt war. Antwort (gekuerzt): ${excerpt(text)}`,
      );
    }
    const problems = validateAgainstSchema(payload, request.jsonSchema);
    if (problems.length > 0) {
      throw this.fail(
        'parse',
        `Die Antwort verletzt das angeforderte Schema: ${problems.join('; ')}`,
      );
    }

    return { text, json: payload, meta };
  }

  /**
   * Bildet HTTP-Status und Netzwerkfehler auf dieselbe Taxonomie ab wie der
   * CLI-Adapter. Unbekanntes gilt bewusst als **nicht** wiederholbar.
   */
  #mapError(error: unknown): LlmError {
    if (error instanceof LlmError) return error;

    if (error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError) {
      return this.fail(
        'timeout',
        'Die Anthropic-API hat nicht innerhalb des Zeitlimits geantwortet; der Aufruf wurde abgebrochen.',
      );
    }
    if (error instanceof RateLimitError) {
      const retryAfterMs = readRetryAfterMs(error);
      return this.fail(
        'rate_limit',
        `Anthropic-API: Kontingent erschoepft (429). ${this.#clean(error.message)}`,
        retryAfterMs,
      );
    }
    if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
      return this.fail(
        'auth',
        `Anthropic-API hat die Anmeldung abgelehnt (${error.status ?? '401/403'}). ` +
          'Pruefe ANTHROPIC_API_KEY in der .env - der Schluessel wird hier bewusst nicht ausgegeben.',
      );
    }
    if (error instanceof NotFoundError) {
      return this.fail(
        'invalid',
        `Anthropic-API: Endpunkt oder Modell unbekannt (404). ${this.#clean(error.message)}`,
      );
    }
    if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) {
      return this.fail(
        'invalid',
        `Anthropic-API hat die Anfrage abgelehnt (${error.status}). ${this.#clean(error.message)}`,
      );
    }
    if (error instanceof InternalServerError) {
      return this.fail(
        'transient',
        `Anthropic-API voruebergehend gestoert (${error.status}). ${this.#clean(error.message)}`,
      );
    }
    if (error instanceof APIConnectionError) {
      return this.fail(
        'transient',
        `Anthropic-API nicht erreichbar: ${this.#clean(error.message)}`,
      );
    }
    if (error instanceof APIError) {
      const status = error.status ?? 0;
      if (status === 408 || status === 409) {
        return this.fail('transient', `Anthropic-API: ${this.#clean(error.message)}`);
      }
      if (status >= 500) {
        return this.fail('transient', `Anthropic-API voruebergehend gestoert (${status}).`);
      }
      return this.fail('invalid', `Anthropic-API: ${this.#clean(error.message)}`);
    }

    return this.fail(
      'invalid',
      `Unklassifizierter Fehler des API-Adapters: ${this.#clean(describe(error))}`,
    );
  }

  /**
   * Entfernt den API-Schluessel aus einer Meldung, falls er - etwa ueber einen
   * gespiegelten Request-Header - doch darin auftaucht.
   */
  #clean(message: string): string {
    const cleaned =
      this.#secret === undefined || this.#secret === ''
        ? message
        : message.split(this.#secret).join('***');
    return excerpt(cleaned);
  }
}

/**
 * Baut den Adapter aus der Konfiguration.
 *
 * Ohne Schluessel bricht das **hier** ab, nicht erst beim ersten Aufruf - mit
 * Kategorie `auth`, damit Aufrufer nicht zwischen Konfigurations- und
 * Laufzeitfehlern unterscheiden muessen.
 */
export function createAnthropicApiProvider(
  config: LlmConfig = loadLlmConfig(),
  client?: Anthropic,
): AnthropicApiProvider {
  if (client === undefined && (config.apiKey === undefined || config.apiKey === '')) {
    throw new LlmError({
      kind: 'auth',
      provider: 'api',
      message:
        'ANTHROPIC_API_KEY fehlt oder ist leer. Der API-Adapter ist der aktive ' +
        'Provider, kann ohne Schluessel aber nicht aufrufen. Trage den Schluessel ' +
        'in die .env ein (siehe .env.example) oder stelle llm.provider auf "cli" zurueck.',
    });
  }
  return new AnthropicApiProvider(config, client);
}

/* -------------------------------------------------------------------------
 * Hilfsfunktionen
 * ---------------------------------------------------------------------- */

function toApiBlock(block: LlmContent): Anthropic.ContentBlockParam {
  if (block.type === 'text') return { type: 'text', text: block.text };
  return {
    type: 'image',
    source: { type: 'base64', media_type: block.mediaType, data: block.data },
  };
}

/**
 * Strukturierte Ausgaben verlangen `additionalProperties: false` an **jedem**
 * Objekt. Der `LLMProvider`-Vertrag verlangt das nicht - ohne diese
 * Angleichung wuerde derselbe Request beim CLI-Adapter laufen und beim
 * API-Adapter mit 400 scheitern. Ergaenzt wird nur, wo `properties` steht und
 * die Angabe fehlt; vorhandene Werte bleiben unangetastet.
 */
export function forceClosedObjects(schema: LlmJsonSchema): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isRecord(node)) return node;

    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) copy[key] = walk(value);

    if (isRecord(copy['properties']) && !('additionalProperties' in copy)) {
      copy['additionalProperties'] = false;
    }
    return copy;
  };

  return walk(schema) as Record<string, unknown>;
}

/** Liest den `retry-after`-Hinweis der API (Sekunden) aus den Headern. */
function readRetryAfterMs(error: APIError): number | undefined {
  const headers: unknown = (error as { headers?: unknown }).headers;
  const raw = readHeader(headers, 'retry-after');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds * 1000);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (isRecord(headers)) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
}

function sumOrNull(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => typeof value === 'number');
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

function excerpt(text: string, limit = 400): string {
  const clean = text.trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
