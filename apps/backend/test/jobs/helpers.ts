import { sql } from 'drizzle-orm';
import type { LLMProvider, LlmRequest, LlmResponse } from '@gto/shared';
import { LlmError } from '../../src/llm/errors.js';
import { createDbCallLogSink } from '../../src/llm/call-log.js';
import { LlmProviderRegistry } from '../../src/llm/registry.js';
import { JobEventBus } from '../../src/jobs/events.js';
import { JobHandlerRegistry } from '../../src/jobs/types.js';
import { JobWorker } from '../../src/jobs/worker.js';
import { createLlmCompleteJob } from '../../src/jobs/handlers/llm-complete.js';
import { TemplateRegistry } from '../../src/prompts/registry.js';
import type { Database } from '../../src/db/client.js';
import type { JobEvent } from '@gto/shared';

/**
 * Hilfen fuer die Worker-Tests. Kein Test hier ruft ein echtes Modell auf -
 * der Provider ist eine Attrappe, die Queue dagegen die echte Tabelle.
 */

/** Steuerbarer Provider: liefert eine Antwort oder wirft einen vorgegebenen Fehler. */
export interface StubProvider extends LLMProvider {
  /** Wie oft `complete()` gerufen wurde. */
  readonly calls: LlmRequest[];
  /** Wird vor jedem Aufruf gefragt; wirft der Rueckgabewert, schlaegt der Aufruf fehl. */
  nextError: unknown;
  text: string;
}

export function createStubProvider(): StubProvider {
  const calls: LlmRequest[] = [];
  const stub: StubProvider = {
    id: 'api',
    calls,
    nextError: undefined,
    text: 'Antwort der Attrappe',
    complete<TJson>(request: LlmRequest): Promise<LlmResponse<TJson>> {
      calls.push(request);
      if (stub.nextError !== undefined) return Promise.reject(stub.nextError);
      return Promise.resolve({
        text: stub.text,
        json: null as TJson | null,
        meta: {
          provider: 'api',
          model: request.model,
          durationMs: 42,
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
        },
      });
    },
  };
  return stub;
}

export interface TestRuntime {
  readonly provider: StubProvider;
  readonly providers: LlmProviderRegistry;
  readonly events: JobEventBus;
  readonly received: JobEvent[];
  readonly worker: JobWorker;
}

/**
 * Baut Worker samt Provider-Registry auf - inklusive des zentralen
 * Aufruf-Protokolls, damit die Tests genau den Produktionspfad pruefen.
 */
export function createTestRuntime(
  db: Database,
  overrides: { readonly staleAfterMs?: number } = {},
): TestRuntime {
  const provider = createStubProvider();
  const providers = new LlmProviderRegistry({
    config: { provider: 'api' } as never,
    factory: () => provider,
    callLog: { sink: createDbCallLogSink(db) },
  });

  const events = new JobEventBus();
  const received: JobEvent[] = [];
  events.subscribe((event) => received.push(event));

  const handlers = new JobHandlerRegistry().register(
    createLlmCompleteJob({
      providers,
      templates: TemplateRegistry.load(),
      defaultModel: 'claude-sonnet-5',
      defaultMaxTokens: 512,
    }),
  );

  const worker = new JobWorker({
    db,
    handlers,
    events,
    pollIntervalMs: 10,
    staleAfterMs: overrides.staleAfterMs ?? 300_000,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 5_000,
    // Kein Jitter, damit die Wartezeiten im Test vorhersagbar sind.
    random: () => 1,
  });

  return { provider, providers, events, received, worker };
}

/** Nutzlast, die zum Beispiel-Template aus T2.4 passt. */
export function samplePayload(): Record<string, unknown> {
  return {
    templateId: 'task/concept-explanation',
    values: {
      level: 'Einsteiger',
      concept: 'Position am Tisch',
      context: 'Kontextzeile aus dem Test.',
    },
  };
}

/** Ein wiederholbarer Fehler der Taxonomie. */
export function transientError(): LlmError {
  return new LlmError({
    kind: 'transient',
    provider: 'api',
    message: 'Anthropic-API voruebergehend gestoert (529).',
  });
}

/** Ein nicht wiederholbarer Fehler der Taxonomie. */
export function authError(): LlmError {
  return new LlmError({
    kind: 'auth',
    provider: 'api',
    message: 'ANTHROPIC_API_KEY fehlt oder ist leer.',
  });
}

/** Leert Queue und Protokoll zwischen den Tests. */
export async function clearTables(db: Database): Promise<void> {
  await db.execute(sql`truncate table job_queue, llm_call_log`);
}
