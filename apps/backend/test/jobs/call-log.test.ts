import { describe, expect, it } from 'vitest';
import { LLM_LOG_TRUNCATION_MARKER } from '@gto/shared';
import type { LLMProvider, LlmRequest, LlmResponse } from '@gto/shared';
import { formatPrompt, truncate, withCallLog } from '../../src/llm/call-log.js';
import type { CallLogSink } from '../../src/llm/call-log.js';
import { LlmProviderRegistry } from '../../src/llm/registry.js';
import { LlmError } from '../../src/llm/errors.js';

/**
 * Das Aufruf-Protokoll liegt **zentral** um jeden Adapter. Diese Tests
 * brauchen keine Datenbank - die Senke ist eine Attrappe.
 */

interface Recorded {
  readonly id: string;
  readonly started: { provider: string; model: string; prompt: string };
  finished?: Record<string, unknown>;
}

function recordingSink(options: { failStart?: boolean; failFinish?: boolean } = {}): {
  sink: CallLogSink;
  entries: Recorded[];
} {
  const entries: Recorded[] = [];
  const sink: CallLogSink = {
    start(entry) {
      if (options.failStart === true) return Promise.reject(new Error('Tabelle nicht erreichbar'));
      const id = `call-${entries.length + 1}`;
      entries.push({ id, started: { ...entry } });
      return Promise.resolve(id);
    },
    finish(id, entry) {
      if (options.failFinish === true) return Promise.reject(new Error('Update fehlgeschlagen'));
      const found = entries.find((candidate) => candidate.id === id);
      if (found !== undefined) found.finished = { ...entry };
      return Promise.resolve();
    },
  };
  return { sink, entries };
}

function stub(behaviour: { error?: unknown; text?: string } = {}): LLMProvider {
  return {
    id: 'api',
    complete<TJson>(_request: LlmRequest): Promise<LlmResponse<TJson>> {
      if (behaviour.error !== undefined) return Promise.reject(behaviour.error);
      return Promise.resolve({
        text: behaviour.text ?? 'OK',
        json: null as TJson | null,
        meta: {
          provider: 'api',
          model: 'claude-haiku-4-5',
          durationMs: 5,
          promptTokens: 3,
          completionTokens: 2,
          totalTokens: 5,
        },
      });
    },
  };
}

const REQUEST: LlmRequest = {
  system: 'Persona',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Frage' }] }],
  model: 'claude-sonnet-5',
  maxTokens: 64,
};

describe('Jeder Aufruf wird protokolliert', () => {
  it('haelt einen erfolgreichen Aufruf mit Modell, Dauer und Tokenzahlen fest', async () => {
    const { sink, entries } = recordingSink();
    await withCallLog(stub(), { sink }).complete(REQUEST);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.started).toMatchObject({ provider: 'api', model: 'claude-sonnet-5' });
    expect(entries[0]?.finished).toMatchObject({
      status: 'success',
      // Gemeldet wird das Modell, das tatsaechlich geantwortet hat.
      model: 'claude-haiku-4-5',
      response: 'OK',
      durationMs: 5,
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });
  });

  it('protokolliert auch einen fehlgeschlagenen Aufruf - gerade den', async () => {
    const { sink, entries } = recordingSink();
    const failing = withCallLog(
      stub({ error: new LlmError({ kind: 'rate_limit', provider: 'api', message: 'Limit' }) }),
      { sink },
    );

    await expect(failing.complete(REQUEST)).rejects.toThrow('Limit');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.finished).toMatchObject({ status: 'error' });
    expect(String(entries[0]?.finished?.['error'])).toContain('rate_limit: Limit');
  });

  it('reicht den Fehler unveraendert weiter - die Taxonomie bleibt erhalten', async () => {
    const { sink } = recordingSink();
    const failing = withCallLog(
      stub({ error: new LlmError({ kind: 'timeout', provider: 'api', message: 'zu langsam' }) }),
      { sink },
    );

    await expect(failing.complete(REQUEST)).rejects.toSatisfy(
      (error: unknown) => error instanceof LlmError && error.kind === 'timeout',
    );
  });

  it('laesst den Aufruf nicht scheitern, wenn das Protokoll versagt', async () => {
    const failures: unknown[] = [];
    const { sink } = recordingSink({ failStart: true });

    const response = await withCallLog(stub(), {
      sink,
      onLogFailure: (error) => failures.push(error),
    }).complete(REQUEST);

    expect(response.text).toBe('OK');
    expect(failures).toHaveLength(1);
  });

  it('laesst den Aufruf auch dann durch, wenn nur das Abschliessen versagt', async () => {
    const failures: unknown[] = [];
    const { sink } = recordingSink({ failFinish: true });

    const response = await withCallLog(stub(), {
      sink,
      onLogFailure: (error) => failures.push(error),
    }).complete(REQUEST);

    expect(response.text).toBe('OK');
    expect(failures).toHaveLength(1);
  });
});

