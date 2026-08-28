import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PATTERN_REPORT_JOB } from '@gto/shared';
import type { ConceptTopicArea, RecordLearningEventInput } from '@gto/shared';
import { loadLlmConfig } from '../../src/config/env.js';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { bookChapter, concept } from '../../src/db/schema.js';
import { createDbCallLogSink } from '../../src/llm/call-log.js';
import { LlmProviderRegistry } from '../../src/llm/registry.js';
import { TemplateRegistry } from '../../src/prompts/registry.js';
import { createPatternReportJob } from '../../src/jobs/handlers/pattern-report.js';
import type { JobContext } from '../../src/jobs/types.js';
import { recordLearningEvent } from '../../src/learning/service.js';
import { readLatestReport } from '../../src/learning/report.js';
import { seedLearningState } from '../../src/learning/seed.js';
import { TEST_DATABASE_URL } from '../db/setup.js';
import { clearLearning } from './helpers.js';

/**
 * Live-Lauf des Muster-Reports gegen den **echten** Provider (AP4.T4.6).
 *
 * Laeuft nur mit `LLM_LIVE_SMOKE=true`; in der CI ist die Variable nicht
 * gesetzt und der Block wird uebersprungen. Grund: Der Aufruf verbraucht
 * Kontingent, das sich der Report mit dem Chart-Massenlauf aus AP3 teilt.
 *
 *   LLM_LIVE_SMOKE=true pnpm --filter @gto/backend test test/learning/report-live.test.ts
 *
 * Warum es diesen Test ueberhaupt gibt: Alle anderen Tests belegen, dass die
 * Struktur stimmt - Schema eingehalten, Tags geschrieben, kein Aufruf unter
 * der Mindestmenge. Keiner davon belegt, dass die Muster **fachlich brauchbar**
 * sind. Das kann nur ein echter Lauf, und man muss ihn lesen.
 *
 * Die Fehlerhistorie ist bewusst konstruiert, aber realistisch: ein
 * festsitzender Denkfehler bei der Small-Blind-Verteidigung, ein
 * Kontextunterschied bei den C-Bets und ein Ausreisser ohne Muster. Wenn die
 * Auswertung die ersten beiden findet und den dritten nicht aufblaest, taugt
 * sie.
 */
const live = process.env['LLM_LIVE_SMOKE'] === 'true';

