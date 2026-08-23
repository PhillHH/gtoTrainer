import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LLMProvider, LlmProviderId } from '@gto/shared';
import { AnthropicApiProvider, createAnthropicApiProvider } from '../../src/llm/api-provider.js';
import { ClaudeCliProvider } from '../../src/llm/cli-provider.js';
import { isLlmError } from '../../src/llm/errors.js';
import {
  LLM_PROVIDER_CONFIG_KEY,
  LlmProviderRegistry,
  createDbConfigSource,
} from '../../src/llm/registry.js';
import type { ProviderConfigSource } from '../../src/llm/registry.js';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { config as configTable } from '../../src/db/schema.js';
import { TEST_DATABASE_URL, prepareTestDatabase } from '../db/setup.js';
import { testLlmConfig } from './helpers.js';

/**
 * Die Registry ist der einzige Weg zu einem Provider. Diese Tests belegen,
 * dass die Wahl aus der Konfiguration kommt - nicht aus dem Code.
 */

/** Quelle, deren Wert der Test zwischen zwei Aufrufen aendern kann. */
function mutableSource(initial: unknown): ProviderConfigSource & { value: unknown } {
  return {
    value: initial,
    readActiveProviderId(): Promise<unknown> {
      return Promise.resolve(this.value);
    },
  };
}

function registry(source: ProviderConfigSource | undefined, provider?: LlmProviderId) {
  return new LlmProviderRegistry({
    config: testLlmConfig({
      apiKey: 'test-key',
      apiBaseUrl: 'http://127.0.0.1:1',
      ...(provider === undefined ? {} : { provider }),
    }),
    ...(source === undefined ? {} : { source }),
  });
}

describe('Provider-Auswahl aus der Konfiguration', () => {
  it('liefert den in der Konfiguration hinterlegten Adapter', async () => {
    await expect(registry(mutableSource('cli')).getActive()).resolves.toBeInstanceOf(
      ClaudeCliProvider,
    );
    await expect(registry(mutableSource('api')).getActive()).resolves.toBeInstanceOf(
      AnthropicApiProvider,
    );
  });

  it('schaltet ohne Neustart um: der naechste Aufruf nutzt den neuen Wert', async () => {
    const source = mutableSource('cli');
    const registryUnderTest = registry(source);

    const first = await registryUnderTest.getActive();
    expect(first.id).toBe('cli');

    // Genau das, was T2.6 spaeter ueber die Oberflaeche tut.
    source.value = 'api';

    const second = await registryUnderTest.getActive();
    expect(second.id).toBe('api');
    expect(second).not.toBe(first);
  });

  it('faellt ohne Wert in der Tabelle auf den Startwert aus der Umgebung zurueck', async () => {
    await expect(registry(mutableSource(null), 'api').activeProviderId()).resolves.toBe('api');
    await expect(registry(mutableSource(undefined), 'cli').activeProviderId()).resolves.toBe('cli');
  });

  it('nutzt ohne Konfigurationsquelle allein den Startwert', async () => {
    await expect(registry(undefined, 'api').activeProviderId()).resolves.toBe('api');
  });

  it('meldet einen ungueltigen Wert klar, statt still auf einen Default zu fallen', async () => {
    const failing = registry(mutableSource('openai'));
    await expect(failing.getActive()).rejects.toSatisfy(
      (error: unknown) =>
        isLlmError(error) &&
        error.kind === 'invalid' &&
        /llm\.provider = "openai"/.test(error.message) &&
        /"cli" und "api"/.test(error.message),
    );
  });

  it('gibt denselben Adapter wieder aus - die Semaphore gilt ueber Aufrufe hinweg', () => {
    const registryUnderTest = registry(mutableSource('cli'));
    expect(registryUnderTest.get('cli')).toBe(registryUnderTest.get('cli'));
  });

  it('reicht einen Adapter-Bau-Fehler unveraendert durch', async () => {
    const withoutKey = new LlmProviderRegistry({
      config: testLlmConfig({ provider: 'api' }),
      source: mutableSource('api'),
    });
    await expect(withoutKey.getActive()).rejects.toSatisfy(
      (error: unknown) => isLlmError(error) && error.kind === 'auth',
    );
  });

  it('erlaubt eine eigene Fabrik, damit ein dritter Adapter andocken kann', async () => {
    const stub: LLMProvider = {
      id: 'api',
      complete: () => Promise.reject(new Error('nicht aufgerufen')),
    };
    const custom = new LlmProviderRegistry({
      config: testLlmConfig(),
      source: mutableSource('api'),
      factory: () => stub,
    });
    await expect(custom.getActive()).resolves.toBe(stub);
  });
});

describe('API-Adapter ohne Schluessel', () => {
  it('bricht beim Bau mit Kategorie auth und einer handlungsanweisenden Meldung ab', () => {
    let caught: unknown;
    try {
      createAnthropicApiProvider(testLlmConfig({ provider: 'api' }));
    } catch (error) {
      caught = error;
    }

    expect(isLlmError(caught)).toBe(true);
    if (!isLlmError(caught)) return;
    expect(caught.kind).toBe('auth');
    expect(caught.retryable).toBe(false);
    expect(caught.message).toMatch(/ANTHROPIC_API_KEY fehlt oder ist leer/);
    expect(caught.message).toMatch(/llm\.provider auf "cli" zurueck/);
  });

  it('stoert den CLI-Betrieb nicht: ohne Schluessel bleibt cli voll nutzbar', async () => {
    const withoutKey = new LlmProviderRegistry({
      config: testLlmConfig({ provider: 'cli' }),
      source: mutableSource('cli'),
    });
    const provider = await withoutKey.getActive();
    expect(provider.id).toBe('cli');

    const response = await provider.complete({
      system: 'Antworte knapp.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'FAKE:ok' }] }],
      model: 'claude-sonnet-5',
      maxTokens: 64,
    });
    expect(response.text).toBe('OK');
  });
});

describe('Konfigurationsquelle: config-Tabelle', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    await prepareTestDatabase();
    handle = createDb(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('liest llm.provider aus der Tabelle und wirkt sofort auf die Registry', async () => {
    const source = createDbConfigSource(handle.db);
    const registryUnderTest = new LlmProviderRegistry({
      config: testLlmConfig({ apiKey: 'test-key', apiBaseUrl: 'http://127.0.0.1:1' }),
      source,
    });

    await handle.db
      .insert(configTable)
      .values({ key: LLM_PROVIDER_CONFIG_KEY, value: 'cli' })
      .onConflictDoUpdate({ target: configTable.key, set: { value: 'cli' } });
    await expect(registryUnderTest.activeProviderId()).resolves.toBe('cli');

    // Umschaltung wie sie T2.6 vornimmt - kein Neustart, keine Codeaenderung.
    await handle.db
      .update(configTable)
      .set({ value: 'api' })
      .where(eq(configTable.key, LLM_PROVIDER_CONFIG_KEY));
    await expect(registryUnderTest.activeProviderId()).resolves.toBe('api');
    await expect(registryUnderTest.getActive()).resolves.toBeInstanceOf(AnthropicApiProvider);
  });
});
