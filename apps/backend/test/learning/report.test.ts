import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PATTERN_REPORT_JOB, PATTERN_REPORT_MINIMUM } from '@gto/shared';
import type { ConceptTopicArea, RecordLearningEventInput } from '@gto/shared';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { bookChapter, concept } from '../../src/db/schema.js';
import { recordLearningEvent, replayLearningState } from '../../src/learning/service.js';
import {
  learningStateFingerprint,
  readLatestReport,
  readReportHistory,
} from '../../src/learning/report.js';
import { seedLearningState } from '../../src/learning/seed.js';
import { createPatternReportJob } from '../../src/jobs/handlers/pattern-report.js';
import { JobPayloadError } from '../../src/jobs/types.js';
import type { JobContext } from '../../src/jobs/types.js';
import { LlmProviderRegistry } from '../../src/llm/registry.js';
import { TemplateRegistry } from '../../src/prompts/registry.js';
import { TEST_DATABASE_URL } from '../db/setup.js';
import { createStubProvider } from '../concept/helpers.js';
import { clearLearning } from './helpers.js';

/**
 * Muster-Report gegen einen **gemockten** Provider (AP4.T4.6).
 *
 * Datenbank und Job-Verdrahtung sind echt, der Aufruf ist es nicht: Geprueft
 * wird, was um den Aufruf herum passiert - Aggregation, Mindestdatenmenge,
 * Wiederholungsvermeidung, Speicherung, Muster-Tags. Der echte Aufruf steht in
 * `report-live.test.ts` und laeuft nur mit gesetztem Flag.
 */
