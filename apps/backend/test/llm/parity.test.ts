import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LLMProvider, LlmErrorKind, LlmRequest } from '@gto/shared';
import { isLlmErrorRetryable } from '@gto/shared';
import { AnthropicApiProvider } from '../../src/llm/api-provider.js';
import { ClaudeCliProvider } from '../../src/llm/cli-provider.js';
import { isLlmError } from '../../src/llm/errors.js';
import type { LlmConfig } from '../../src/config/env.js';
import { startFakeAnthropic } from './fake-anthropic-server.js';
import type { FakeAnthropic } from './fake-anthropic-server.js';
import { fakeRequest, testLlmConfig } from './helpers.js';

/**
 * Paritaetstests: **dieselbe** Suite gegen **beide** Adapter.
 *
 * Beide Inszenierungen werden ueber dieselbe Direktive im Prompt gesteuert
 * (`FAKE:<modus>`) - beim CLI-Adapter liest sie `fake-claude.mjs`, beim
 * API-Adapter der gefaelschte HTTP-Endpunkt. Ein Aufrufer darf nicht wissen
 * muessen, welcher Adapter darunter liegt; genau das prueft diese Datei.
 *
 * Ein dritter Adapter laesst sich anhaengen, indem er einen weiteren Eintrag
 * in `ADAPTERS` bekommt - die Testfaelle bleiben unveraendert.
 */

interface AdapterCase {
  readonly name: string;
  /** Wird nach dem Start des Fake-Servers aufgerufen. */
  readonly create: (overrides: Partial<LlmConfig>) => LLMProvider;
}

let fakeApi: FakeAnthropic;

beforeAll(async () => {
  fakeApi = await startFakeAnthropic();
});

afterAll(async () => {
  await fakeApi.close();
});

const ADAPTERS: readonly AdapterCase[] = [
  {
    name: 'cli',
    create: (overrides) => new ClaudeCliProvider(testLlmConfig(overrides)),
  },
  {
    name: 'api',
    create: (overrides) =>
      new AnthropicApiProvider(
        testLlmConfig({ apiKey: 'test-key', apiBaseUrl: fakeApi.baseUrl, ...overrides }),
      ),
  },
];

/** Erwartet einen `LlmError` und liefert Kategorie samt Retry-Einstufung. */
async function expectLlmError(
  promise: Promise<unknown>,
): Promise<{ kind: LlmErrorKind; retryable: boolean; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (!isLlmError(error)) throw error;
    return { kind: error.kind, retryable: error.retryable, message: error.message };
  }
  throw new Error('Es wurde ein LlmError erwartet, der Aufruf war aber erfolgreich.');
}

const COLOR_SCHEMA = {
  type: 'object',
  properties: { farbe: { type: 'string' } },
  required: ['farbe'],
} as const;

