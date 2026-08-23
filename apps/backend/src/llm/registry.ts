import { eq } from 'drizzle-orm';
import { isLlmProviderId } from '@gto/shared';
import type { LLMProvider, LlmProviderId } from '@gto/shared';
import { loadLlmConfig } from '../config/env.js';
import type { LlmConfig } from '../config/env.js';
import { config as configTable } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { createAnthropicApiProvider } from './api-provider.js';
import { createClaudeCliProvider } from './cli-provider.js';
import { LlmError } from './errors.js';

/**
 * Provider-Registry - **der einzige Weg**, an einen `LLMProvider` zu kommen.
 *
 * Fachliche Module instanziieren keinen Adapter direkt. Welcher Adapter aktiv
 * ist, entscheidet die Konfiguration:
 *
 * 1. Der Schluessel `llm.provider` in der `config`-Tabelle (Laufzeit; ab T2.6
 *    ueber die Einstellungen setzbar).
 * 2. Faellt der weg oder ist er nicht gesetzt: `LLM_PROVIDER` aus der Umgebung.
 * 3. Ohne beides: `cli`.
 *
 * Die Tabelle wird bei **jedem** Aufruf gelesen. Eine Umschaltung wirkt damit
 * ab dem naechsten Aufruf, ohne Neustart und ohne Codeaenderung. Ein
 * ungueltiger Wert ist ein Fehler mit klarer Meldung, kein stiller Default.
 */

/** Schluessel in der `config`-Tabelle, der den aktiven Provider traegt. */
export const LLM_PROVIDER_CONFIG_KEY = 'llm.provider';

/** Woher die Laufzeitwahl kommt. Ohne Quelle gilt allein die Umgebung. */
export interface ProviderConfigSource {
  /** Rohwert aus der Konfiguration; `undefined`/`null` = nicht gesetzt. */
  readActiveProviderId(): Promise<unknown>;
}

/** Liest `llm.provider` aus der `config`-Tabelle. */
export function createDbConfigSource(db: Database): ProviderConfigSource {
  return {
    async readActiveProviderId(): Promise<unknown> {
      const rows = await db
        .select({ value: configTable.value })
        .from(configTable)
        .where(eq(configTable.key, LLM_PROVIDER_CONFIG_KEY))
        .limit(1);
      return rows[0]?.value;
    },
  };
}

/** Baut einen Adapter zu einer Kennung. Austauschbar fuer Tests. */
export type ProviderFactory = (id: LlmProviderId, config: LlmConfig) => LLMProvider;

const defaultFactory: ProviderFactory = (id, config) => {
  switch (id) {
    case 'cli':
      return createClaudeCliProvider(config);
    case 'api':
      return createAnthropicApiProvider(config);
    default: {
      // Eine neue Kennung in `LLM_PROVIDER_IDS` ohne Fabrik bricht hier die
      // Uebersetzung, nicht erst den Betrieb.
      const exhaustive: never = id;
      return exhaustive;
    }
  }
};

export interface RegistryOptions {
  readonly config?: LlmConfig;
  readonly source?: ProviderConfigSource;
  readonly factory?: ProviderFactory;
}

export class LlmProviderRegistry {
  readonly #config: LlmConfig;
  readonly #source: ProviderConfigSource | undefined;
  readonly #factory: ProviderFactory;
  /** Adapter werden einmal gebaut und wiederverwendet - die Semaphore je
   *  Adapter soll ueber Aufrufe hinweg gelten. */
  readonly #cache = new Map<LlmProviderId, LLMProvider>();

  constructor(options: RegistryOptions = {}) {
    this.#config = options.config ?? loadLlmConfig();
    this.#source = options.source;
    this.#factory = options.factory ?? defaultFactory;
  }

  /** Kennung des gerade aktiven Providers. */
  async activeProviderId(): Promise<LlmProviderId> {
    const raw = await this.#source?.readActiveProviderId();
    if (raw === undefined || raw === null || raw === '') {
      return this.#config.provider ?? 'cli';
    }
    if (!isLlmProviderId(raw)) {
      throw new LlmError({
        kind: 'invalid',
        provider: this.#config.provider ?? 'cli',
        message:
          `Der Konfigurationswert ${LLM_PROVIDER_CONFIG_KEY} = ${JSON.stringify(raw)} ist kein ` +
          'bekannter Provider. Erlaubt sind "cli" und "api".',
      });
    }
    return raw;
  }

  /** Der aktive Provider. Wird je Aufruf neu ermittelt. */
  async getActive(): Promise<LLMProvider> {
    return this.get(await this.activeProviderId());
  }

  /** Ein bestimmter Adapter - fuer Paritaetstests und den Ping-Test aus T2.6. */
  get(id: LlmProviderId): LLMProvider {
    const cached = this.#cache.get(id);
    if (cached !== undefined) return cached;
    const created = this.#factory(id, this.#config);
    this.#cache.set(id, created);
    return created;
  }
}
