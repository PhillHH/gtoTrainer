import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicApiProvider } from '../../src/llm/api-provider.js';
import { forceClosedObjects } from '../../src/llm/api-provider.js';
import { isLlmError } from '../../src/llm/errors.js';
import { startFakeAnthropic } from './fake-anthropic-server.js';
import type { FakeAnthropic } from './fake-anthropic-server.js';
import { fakeRequest, testLlmConfig } from './helpers.js';

/**
 * Eigenschaften, die nur den API-Adapter betreffen. Das gemeinsame Verhalten
 * beider Adapter steht in `parity.test.ts`.
 */

let fakeApi: FakeAnthropic;

beforeAll(async () => {
  fakeApi = await startFakeAnthropic();
});

afterAll(async () => {
  await fakeApi.close();
});

const SECRET = 'sk-ant-geheim-darf-nirgends-auftauchen';

function provider(overrides = {}): AnthropicApiProvider {
  return new AnthropicApiProvider(
    testLlmConfig({ apiKey: SECRET, apiBaseUrl: fakeApi.baseUrl, ...overrides }),
  );
}

describe('Der API-Schluessel taucht nirgends auf', () => {
  it('nennt ihn nicht in der Auth-Fehlermeldung', async () => {
    try {
      await provider().complete(fakeRequest('auth'));
      throw new Error('Es wurde ein LlmError erwartet.');
    } catch (error) {
      if (!isLlmError(error)) throw error;
      expect(error.kind).toBe('auth');
      expect(error.message).not.toContain(SECRET);
      expect(error.message).toMatch(/bewusst nicht ausgegeben/);
    }
  });

  it('schwaerzt ihn aus, falls ein Antworttext ihn zurueckspiegelt', async () => {
    // Der Fake spiegelt den Prompt nicht, deshalb wird hier direkt geprueft,
    // dass die Ausschwaerzung greift: die Meldung des 400ers enthaelt den
    // Servertext, und der koennte im Ernstfall einen Header enthalten.
    const withSecretInBody = new AnthropicApiProvider(
      testLlmConfig({ apiKey: SECRET, apiBaseUrl: fakeApi.baseUrl }),
    );
    try {
      await withSecretInBody.complete(fakeRequest('invalid'));
      throw new Error('Es wurde ein LlmError erwartet.');
    } catch (error) {
      if (!isLlmError(error)) throw error;
      expect(error.message).not.toContain(SECRET);
    }
  });

  it('sendet ihn als Header, nicht im Rumpf', async () => {
    const before = fakeApi.seen.length;
    await provider().complete(fakeRequest('ok'));
    const seen = fakeApi.seen[before];

    expect(seen?.headers['x-api-key']).toBe(SECRET);
    expect(JSON.stringify(seen?.body)).not.toContain(SECRET);
  });
});

describe('Schema-Angleichung fuer strukturierte Ausgaben', () => {
  it('ergaenzt additionalProperties: false auf jeder Objektebene', () => {
    const normalized = forceClosedObjects({
      type: 'object',
      properties: {
        chart: {
          type: 'object',
          properties: { raise: { type: 'number' } },
          required: ['raise'],
        },
        tags: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } },
      },
      required: ['chart'],
    });

    const chart = (normalized['properties'] as Record<string, Record<string, unknown>>)['chart'];
    const items = (
      (normalized['properties'] as Record<string, Record<string, unknown>>)['tags'] as Record<
        string,
        Record<string, unknown>
      >
    )['items'];

    expect(normalized['additionalProperties']).toBe(false);
    expect(chart?.['additionalProperties']).toBe(false);
    expect(items?.['additionalProperties']).toBe(false);
  });

  it('laesst eine vorhandene Angabe unangetastet', () => {
    const normalized = forceClosedObjects({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: true,
    });
    expect(normalized['additionalProperties']).toBe(true);
  });

  it('ruehrt Objekte ohne properties nicht an', () => {
    const normalized = forceClosedObjects({ type: 'object' });
    expect('additionalProperties' in normalized).toBe(false);
  });
});

describe('Antwortzusammensetzung', () => {
  it('uebernimmt das tatsaechlich verwendete Modell aus der Antwort', async () => {
    const response = await provider().complete(fakeRequest('ok', { model: 'claude-opus-5' }));
    // Der Fake antwortet mit claude-sonnet-5 - gemeldet wird, was lief.
    expect(response.meta.model).toBe('claude-sonnet-5');
  });

  it('zaehlt zwischengespeicherte Eingabetokens zu promptTokens', async () => {
    const response = await provider().complete(fakeRequest('ok'));
    // 11 input + 5 cache_creation + 0 cache_read
    expect(response.meta.promptTokens).toBe(16);
  });
});
