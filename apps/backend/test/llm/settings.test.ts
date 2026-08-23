import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CSRF_COOKIE_NAME } from '@gto/shared';
import type { LLMProvider, LlmRequest, LlmResponse, LlmSettingsResponse } from '@gto/shared';
import { buildApp } from '../../src/app.js';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { config as configTable, llmCallLog } from '../../src/db/schema.js';
import { AnthropicApiProvider } from '../../src/llm/api-provider.js';
import { ClaudeCliProvider } from '../../src/llm/cli-provider.js';
import { createDbCallLogSink } from '../../src/llm/call-log.js';
import { LlmError } from '../../src/llm/errors.js';
import { LlmProviderRegistry } from '../../src/llm/registry.js';
import { SETTINGS_KEYS, createSettingsReader } from '../../src/llm/settings.js';
import type { LlmConfig } from '../../src/config/env.js';
import { TEST_DATABASE_URL, prepareTestDatabase } from '../db/setup.js';
import { createTestUser, login, testAuthConfig } from '../auth/helpers.js';
import type { TestContext } from '../auth/helpers.js';
import { testLlmConfig } from './helpers.js';

/**
 * Einstellungen, Validierung und Ping-Test (AP2.T2.6) - gegen die echte
 * `config`-Tabelle und einen gemockten Provider.
 */

let handle: DbHandle;
let app: FastifyInstance;
let cookieHeader: string;
let csrfToken: string;
let stub: { error: unknown; text: string; calls: LlmRequest[] };
let fallback: LlmConfig;

/** Provider-Attrappe, deren Verhalten der Test steuert. */
function createStub(): LLMProvider {
  return {
    id: 'api',
    complete<TJson>(request: LlmRequest): Promise<LlmResponse<TJson>> {
      stub.calls.push(request);
      if (stub.error !== undefined) return Promise.reject(stub.error);
      return Promise.resolve({
        text: stub.text,
        json: null as TJson | null,
        meta: {
          provider: 'api',
          model: request.model,
          durationMs: 7,
          promptTokens: 2,
          completionTokens: 1,
          totalTokens: 3,
        },
      });
    },
  };
}

beforeAll(async () => {
  await prepareTestDatabase();
  handle = createDb(TEST_DATABASE_URL, { max: 5 });
  stub = { error: undefined, text: 'OK', calls: [] };

  fallback = testLlmConfig({
    provider: 'cli',
    model: 'claude-sonnet-5',
    timeoutMs: 120_000,
    maxConcurrency: 2,
    maxAttempts: 3,
  });

  const providers = new LlmProviderRegistry({
    config: fallback,
    settings: createSettingsReader(handle.db, fallback),
    factory: (id) => (id === 'api' ? createStub() : new ClaudeCliProvider(fallback)),
    callLog: { sink: createDbCallLogSink(handle.db) },
  });

  app = await buildApp({
    db: handle.db,
    authConfig: testAuthConfig(),
    providers,
    llmConfig: fallback,
    // Im Test soll die Sperre nicht stoeren.
    pingCooldownMs: 0,
  });
  await app.ready();

  const context = { app, handle } as unknown as TestContext;
  await createTestUser(context, 'settings-nutzer', 'ein-langes-testpasswort');
  const session = await login(app, 'settings-nutzer', 'ein-langes-testpasswort');
  cookieHeader = session.cookieHeader;
  csrfToken = session.csrfToken;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(configTable);
  await handle.db.delete(llmCallLog);
  stub.error = undefined;
  stub.text = 'OK';
  stub.calls = [];
});

const authHeaders = (): Record<string, string> => ({ cookie: cookieHeader });
const writeHeaders = (): Record<string, string> => ({
  cookie: cookieHeader,
  [`x-csrf-token`]: csrfToken,
});

async function put(payload: unknown): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/llm/settings',
    headers: writeHeaders(),
    payload,
  });
  return { status: response.statusCode, body: response.json() };
}