describe('Die Registry protokolliert zentral', () => {
  it('legt das Protokoll um jeden Adapter, den sie herausgibt', async () => {
    const { sink, entries } = recordingSink();
    const registry = new LlmProviderRegistry({
      config: { provider: 'api' } as never,
      factory: () => stub(),
      callLog: { sink },
    });

    // Ein Aufrufer, der nur die Registry kennt, protokolliert automatisch mit.
    await (await registry.getActive()).complete(REQUEST);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.finished).toMatchObject({ status: 'success' });
  });

  it('protokolliert nicht, wenn keine Senke gesetzt ist (Paritaetstests aus T2.3)', async () => {
    const registry = new LlmProviderRegistry({
      config: { provider: 'api' } as never,
      factory: () => stub(),
    });
    await expect((await registry.getActive()).complete(REQUEST)).resolves.toMatchObject({
      text: 'OK',
    });
  });
});

describe('Grosse Inhalte sprengen die Tabelle nicht', () => {
  it('kuerzt sichtbar und nennt, wie viel fehlt', () => {
    const long = 'x'.repeat(100);
    const short = truncate(long, 10);

    expect(short.startsWith('x'.repeat(10))).toBe(true);
    expect(short).toContain(LLM_LOG_TRUNCATION_MARKER);
    expect(short).toContain('90 von 100 Zeichen entfernt');
  });

  it('laesst kurze Inhalte unangetastet', () => {
    expect(truncate('kurz', 100)).toBe('kurz');
  });

  it('schreibt Bilder nie im Klartext, sondern als Kurzvermerk', () => {
    const withImage: LlmRequest = {
      system: 'Persona',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Lies das Chart.' },
            { type: 'image', mediaType: 'image/png', data: 'A'.repeat(50_000) },
          ],
        },
      ],
      model: 'claude-sonnet-5',
      maxTokens: 1024,
    };

    const formatted = formatPrompt(withImage);

    expect(formatted).not.toContain('A'.repeat(100));
    expect(formatted).toContain('[bild image/png, 50000 Zeichen base64 - nicht protokolliert]');
    // Ohne diesen Schutz waere allein AP3 mit rund 336 Bildern nicht tragbar.
    expect(formatted.length).toBeLessThan(500);
  });

  it('nimmt das JSON-Schema mit auf, damit der Aufruf nachvollziehbar bleibt', () => {
    const formatted = formatPrompt({ ...REQUEST, jsonSchema: { type: 'object' } });
    expect(formatted).toContain('[jsonSchema]');
    expect(formatted).toContain('{"type":"object"}');
  });

  it('kuerzt einen ueberlangen Prompt beim Protokollieren', async () => {
    const { sink, entries } = recordingSink();
    await withCallLog(stub(), { sink, maxChars: 50 }).complete({
      ...REQUEST,
      system: 'y'.repeat(5_000),
    });

    const prompt = entries[0]?.started.prompt ?? '';
    expect(prompt.length).toBeLessThan(200);
    expect(prompt).toContain(LLM_LOG_TRUNCATION_MARKER);
  });
});