describe.skipIf(!live)('Muster-Report live (AP4.T4.6)', () => {
  let handle: DbHandle;

  const DAY = 24 * 60 * 60 * 1000;
  const START = new Date('2026-01-05T09:00:00.000Z');
  const at = (day: number, hour = 0): Date =>
    new Date(START.getTime() + day * DAY + hour * 60 * 60 * 1000);

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL, { max: 3 });
    await clearLearning(handle.db);
    await seedLearningState(handle.db);
  });

  afterAll(async () => {
    await clearLearning(handle.db);
    await handle.close();
  });

  it('erzeugt aus einer echten Fehlerhistorie brauchbare Muster', async () => {
    const [chapter] = await handle.db
      .insert(bookChapter)
      .values({
        partNumber: 1,
        partTitle: 'Live',
        chapterNumber: 1,
        title: 'Live-Kapitel',
        ordinal: 0,
        contentHash: 'hash-live',
      })
      .returning({ id: bookChapter.id });
    const chapterId = (chapter as { id: string }).id;

    const addConcept = async (
      slug: string,
      title: string,
      topicArea: ConceptTopicArea,
    ): Promise<string> => {
      const [row] = await handle.db
        .insert(concept)
        .values({
          chapterId,
          slug,
          title,
          summary: 'Fixture.',
          topicArea,
          minLevel: 'fortgeschritten',
          state: 'approved',
          origin: 'manual',
          ordinal: 0,
        })
        .returning({ id: concept.id });
      return (row as { id: string }).id;
    };

    const record = async (
      conceptId: string,
      day: number,
      overrides: Partial<RecordLearningEventInput> = {},
      hour = 0,
    ): Promise<void> => {
      await recordLearningEvent(handle.db, {
        id: randomUUID(),
        eventType: 'question_answered',
        source: 'drill',
        signalClass: 'objective',
        conceptId,
        occurredAt: at(day, hour).toISOString(),
        payload: { correct: false },
        ...overrides,
      } as RecordLearningEventInput);
    };

    // 1. Festsitzender Denkfehler: sass zwischendurch, kippt wieder.
    const sb = await addConcept('live-sb', 'Small-Blind-Verteidigung', 'preflop-verteidigung');
    for (const day of [0, 9, 16, 22]) await record(sb, day);
    await record(sb, 5, { payload: { correct: true } });

    // 2. Kontextunterschied: in der Theorie sicher, im Drill nicht.
    const cbet = await addConcept('live-cbet', 'C-Bet-Frequenz am Flop', 'flop-spiel');
    for (const day of [3, 6, 11, 19]) await record(cbet, day);
    for (const day of [4, 12]) {
      await record(cbet, day, { source: 'theory_session', payload: { correct: true } }, 3);
    }

    // 3. Ausreisser ohne Muster - die Auswertung soll ihn nicht aufblasen.
    const icm = await addConcept('live-icm', 'ICM-Druck an der Blase', 'turnier-metriken-icm');
    await record(icm, 14, { source: 'hand_analysis', eventType: 'hand_analyzed' });

    const providers = new LlmProviderRegistry({
      config: loadLlmConfig(),
      callLog: { sink: createDbCallLogSink(handle.db) },
    });
    const job = createPatternReportJob({
      providers,
      templates: TemplateRegistry.load(),
      defaultModel: process.env['LLM_SMOKE_MODEL'] ?? loadLlmConfig().model,
      now: () => at(25),
    });

    const context: JobContext = {
      db: handle.db,
      job: {
        id: randomUUID(),
        jobType: PATTERN_REPORT_JOB,
        payload: {},
        attempts: 1,
        maxAttempts: 1,
      },
      signal: new AbortController().signal,
      log: (message) => console.warn('[live]', message),
    };

    await job.run({ periodDays: 28, force: true }, context);

    const report = await readLatestReport(handle.db);
    expect(report?.status).toBe('complete');
    expect(report?.patterns.length).toBeGreaterThanOrEqual(1);
    expect(report?.patterns.length).toBeLessThanOrEqual(5);

    // Belege: Jedes Muster nennt Konzepte, eine Anzahl und einen Zeitraum.
    for (const pattern of report?.patterns ?? []) {
      expect(pattern.konzepte.length).toBeGreaterThan(0);
      expect(pattern.anzahl).toBeGreaterThan(0);
      expect(pattern.zeitraum).not.toBe('');
      // Keine erfundenen Konzepte.
      for (const title of pattern.konzepte) {
        expect([
          'Small-Blind-Verteidigung',
          'C-Bet-Frequenz am Flop',
          'ICM-Druck an der Blase',
        ]).toContain(title);
      }
    }

    const tagged = await handle.db.execute<{ pattern_tag: string; n: string }>(
      sql`select pattern_tag, count(*) as n from error_log
            where pattern_tag is not null group by pattern_tag order by pattern_tag`,
    );

    console.warn(
      '\n=== LIVE-REPORT ===\n' +
        `Modell: ${report?.provider}/${report?.model}, ${report?.durationMs} ms\n` +
        `Zeitraum: ${report?.periodStart.slice(0, 10)} bis ${report?.periodEnd.slice(0, 10)}\n` +
        `${report?.errorCount} Fehler ueber ${report?.conceptCount} Konzepte\n` +
        (report?.note ? `Hinweis: ${report.note}\n` : '') +
        (report?.patterns ?? [])
          .map(
            (pattern) =>
              `\n### ${pattern.titel}  [${pattern.tag}]  (${pattern.vertrauen}, ${pattern.anzahl}, ${pattern.taggedErrors} markiert)\n` +
              `  Beobachtung: ${pattern.beobachtung}\n` +
              `  Deutung:     ${pattern.deutung}\n` +
              `  Empfehlung:  ${pattern.empfehlung}\n` +
              `  Konzepte:    ${pattern.konzepte.join(', ')}`,
          )
          .join('\n') +
        `\n\nMarkierte Fehlereintraege: ${JSON.stringify(tagged.rows)}\n`,
    );
  }, 600_000);
});