describe('Einstellungen lesen', () => {
  it('liefert Defaults fuer nicht gesetzte Werte und weist die Herkunft aus', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/settings',
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as LlmSettingsResponse;
    expect(body.settings).toEqual({
      provider: 'cli',
      model: 'claude-sonnet-5',
      timeoutMs: 120_000,
      maxConcurrency: 2,
      maxAttempts: 3,
    });
    expect(body.origin).toEqual({
      provider: 'default',
      model: 'default',
      timeoutMs: 'default',
      maxConcurrency: 'default',
      maxAttempts: 'default',
    });
    // Die UI muss die Auswahl und die Grenzen nicht hartkodieren.
    expect(body.modelChoices.map((choice) => choice.id)).toContain('claude-opus-5');
    expect(body.ranges.timeoutMs.min).toBe(5_000);
  });

  it('gibt den API-Schluessel nie heraus, sondern nur ob einer hinterlegt ist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/settings',
      headers: authHeaders(),
    });
    const raw = response.body;

    expect(raw).not.toContain('apiKey"');
    expect((response.json() as LlmSettingsResponse).apiKeyConfigured).toBe(false);
  });
});

describe('Einstellungen schreiben', () => {
  it('persistiert die Werte in der config-Tabelle', async () => {
    const before = await handle.db
      .select()
      .from(configTable)
      .where(eq(configTable.key, SETTINGS_KEYS.provider));
    expect(before).toHaveLength(0);

    const { status, body } = await put({
      provider: 'api',
      model: 'claude-opus-5',
      timeoutMs: 90_000,
      maxConcurrency: 4,
      maxAttempts: 5,
    });

    expect(status).toBe(200);
    expect((body as LlmSettingsResponse).settings).toEqual({
      provider: 'api',
      model: 'claude-opus-5',
      timeoutMs: 90_000,
      maxConcurrency: 4,
      maxAttempts: 5,
    });
    expect((body as LlmSettingsResponse).origin.provider).toBe('config');

    const after = await handle.db.select().from(configTable);
    const stored = Object.fromEntries(after.map((row) => [row.key, row.value]));
    expect(stored[SETTINGS_KEYS.provider]).toBe('api');
    expect(stored[SETTINGS_KEYS.model]).toBe('claude-opus-5');
    expect(stored[SETTINGS_KEYS.timeoutMs]).toBe(90_000);
    expect(stored[SETTINGS_KEYS.maxConcurrency]).toBe(4);
    expect(stored[SETTINGS_KEYS.maxAttempts]).toBe(5);
  });

  it('laesst einzelne Felder setzen, ohne die anderen zu ueberschreiben', async () => {
    await put({ provider: 'api', model: 'claude-opus-5' });
    const { body } = await put({ timeoutMs: 30_000 });

    const settings = (body as LlmSettingsResponse).settings;
    expect(settings.provider).toBe('api');
    expect(settings.model).toBe('claude-opus-5');
    expect(settings.timeoutMs).toBe(30_000);
  });
});

describe('Serverseitige Validierung', () => {
  it('lehnt einen unbekannten Provider ab', async () => {
    const { status, body } = await put({ provider: 'openai' });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_settings' });
    expect((body as { fields: { field: string; message: string }[] }).fields[0]).toMatchObject({
      field: 'provider',
    });
    expect((body as { fields: { message: string }[] }).fields[0]?.message).toContain(
      'Unbekannter Provider "openai"',
    );
    // Nichts geschrieben.
    expect(await handle.db.select().from(configTable)).toHaveLength(0);
  });

  it('lehnt ein unbekanntes Modell ab', async () => {
    const { status, body } = await put({ model: 'gpt-5' });

    expect(status).toBe(400);
    const fields = (body as { fields: { field: string; message: string }[] }).fields;
    expect(fields[0]?.field).toBe('model');
    expect(fields[0]?.message).toContain('Unbekanntes Modell "gpt-5"');
  });

  it('lehnt ein Timeout ausserhalb des erlaubten Bereichs ab', async () => {
    const { status, body } = await put({ timeoutMs: 1_000 });

    expect(status).toBe(400);
    const fields = (body as { fields: { field: string; message: string }[] }).fields;
    expect(fields[0]?.field).toBe('timeoutMs');
    expect(fields[0]?.message).toContain('zwischen 5000 und 600000 liegen, ist: 1000');
  });

  it('meldet mehrere ungueltige Felder einzeln', async () => {
    const { status, body } = await put({ provider: 'x', maxConcurrency: 99, maxAttempts: 0 });

    expect(status).toBe(400);
    const fields = (body as { fields: { field: string }[] }).fields;
    expect(fields.map((entry) => entry.field).sort()).toEqual([
      'maxAttempts',
      'maxConcurrency',
      'provider',
    ]);
  });

  it('lehnt ein unbekanntes Feld ab, statt es zu ignorieren', async () => {
    const { status, body } = await put({ mastery_threshold: 0.8 });
    expect(status).toBe(400);
    expect((body as { fields: { message: string }[] }).fields[0]?.message).toContain(
      'Unbekanntes Feld "mastery_threshold"',
    );
  });

  it('faellt bei einem ungueltigen Wert in der Tabelle auf den Default zurueck, statt ihn zu benutzen', async () => {
    await handle.db.insert(configTable).values({ key: SETTINGS_KEYS.model, value: 'gpt-5' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/settings',
      headers: authHeaders(),
    });
    const body = response.json() as LlmSettingsResponse;

    expect(body.settings.model).toBe('claude-sonnet-5');
    expect(body.origin.model).toBe('default');
  });
});