describe('Muster-Report (AP4.T4.6)', () => {
  let handle: DbHandle;
  let chapterId: string;

  const DAY = 24 * 60 * 60 * 1000;
  const START = new Date('2026-01-05T09:00:00.000Z');
  const at = (day: number, hour = 0): Date =>
    new Date(START.getTime() + day * DAY + hour * 60 * 60 * 1000);
  /** Bezugszeitpunkt der Reports: nach allen Ereignissen. */
  const AS_OF = at(25);

  /** Antwort, wie sie das Modell laut Schema liefert. */
  const ANTWORT = {
    muster: [
      {
        titel: 'SB-Verteidigung zu weit',
        beobachtung:
          'Vier Fehler bei Small-Blind-Verteidigung, drei davon nach einer Wiederholung.',
        deutung: 'Deutet auf eine zu weite Verteidigungsrange aus dem Small Blind hin.',
        empfehlung: 'Die SB-Range gegen Button-Open gezielt drillen.',
        konzepte: ['Small-Blind-Verteidigung'],
        themenbereiche: ['Preflop-Verteidigung'],
        anzahl: 4,
        zeitraum: '2026-01-05 bis 2026-01-30',
        vertrauen: 'hoch',
      },
      {
        titel: 'C-Bet-Frequenz im Drill',
        beobachtung: 'Drei Fehler bei C-Bet-Frequenz, alle im Drill.',
        deutung: 'Unter Zeitdruck greift die Regel nicht.',
        empfehlung: 'Langsame Drills ohne Zeitlimit.',
        konzepte: ['C-Bet-Frequenz'],
        themenbereiche: ['Flop-Spiel'],
        anzahl: 3,
        zeitraum: '2026-01-05 bis 2026-01-30',
        vertrauen: 'mittel',
      },
    ],
    hinweis: '',
  };

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL, { max: 4 });
  });

  afterAll(async () => {
    await clearLearning(handle.db);
    await handle.close();
  });

  beforeEach(async () => {
    await clearLearning(handle.db);
    const [chapter] = await handle.db
      .insert(bookChapter)
      .values({
        partNumber: 1,
        partTitle: 'Testteil',
        chapterNumber: 1,
        title: 'Erstes Kapitel',
        ordinal: 0,
        contentHash: 'hash-t46-chapter',
      })
      .returning({ id: bookChapter.id });
    chapterId = (chapter as { id: string }).id;
    await seedLearningState(handle.db);
  });

  async function addConcept(
    slug: string,
    title: string,
    topicArea: ConceptTopicArea,
  ): Promise<string> {
    const [row] = await handle.db
      .insert(concept)
      .values({
        chapterId,
        slug,
        title,
        summary: 'Fixture-Definition, kein Buchinhalt.',
        topicArea,
        minLevel: 'einsteiger',
        state: 'approved',
        origin: 'manual',
        ordinal: 0,
      })
      .returning({ id: concept.id });
    return (row as { id: string }).id;
  }

  async function record(
    conceptId: string,
    day: number,
    overrides: Partial<RecordLearningEventInput> = {},
    hour = 0,
  ): Promise<void> {
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
  }

  /** Eine Fehlerhistorie, die die Mindestdatenmenge sicher ueberschreitet. */
  async function seedHistory(): Promise<{ sb: string; cbet: string; icm: string }> {
    const sb = await addConcept('t46-sb', 'Small-Blind-Verteidigung', 'preflop-verteidigung');
    const cbet = await addConcept('t46-cbet', 'C-Bet-Frequenz', 'flop-spiel');
    const icm = await addConcept('t46-icm', 'ICM-Druck', 'turnier-metriken-icm');

    for (const day of [0, 8, 15, 20]) await record(sb, day);
    // Ein Erfolg dazwischen - erzeugt das Wiederholungsmuster.
    await record(sb, 5, { payload: { correct: true } });
    for (const day of [2, 3, 4]) await record(cbet, day);
    await record(icm, 18, { source: 'hand_analysis', eventType: 'hand_analyzed' });

    return { sb, cbet, icm };
  }

  /** Job samt Attrappe; der Zaehler belegt, ob ein Aufruf stattfand. */
  function createJob(json: unknown = ANTWORT) {
    const provider = createStubProvider(json);
    const providers = new LlmProviderRegistry({
      config: { provider: 'api' } as never,
      factory: () => provider,
    });
    const job = createPatternReportJob({
      providers,
      templates: TemplateRegistry.load(),
      defaultModel: 'claude-sonnet-5',
      now: () => AS_OF,
    });
    return { job, provider };
  }

  function context(): JobContext {
    return {
      db: handle.db,
      job: {
        id: randomUUID(),
        jobType: PATTERN_REPORT_JOB,
        payload: {},
        attempts: 1,
        maxAttempts: 3,
      },
      signal: new AbortController().signal,
      log: () => undefined,
    };
  }

  const PAYLOAD = { periodDays: 28, force: false };

  /* --- Fehlerprotokoll aus dem Ereignisstrom ---------------------------- */

  it('schreibt Fehler-Ereignisse automatisch ins Protokoll, mit abgeleitetem Schweregrad', async () => {
    const id = await addConcept('t46-schwere', 'Schweregrade', 'spieltheorie');

    await record(id, 0, { payload: { correct: false } }); // objektiv, 0 -> high
    await record(id, 1, {
      eventType: 'drill_completed',
      payload: { correct: 1, total: 4 },
    }); // objektiv, 0,25 -> medium
    await record(id, 2, {
      eventType: 'concept_explained',
      signalClass: 'ai_judged',
      payload: { quality: 0 },
    }); // KI, 0 -> medium
    await record(id, 3, {
      eventType: 'review_performed',
      source: 'journal',
      signalClass: 'self_reported',
      payload: { correct: false },
    }); // Selbsteinschaetzung -> low

    const rows = await handle.db.execute<{ severity: string; context_kind: string }>(
      sql`select severity, context_kind from error_log order by occurred_at`,
    );

    expect(rows.rows.map((row) => row.severity)).toEqual(['high', 'medium', 'medium', 'low']);
    expect(rows.rows[0]?.context_kind).toBe('drill');
  });

  /* --- Mindestdatenmenge ------------------------------------------------- */

  it('setzt unterhalb der Mindestdatenmenge keinen Aufruf ab', async () => {
    const id = await addConcept('t46-duenn', 'Duenne Datenlage', 'spieltheorie');
    for (const day of [0, 1, 2]) await record(id, day);

    const { job, provider } = createJob();
    await job.run(PAYLOAD, context());

    // **Kein Aufruf** - der Zaehler ist der Beleg.
    expect(provider.calls).toHaveLength(0);

    const report = await readLatestReport(handle.db);
    expect(report?.status).toBe('insufficient_data');
    expect(report?.patterns).toEqual([]);
    expect(report?.note).toContain('Zu wenige Fehler im Zeitraum: 3');
    expect(report?.note).toContain(String(PATTERN_REPORT_MINIMUM.errors));
    expect(report?.model).toBeNull();
  });

  it('setzt keinen Aufruf ab, wenn sich die Fehler auf zu wenige Konzepte verteilen', async () => {
    const a = await addConcept('t46-eins', 'Konzept A', 'spieltheorie');
    const b = await addConcept('t46-zwei', 'Konzept B', 'flop-spiel');
    for (const day of [0, 1, 2, 3, 4]) await record(a, day);
    for (const day of [5, 6, 7]) await record(b, day);

    const { job, provider } = createJob();
    await job.run(PAYLOAD, context());

    expect(provider.calls).toHaveLength(0);
    expect((await readLatestReport(handle.db))?.note).toContain('nur 2 Konzepte');
  });

  /* --- Der Lauf ----------------------------------------------------------- */

  it('erzeugt einen Report und schreibt die Muster-Tags zurueck', async () => {
    await seedHistory();

    const { job, provider } = createJob();
    await job.run(PAYLOAD, context());

    expect(provider.calls).toHaveLength(1);

    const report = await readLatestReport(handle.db);
    expect(report?.status).toBe('complete');
    expect(report?.patterns.map((pattern) => pattern.tag)).toEqual([
      'sb-verteidigung-zu-weit',
      'c-bet-frequenz-im-drill',
    ]);
    expect(report?.errorCount).toBe(8);
    expect(report?.conceptCount).toBe(3);
    expect(report?.model).toBe('claude-sonnet-5');

    // Die Muster-Tags stehen im Fehlerprotokoll - AP6 kann danach filtern.
    const tagged = await handle.db.execute<{ pattern_tag: string; n: string }>(
      sql`select pattern_tag, count(*) as n from error_log
          where pattern_tag is not null group by pattern_tag order by pattern_tag`,
    );
    expect(tagged.rows).toEqual([
      { pattern_tag: 'c-bet-frequenz-im-drill', n: '3' },
      { pattern_tag: 'sb-verteidigung-zu-weit', n: '4' },
    ]);
    expect(report?.patterns.map((pattern) => pattern.taggedErrors)).toEqual([4, 3]);
  });

  it('gibt die Eintraege dem spezifischeren Muster, nicht dem erstgenannten', async () => {
    await seedHistory();
    // Das erste Muster nennt alle drei Konzepte, das zweite nur eines. Ohne
    // die Sortierung nach Spezifitaet zoege das breite Muster alles an sich
    // und das aussagekraeftige bliebe leer.
    const { job } = createJob({
      muster: [
        {
          ...(ANTWORT.muster[0] as Record<string, unknown>),
          titel: 'Breites Muster',
          konzepte: ['Small-Blind-Verteidigung', 'C-Bet-Frequenz', 'ICM-Druck'],
        },
        {
          ...(ANTWORT.muster[1] as Record<string, unknown>),
          titel: 'Enges Muster',
          konzepte: ['Small-Blind-Verteidigung'],
        },
      ],
      hinweis: '',
    });
    await job.run(PAYLOAD, context());

    const report = await readLatestReport(handle.db);
    // Reihenfolge bleibt die des Modells, die Zuteilung folgt der Spezifitaet.
    expect(report?.patterns.map((pattern) => [pattern.titel, pattern.taggedErrors])).toEqual([
      ['Breites Muster', 4],
      ['Enges Muster', 4],
    ]);
  });

  it('haelt die Muster-Tags ueber weitere Ereignisse und einen Replay hinweg', async () => {
    const { sb } = await seedHistory();
    const { job } = createJob();
    await job.run(PAYLOAD, context());

    // Ein neues Ereignis baut das Fehlerprotokoll des Konzepts neu auf.
    await record(sb, 22);
    const nachEreignis = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from error_log where pattern_tag = 'sb-verteidigung-zu-weit'`,
    );
    expect(Number(nachEreignis.rows[0]?.n)).toBe(4);

    // Und ein Replay verwirft das Protokoll komplett.
    await replayLearningState(handle.db);
    const nachReplay = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from error_log where pattern_tag = 'sb-verteidigung-zu-weit'`,
    );
    expect(Number(nachReplay.rows[0]?.n)).toBe(4);
  });

  it('setzt bei unveraenderter Datenlage keinen zweiten Aufruf ab', async () => {
    await seedHistory();
    const { job, provider } = createJob();

    await job.run(PAYLOAD, context());
    expect(provider.calls).toHaveLength(1);

    await job.run(PAYLOAD, context());
    // Kein zweiter Aufruf - und kein zweiter Report.
    expect(provider.calls).toHaveLength(1);
    expect(await readReportHistory(handle.db)).toHaveLength(1);
  });

  it('wertet bei force=true auch unveraenderte Daten neu aus', async () => {
    await seedHistory();
    const { job, provider } = createJob();

    await job.run(PAYLOAD, context());
    await job.run({ ...PAYLOAD, force: true }, context());

    expect(provider.calls).toHaveLength(2);
    expect(await readReportHistory(handle.db)).toHaveLength(2);
  });

  it('wertet nach neuen Fehlern wieder aus', async () => {
    const { sb } = await seedHistory();
    const { job, provider } = createJob();

    await job.run(PAYLOAD, context());
    await record(sb, 22);
    await job.run(PAYLOAD, context());

    expect(provider.calls).toHaveLength(2);
  });

  /* --- Die KI sieht nur Kennzahlen -------------------------------------- */

  it('uebergibt der Auswertung ausschliesslich aggregierte Kennzahlen', async () => {
    await seedHistory();
    const { job, provider } = createJob();
    await job.run(PAYLOAD, context());

    const prompt = (provider.calls[0]?.messages ?? [])
      .flatMap((message) => message.content)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');

    // Zaehlstaende ja ...
    expect(prompt).toContain('Fehler gesamt: 8 über 3 Konzepte');
    expect(prompt).toContain('Small-Blind-Verteidigung | Preflop-Verteidigung | 4 |');
    expect(prompt).toContain('Wiederholte Fehler trotz zwischenzeitlich gelungener Wiederholung');
    // ... Rohprotokoll nein.
    expect(prompt).not.toContain('Frage falsch beantwortet');
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  });

  /* --- Schema-Verstoss ---------------------------------------------------- */

  it('behandelt einen Schema-Verstoss als Fehler und speichert keinen leeren Report', async () => {
    await seedHistory();
    // `anzahl` fehlt - das Modell hat sich nicht ans Schema gehalten.
    const { job } = createJob({
      muster: [{ titel: 'Halb', beobachtung: 'x', deutung: 'y', empfehlung: 'z' }],
      hinweis: '',
    });

    await expect(job.run(PAYLOAD, context())).rejects.toBeInstanceOf(JobPayloadError);

    // Kein leerer Report: Der saehe aus wie "keine Muster gefunden", waere aber
    // "die Antwort war unbrauchbar".
    expect(await readReportHistory(handle.db)).toEqual([]);
  });

  it('behandelt eine Antwort ohne "muster"-Liste als Fehler', async () => {
    await seedHistory();
    const { job } = createJob({ hinweis: 'nichts gefunden' });

    await expect(job.run(PAYLOAD, context())).rejects.toThrow(/Feld "muster" fehlt/);
    expect(await readReportHistory(handle.db)).toEqual([]);
  });

  /* --- Der Report veraendert keinen Lernstand ---------------------------- */

  it('laesst Mastery, Queue und Ratings unveraendert', async () => {
    await seedHistory();

    const vorher = {
      mastery: await learningStateFingerprint(handle.db),
      queue: (
        await handle.db.execute<Record<string, unknown>>(
          sql`select * from review_queue order by concept_id`,
        )
      ).rows,
      ratings: (
        await handle.db.execute<Record<string, unknown>>(
          sql`select * from skill_rating order by topic_area`,
        )
      ).rows,
      level: (await handle.db.execute<{ level: string }>(sql`select level from learner_state`))
        .rows,
    };

    const { job } = createJob();
    await job.run(PAYLOAD, context());

    const nachher = {
      mastery: await learningStateFingerprint(handle.db),
      queue: (
        await handle.db.execute<Record<string, unknown>>(
          sql`select * from review_queue order by concept_id`,
        )
      ).rows,
      ratings: (
        await handle.db.execute<Record<string, unknown>>(
          sql`select * from skill_rating order by topic_area`,
        )
      ).rows,
      level: (await handle.db.execute<{ level: string }>(sql`select level from learner_state`))
        .rows,
    };

    // Der Report deutet nur, was ohnehin in den Zahlen steht.
    expect(nachher).toEqual(vorher);
  });

  /* --- Abruf --------------------------------------------------------------- */

  it('liefert den juengsten Report und die Historie', async () => {
    await seedHistory();
    const { job } = createJob();

    await job.run(PAYLOAD, context());
    await job.run({ ...PAYLOAD, force: true }, context());

    const history = await readReportHistory(handle.db);
    expect(history).toHaveLength(2);
    const latest = await readLatestReport(handle.db);
    expect(latest?.id).toBe(history[0]?.id);
    expect(latest?.patterns[0]?.titel).toBe('SB-Verteidigung zu weit');
  });

  it('lehnt eine unbrauchbare Nutzlast ab, ohne einen Aufruf abzusetzen', () => {
    const { job } = createJob();
    expect(() => job.parsePayload({ periodDays: 0 })).toThrow(JobPayloadError);
    expect(() => job.parsePayload({ force: 'ja' })).toThrow(JobPayloadError);
    expect(job.parsePayload({})).toEqual({ periodDays: 28, force: false });
  });
});
