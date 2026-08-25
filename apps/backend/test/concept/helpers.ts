import { sql } from 'drizzle-orm';
import type { LLMProvider, LlmRequest, LlmResponse } from '@gto/shared';
import type { Database } from '../../src/db/client.js';
import { bookAsset, bookChapter, bookSection } from '../../src/db/schema.js';
import { createDbCallLogSink } from '../../src/llm/call-log.js';
import { LlmProviderRegistry } from '../../src/llm/registry.js';
import { JobEventBus } from '../../src/jobs/events.js';
import { JobHandlerRegistry } from '../../src/jobs/types.js';
import { JobWorker } from '../../src/jobs/worker.js';
import { createConceptExtractJob } from '../../src/jobs/handlers/concept-extract.js';
import { TemplateRegistry } from '../../src/prompts/registry.js';

/**
 * Hilfen fuer die Konzept-Tests.
 *
 * Der Provider ist eine Attrappe - **kein** Test hier setzt einen echten
 * KI-Aufruf ab. Datenbank und Job-Queue sind dagegen echt, damit der Test den
 * Produktionspfad prueft.
 */

/** Provider, der eine vorgegebene JSON-Antwort liefert. */
export interface StubProvider extends LLMProvider {
  readonly calls: LlmRequest[];
  json: unknown;
  nextError: unknown;
}

export function createStubProvider(json: unknown): StubProvider {
  const calls: LlmRequest[] = [];
  const stub: StubProvider = {
    id: 'api',
    calls,
    json,
    nextError: undefined,
    complete<TJson>(request: LlmRequest): Promise<LlmResponse<TJson>> {
      calls.push(request);
      if (stub.nextError !== undefined) return Promise.reject(stub.nextError);
      return Promise.resolve({
        text: JSON.stringify(stub.json),
        json: stub.json as TJson,
        meta: {
          provider: 'api',
          model: request.model,
          durationMs: 21,
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
      });
    },
  };
  return stub;
}

export interface ConceptTestRuntime {
  readonly provider: StubProvider;
  readonly worker: JobWorker;
}

export function createConceptRuntime(db: Database, json: unknown): ConceptTestRuntime {
  const provider = createStubProvider(json);
  const providers = new LlmProviderRegistry({
    config: { provider: 'api' } as never,
    factory: () => provider,
    callLog: { sink: createDbCallLogSink(db) },
  });

  const handlers = new JobHandlerRegistry().register(
    createConceptExtractJob({
      providers,
      templates: TemplateRegistry.load(),
      defaultModel: 'claude-sonnet-5',
      maxTokens: 512,
    }),
  );

  const worker = new JobWorker({
    db,
    handlers,
    events: new JobEventBus(),
    pollIntervalMs: 10,
    staleAfterMs: 300_000,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 5_000,
    random: () => 1,
  });

  return { provider, worker };
}

/** Leert Konzept-, Buch- und Queue-Tabellen. */
export async function clearAll(db: Database): Promise<void> {
  await db.execute(
    sql`truncate table concept_chart, concept_section, concept_prerequisite, concept,
        book_asset, book_section, book_chapter, job_queue, llm_call_log cascade`,
  );
}

export interface SeededBook {
  readonly chapterIds: Record<number, string>;
  readonly sectionIds: Record<string, string>;
  readonly assetIds: Record<string, string>;
}

/**
 * Legt ein winziges Buchgeruest an: zwei Kapitel mit je zwei Sektionen und ein
 * `hand_range`-Asset. Bewusst selbst erfundener Text - Buchinhalt gehoert nicht
 * in Tests.
 */
export async function seedBook(db: Database): Promise<SeededBook> {
  const chapterIds: Record<number, string> = {};
  const sectionIds: Record<string, string> = {};
  const assetIds: Record<string, string> = {};

  for (const [number, title] of [
    [1, 'Erste Grundlagen'],
    [2, 'Zweiter Teil der Theorie'],
  ] as const) {
    const [row] = await db
      .insert(bookChapter)
      .values({
        partNumber: 1,
        partTitle: 'Testteil',
        chapterNumber: number,
        title,
        ordinal: number - 1,
        contentHash: `hash-chapter-${number}`,
      })
      .returning({ id: bookChapter.id });
    chapterIds[number] = (row as { id: string }).id;
  }

  const sections = [
    { chapter: 1, key: 'ch01/grundbegriffe', title: 'Grundbegriffe', body: 'Fixture-Text A.' },
    { chapter: 1, key: 'ch01/kennzahlen', title: 'Kennzahlen', body: 'Fixture-Text B.' },
    { chapter: 2, key: 'ch02/gleichgewicht', title: 'Gleichgewicht', body: 'Fixture-Text C.' },
    { chapter: 2, key: 'ch02/abweichung', title: 'Abweichung', body: 'Fixture-Text D.' },
  ] as const;

  let ordinal = 0;
  for (const section of sections) {
    const [row] = await db
      .insert(bookSection)
      .values({
        chapterId: chapterIds[section.chapter] as string,
        sectionKey: section.key,
        title: section.title,
        level: 2,
        ordinal: ordinal++,
        body: section.body,
        contentHash: `hash-${section.key}`,
      })
      .returning({ id: bookSection.id });
    sectionIds[section.key] = (row as { id: string }).id;
  }

  const [asset] = await db
    .insert(bookAsset)
    .values({
      relativePath: 'bilder/p0010_01.jpeg',
      fileName: 'p0010_01.jpeg',
      sectionId: sectionIds['ch01/kennzahlen'] as string,
      page: 10,
      indexOnPage: 1,
      captionRaw: '*Hand Range 1: Fixture*',
      captionLabel: 'Hand Range',
      captionNumber: 1,
      assetType: 'hand_range',
      classificationConfidence: 'certain',
      classificationRule: 'caption-label',
      ordinal: 0,
      contentHash: 'hash-asset-1',
    })
    .returning({ id: bookAsset.id });
  assetIds['p0010_01.jpeg'] = (asset as { id: string }).id;

  return { chapterIds, sectionIds, assetIds };
}

/** Antwort, wie sie das Modell laut Schema liefert. */
export function suggestionsResponse(konzepte: readonly Record<string, unknown>[]): {
  konzepte: readonly Record<string, unknown>[];
} {
  return { konzepte };
}