describe('Zugriffsschutz', () => {
  it('liefert ohne Session 401 beim Lesen', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/llm/settings' });
    expect(response.statusCode).toBe(401);
  });

  it('liefert ohne Session 401 beim Schreiben', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/llm/settings',
      headers: { [`x-csrf-token`]: csrfToken, cookie: `${CSRF_COOKIE_NAME}=${csrfToken}` },
      payload: { provider: 'api' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('lehnt das Schreiben ohne CSRF-Token ab', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/llm/settings',
      headers: authHeaders(),
      payload: { provider: 'api' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'csrf_failed' });
    expect(await handle.db.select().from(configTable)).toHaveLength(0);
  });

  it('lehnt den Ping ohne Session ab', async () => {
    // Mit gueltigem CSRF-Token, damit wirklich die Session-Pruefung greift -
    // der CSRF-Hook laeuft davor und wuerde sonst schon 403 liefern.
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/settings/ping',
      headers: { [`x-csrf-token`]: csrfToken, cookie: `${CSRF_COOKIE_NAME}=${csrfToken}` },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('lehnt den Ping ohne CSRF-Token ab', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/settings/ping',
      headers: authHeaders(),
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'csrf_failed' });
  });
});

describe('Umschaltung wirkt ohne Neustart', () => {
  it('liefert nach dem Speichern den anderen Adapter fuer den naechsten Aufruf', async () => {
    const registry = new LlmProviderRegistry({
      config: fallback,
      settings: createSettingsReader(handle.db, fallback),
      factory: (id) => (id === 'api' ? createStub() : new ClaudeCliProvider(fallback)),
    });

    // Ohne Eintrag gilt der Default aus der Umgebung: cli.
    expect(await registry.getActive()).toBeInstanceOf(ClaudeCliProvider);

    await put({ provider: 'api' });

    // Kein Neustart, keine Codeaenderung - nur der naechste Aufruf.
    const after = await registry.getActive();
    expect(after.id).toBe('api');
    expect(after).not.toBeInstanceOf(ClaudeCliProvider);

    await put({ provider: 'cli' });
    expect(await registry.getActive()).toBeInstanceOf(ClaudeCliProvider);
  });

  it('baut den Adapter neu, wenn sich Nebenlaeufigkeit oder Versuche aendern', async () => {
    const built: LlmConfig[] = [];
    const registry = new LlmProviderRegistry({
      config: fallback,
      settings: createSettingsReader(handle.db, fallback),
      factory: (_id, config) => {
        built.push(config);
        return createStub();
      },
    });

    await put({ provider: 'api', maxConcurrency: 2 });
    await registry.getActive();
    await put({ maxConcurrency: 5 });
    await registry.getActive();

    expect(built).toHaveLength(2);
    expect(built[0]?.maxConcurrency).toBe(2);
    expect(built[1]?.maxConcurrency).toBe(5);
  });
});