describe.each(ADAPTERS)('Paritaet [$name]', ({ name, create }) => {
  it('Erfolgsfall Text: liefert Text, json === null und vollstaendige meta', async () => {
    const response = await create({}).complete(fakeRequest('ok'));

    expect(response.text).toBe('OK');
    expect(response.json).toBeNull();
    expect(response.meta.provider).toBe(name);
    expect(typeof response.meta.model).toBe('string');
    expect(response.meta.model.length).toBeGreaterThan(0);
    expect(response.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(response.meta.promptTokens).toBe(16);
    expect(response.meta.completionTokens).toBe(7);
    expect(response.meta.totalTokens).toBe(23);
    expect(Object.keys(response.meta).sort()).toEqual([
      'completionTokens',
      'durationMs',
      'model',
      'promptTokens',
      'provider',
      'totalTokens',
    ]);
  });

  it('Erfolgsfall jsonSchema: liefert geparste, schema-konforme Nutzlast', async () => {
    const response = await create({}).complete(fakeRequest('json', { jsonSchema: COLOR_SCHEMA }));
    expect(response.json).toEqual({ farbe: 'blau' });
    expect(response.meta.provider).toBe(name);
  });

  it('Erfolgsfall jsonSchema: loest die Nutzlast auch aus einem Code-Fence', async () => {
    const response = await create({}).complete(fakeRequest('fence', { jsonSchema: COLOR_SCHEMA }));
    expect(response.json).toEqual({ farbe: 'blau' });
  });

  it('Erfolgsfall jsonSchema: loest die Nutzlast auch aus Wrapper-Text', async () => {
    const response = await create({}).complete(
      fakeRequest('wrapper', { jsonSchema: COLOR_SCHEMA }),
    );
    expect(response.json).toEqual({ farbe: 'blau' });
  });

  it('Bild-Input: nimmt einen Request mit Base64-Bild an', async () => {
    const request: LlmRequest = {
      system: 'Du digitalisierst GTO-Charts.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'FAKE:ok' },
            { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
          ],
        },
      ],
      model: 'claude-sonnet-5',
      maxTokens: 64,
    };

    const response = await create({}).complete(request);
    expect(response.text).toBe('OK');
    expect(response.meta.provider).toBe(name);
  });

  it('Fehler timeout: gleiche Kategorie, wiederholbar', async () => {
    const error = await expectLlmError(create({ timeoutMs: 400 }).complete(fakeRequest('hang')));
    expect(error.kind).toBe('timeout');
    expect(error.retryable).toBe(isLlmErrorRetryable('timeout'));
  });

  it('Fehler rate_limit: gleiche Kategorie, wiederholbar', async () => {
    const error = await expectLlmError(create({}).complete(fakeRequest('ratelimit')));
    expect(error.kind).toBe('rate_limit');
    expect(error.retryable).toBe(true);
  });

  it('Fehler auth: gleiche Kategorie, nicht wiederholbar', async () => {
    const error = await expectLlmError(create({}).complete(fakeRequest('auth')));
    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
  });

  it('Fehler transient: gleiche Kategorie, wiederholbar', async () => {
    const error = await expectLlmError(create({}).complete(fakeRequest('transient')));
    expect(error.kind).toBe('transient');
    expect(error.retryable).toBe(true);
  });

  it('Fehler invalid: gleiche Kategorie, nicht wiederholbar', async () => {
    const error = await expectLlmError(create({}).complete(fakeRequest('invalid')));
    expect(error.kind).toBe('invalid');
    expect(error.retryable).toBe(false);
  });

  it('Fehler parse: fehlende Nutzlast trotz Schema, nicht wiederholbar', async () => {
    const error = await expectLlmError(
      create({}).complete(fakeRequest('garbage', { jsonSchema: COLOR_SCHEMA })),
    );
    expect(error.kind).toBe('parse');
    expect(error.retryable).toBe(false);
  });

  it('Fehler parse: Schemaverstoss, nicht wiederholbar', async () => {
    const error = await expectLlmError(
      create({}).complete(fakeRequest('schema-violation', { jsonSchema: COLOR_SCHEMA })),
    );
    expect(error.kind).toBe('parse');
    expect(error.retryable).toBe(false);
  });

  it('Unbekannter Fehler wird nicht wiederholbar eingestuft', async () => {
    const error = await expectLlmError(create({}).complete(fakeRequest('unknown')));
    expect(error.retryable).toBe(false);
  });

  it('Anfrage ohne Nachricht wird vor jedem Aufruf abgewiesen', async () => {
    const error = await expectLlmError(create({}).complete(fakeRequest('ok', { messages: [] })));
    expect(error.kind).toBe('invalid');
  });

  it('Nebenlaeufigkeit ist begrenzt - beide Adapter teilen sich die Semaphore', async () => {
    const provider = create({ maxConcurrency: 1, timeoutMs: 10_000 });
    await Promise.all([
      provider.complete(fakeRequest('slow|delay=60')),
      provider.complete(fakeRequest('slow|delay=60')),
    ]);
    expect((provider as { inFlight: number }).inFlight).toBe(0);
  });
});

describe('Besonderheiten, die nur ein Adapter zeigen kann', () => {
  it('API-Adapter setzt alle Textbloecke zusammen, nicht nur den ersten', async () => {
    const provider = new AnthropicApiProvider(
      testLlmConfig({ apiKey: 'test-key', apiBaseUrl: fakeApi.baseUrl }),
    );
    const response = await provider.complete(fakeRequest('multiblock'));
    expect(response.text).toBe('Teil eins. Teil zwei.');
  });

  it('API-Adapter uebernimmt den retry-after-Hinweis der Antwort', async () => {
    const provider = new AnthropicApiProvider(
      testLlmConfig({ apiKey: 'test-key', apiBaseUrl: fakeApi.baseUrl }),
    );
    try {
      await provider.complete(fakeRequest('ratelimit'));
      throw new Error('Es wurde ein LlmError erwartet.');
    } catch (error) {
      if (!isLlmError(error)) throw error;
      expect(error.retryAfterMs).toBe(42_000);
    }
  });

  it('API-Adapter schickt Schema und Bild in der erwarteten Form', async () => {
    const provider = new AnthropicApiProvider(
      testLlmConfig({ apiKey: 'test-key', apiBaseUrl: fakeApi.baseUrl }),
    );
    const before = fakeApi.seen.length;

    await provider.complete({
      system: 'Persona',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'FAKE:json' },
            { type: 'image', mediaType: 'image/png', data: 'AAAA' },
          ],
        },
      ],
      model: 'claude-sonnet-5',
      maxTokens: 64,
      jsonSchema: COLOR_SCHEMA,
    });

    const sent = fakeApi.seen[before]?.body as {
      system: string;
      max_tokens: number;
      output_config: { format: { type: string; schema: Record<string, unknown> } };
      messages: { role: string; content: { type: string; source?: Record<string, string> }[] }[];
    };

    expect(sent.system).toBe('Persona');
    expect(sent.max_tokens).toBe(64);
    expect(sent.output_config.format.type).toBe('json_schema');
    // Strukturierte Ausgaben verlangen geschlossene Objekte - der Adapter
    // ergaenzt das, damit derselbe Request bei beiden Adaptern laeuft.
    expect(sent.output_config.format.schema['additionalProperties']).toBe(false);
    expect(sent.messages[0]?.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });
});
