import { sql } from 'drizzle-orm';
import { CHART_HANDS } from '@gto/shared';
import type { LLMProvider, LlmRequest, LlmResponse } from '@gto/shared';
import type { Database } from '../../src/db/client.js';
import { bookAsset, bookChapter, bookSection } from '../../src/db/schema.js';
import { createDbCallLogSink } from '../../src/llm/call-log.js';
import { LlmProviderRegistry } from '../../src/llm/registry.js';
import { JobEventBus } from '../../src/jobs/events.js';
import { JobHandlerRegistry } from '../../src/jobs/types.js';
import { JobWorker } from '../../src/jobs/worker.js';
import { createChartDigitizeJob } from '../../src/jobs/handlers/chart-digitize.js';
import { createChartLegendJob } from '../../src/jobs/handlers/chart-legend.js';
import { createChartRecheckJob } from '../../src/jobs/handlers/chart-recheck.js';
import { TemplateRegistry } from '../../src/prompts/registry.js';
import { MINI_BOOK } from '../book/fixtures.js';

/**
 * Hilfen fuer die Chart-Tests.
 *
 * Der Provider ist eine Attrappe - **kein** Test hier setzt einen echten
 * Vision-Aufruf ab. Datenbank, Queue und Ereignisbus sind echt.
 */

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
          durationMs: 33,
          promptTokens: 2000,
          completionTokens: 4000,
          totalTokens: 6000,
        },
      });
    },
  };
  return stub;
}

export interface ChartTestRuntime {
  readonly provider: StubProvider;
  readonly worker: JobWorker;
  readonly events: JobEventBus;
  readonly received: { jobType: string; status: string }[];
}

export function createChartRuntime(db: Database, json: unknown): ChartTestRuntime {
  const provider = createStubProvider(json);
  const providers = new LlmProviderRegistry({
    config: { provider: 'api' } as never,
    factory: () => provider,
    callLog: { sink: createDbCallLogSink(db) },
  });

  const events = new JobEventBus();
  const received: { jobType: string; status: string }[] = [];
  events.subscribe((event) => received.push({ jobType: event.jobType, status: event.status }));

  const handlers = new JobHandlerRegistry()
    .register(
      createChartLegendJob({
        providers,
        templates: TemplateRegistry.load(),
        defaultModel: 'claude-sonnet-5',
        maxTokens: 256,
        sourceDir: MINI_BOOK,
      }),
    )
    .register(
      createChartRecheckJob({
        providers,
        templates: TemplateRegistry.load(),
        defaultModel: 'claude-sonnet-5',
        maxTokens: 512,
        sourceDir: MINI_BOOK,
      }),
    )
    .register(
      createChartDigitizeJob({
        providers,
        templates: TemplateRegistry.load(),
        defaultModel: 'claude-sonnet-5',
        maxTokens: 512,
        // Bilder kommen aus den T3.1-Fixtures - echte Buchbilder gehoeren nicht
        // in einen Test, und in der CI liegen sie ohnehin nicht vor.
        sourceDir: MINI_BOOK,
      }),
    );

  const worker = new JobWorker({
    db,
    handlers,
    events,
    pollIntervalMs: 10,
    staleAfterMs: 300_000,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 5_000,
    random: () => 1,
  });

  return { provider, worker, events, received };
}

/** Leert alle Tabellen, die die Chart-Tests anfassen. */
export async function clearAll(db: Database): Promise<void> {
  await db.execute(
    sql`truncate table chart_finding, chart_recheck, range_chart_cell, range_chart, book_asset,
        book_section, book_chapter, job_queue, llm_call_log cascade`,
  );
}

export interface SeededAssets {
  readonly handRange: string;
  readonly handRangeUncertain: string;
  readonly table: string;
}

/**
 * Legt ein Minimalbuch mit drei Assets an: ein sicheres `hand_range`, ein
 * unsicher klassifiziertes `hand_range` und eine `table`.
 *
 * Die Bilddateien zeigen auf die Test-Fixtures aus T3.1 - echte Buchbilder
 * gehoeren nicht in Tests.
 */
export async function seedAssets(db: Database): Promise<SeededAssets> {
  const [chapter] = await db
    .insert(bookChapter)
    .values({
      partNumber: 1,
      partTitle: 'Testteil',
      chapterNumber: 1,
      title: 'Testkapitel',
      ordinal: 0,
      contentHash: 'hash-chapter',
    })
    .returning({ id: bookChapter.id });

  const [section] = await db
    .insert(bookSection)
    .values({
      chapterId: (chapter as { id: string }).id,
      sectionKey: 'ch01/testabschnitt',
      title: 'Testabschnitt',
      level: 2,
      ordinal: 0,
      body: 'Fixture-Text.',
      contentHash: 'hash-section',
    })
    .returning({ id: bookSection.id });

  const sectionId = (section as { id: string }).id;

  const insert = async (
    fileName: string,
    assetType: string,
    confidence: string,
    ordinal: number,
    caption: string | null,
    captionActions: unknown[],
  ): Promise<string> => {
    const [row] = await db
      .insert(bookAsset)
      .values({
        relativePath: `bilder/${fileName}`,
        fileName,
        sectionId,
        page: 10 + ordinal,
        indexOnPage: 1,
        captionRaw: caption,
        captionLabel: caption === null ? null : 'Hand Range',
        captionNumber: caption === null ? null : ordinal + 1,
        captionSpot: caption === null ? null : 'SB vs BB (15bb)',
        captionActions,
        assetType,
        classificationConfidence: confidence,
        classificationRule: 'caption-label',
        ordinal,
        contentHash: `hash-${fileName}`,
      })
      .returning({ id: bookAsset.id });
    return (row as { id: string }).id;
  };

  return {
    handRange: await insert(
      'p0003_01.jpeg',
      'hand_range',
      'certain',
      0,
      '*Hand Range 1: SB vs BB (15bb)*',
      [
        { action: 'All-in', percent: 23.7 },
        { action: 'Limp', percent: 61.5 },
        { action: 'Fold', percent: 14.8 },
      ],
    ),
    handRangeUncertain: await insert('p0004_01.jpeg', 'hand_range', 'uncertain', 1, null, []),
    table: await insert('p0004_02.jpeg', 'table', 'certain', 2, '*Table 1: Frequenzen*', []),
  };
}

/** Eine vollstaendige Modellantwort: alle 169 Blaetter, alles Fold. */
export function fullFoldResponse(): {
  zellen: { hand: string; aktionen: { art: string; prozent: number }[] }[];
  unsicher: string[];
  legende: string[];
  legendenwerte: { art: string; prozent: number; beschriftung: string }[];
  legendenwerte_vorhanden: boolean;
} {
  return {
    zellen: CHART_HANDS.map((hand) => ({ hand, aktionen: [{ art: 'fold', prozent: 100 }] })),
    unsicher: [],
    legende: ['grau = fold'],
    legendenwerte: [],
    legendenwerte_vorhanden: false,
  };
}