describe('Ping-Test', () => {
  async function ping(body: unknown = {}): Promise<{ status: number; body: unknown }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/settings/ping',
      headers: writeHeaders(),
      payload: body,
    });
    return { status: response.statusCode, body: response.json() };
  }

  it('meldet im Erfolgsfall Provider, Modell, Dauer und die Antwort', async () => {
    await put({ provider: 'api', model: 'claude-haiku-4-5' });
    stub.text = 'OK';

    const { status, body } = await ping();

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      provider: 'api',
      model: 'claude-haiku-4-5',
      text: 'OK',
    });
    expect((body as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('bleibt sparsam: kurzer Prompt und kleines Token-Limit', async () => {
    await put({ provider: 'api' });
    await ping();

    const request = stub.calls[0];
    expect(request?.maxTokens).toBeLessThanOrEqual(1024);
    const block = request?.messages[0]?.content[0];
    expect(block?.type === 'text' ? block.text : '').toBe('Antworte nur mit OK');
  });

  it('protokolliert den Testaufruf wie jeden anderen Aufruf', async () => {
    await put({ provider: 'api' });
    const { body } = await ping();

    const calls = await handle.db.select().from(llmCallLog);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'api', status: 'success' });
    // Die Antwort verweist auf genau diesen Eintrag.
    expect((body as { callId: string }).callId).toBe(calls[0]?.id);
  });

  it('meldet im Fehlerfall die Kategorie der Taxonomie samt Hinweis', async () => {
    await put({ provider: 'api' });
    stub.error = new LlmError({
      kind: 'auth',
      provider: 'api',
      message: 'ANTHROPIC_API_KEY fehlt oder ist leer.',
    });

    const { status, body } = await ping();

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, kind: 'auth' });
    expect((body as { hint: string }).hint).toContain('ANTHROPIC_API_KEY');

    // Auch der Fehlschlag steht im Protokoll.
    const calls = await handle.db.select().from(llmCallLog);
    expect(calls[0]?.status).toBe('error');
  });

  it('unterscheidet die Kategorien - Kontingent liest sich anders als Auth', async () => {
    await put({ provider: 'api' });
    stub.error = new LlmError({ kind: 'rate_limit', provider: 'api', message: 'Limit erreicht' });

    const { body } = await ping();
    expect(body).toMatchObject({ ok: false, kind: 'rate_limit' });
    expect((body as { hint: string }).hint).toContain('Kontingent');
  });

  it('testet auf Wunsch einen anderen Provider, ohne die Einstellung zu aendern', async () => {
    await put({ provider: 'cli' });

    const { body } = await ping({ provider: 'api' });
    expect(body).toMatchObject({ ok: true, provider: 'api' });

    // Die gespeicherte Wahl ist unveraendert.
    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/settings',
      headers: authHeaders(),
    });
    expect((response.json() as LlmSettingsResponse).settings.provider).toBe('cli');
  });

  it('weist einen unbekannten Provider im Parameter ab', async () => {
    const { status, body } = await ping({ provider: 'openai' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_request' });
  });

  it('nutzt dieselben Adapter wie der Rest - kein Umweg an der Registry vorbei', async () => {
    await put({ provider: 'api' });
    await ping();
    // Der Aufruf ging durch die Attrappe der Registry-Fabrik.
    expect(stub.calls).toHaveLength(1);
  });
});

describe('Missbrauchsschutz des Ping-Tests', () => {
  it('bremst zu schnelle Wiederholungen, damit kein Kontingent verpufft', async () => {
    const guarded = await buildApp({
      db: handle.db,
      authConfig: testAuthConfig(),
      providers: new LlmProviderRegistry({
        config: fallback,
        settings: createSettingsReader(handle.db, fallback),
        factory: () => createStub(),
      }),
      llmConfig: fallback,
      pingCooldownMs: 60_000,
    });
    await guarded.ready();

    try {
      const first = await guarded.inject({
        method: 'POST',
        url: '/api/llm/settings/ping',
        headers: writeHeaders(),
        payload: {},
      });
      expect(first.statusCode).toBe(200);

      const second = await guarded.inject({
        method: 'POST',
        url: '/api/llm/settings/ping',
        headers: writeHeaders(),
        payload: {},
      });
      expect(second.statusCode).toBe(429);
      expect(second.json()).toMatchObject({ error: 'rate_limited' });
      expect((second.json() as { message: string }).message).toContain('Kontingent');
    } finally {
      await guarded.close();
    }
  });
});

/** Nur zur Absicherung: Der API-Adapter bleibt konstruierbar. */
describe('Adapterwahl', () => {
  it('baut fuer "api" den API-Adapter, wenn ein Schluessel vorliegt', () => {
    const registry = new LlmProviderRegistry({
      config: testLlmConfig({ apiKey: 'test-key', apiBaseUrl: 'http://127.0.0.1:1' }),
    });
    expect(registry.get('api')).toBeInstanceOf(AnthropicApiProvider);
  });
});
