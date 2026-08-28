import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CONCEPT_TOPIC_AREA_IDS, MANUAL_LEVEL_GRACE_DAYS } from '@gto/shared';
import type { ConceptTopicArea, RecordLearningEventInput } from '@gto/shared';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { bookChapter, concept } from '../../src/db/schema.js';
import {
  LearningEventValidationError,
  readLearnerLevel,
  readRatingHistory,
  readSkillRatings,
  recordLearningEvent,
  replayLearningState,
  setLearnerLevel,
} from '../../src/learning/service.js';
import { seedLearningState } from '../../src/learning/seed.js';
import { TEST_DATABASE_URL } from '../db/setup.js';
import { clearLearning } from './helpers.js';

/**
 * Skill-Ratings, Verlauf und Level gegen echte Daten (AP4.T4.5).
 *
 * Die Formeln sind in `rating.test.ts` und `level.test.ts` ohne Datenbank
 * durchgerechnet. Hier geht es um das, was nur die Datenbank beantworten kann:
 * die Zuordnung Konzept → Themenbereich, das Wachstum des Verlaufs und die
 * manuelle Level-Setzung als Ereignis. **Kein KI-Aufruf.**
 */
describe('Skill-Ratings und Level (AP4.T4.5)', () => {
  let handle: DbHandle;
  let chapterId: string;

  const DAY = 24 * 60 * 60 * 1000;
  const START = new Date('2026-01-01T09:00:00.000Z');
  const at = (day: number, hour = 0): Date =>
    new Date(START.getTime() + day * DAY + hour * 60 * 60 * 1000);

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
        contentHash: 'hash-t45-chapter',
      })
      .returning({ id: bookChapter.id });
    chapterId = (chapter as { id: string }).id;
    await seedLearningState(handle.db);
  });

  async function addConcept(
    slug: string,
    topicArea: ConceptTopicArea = 'grundlagen-mathematik',
  ): Promise<string> {
    const [row] = await handle.db
      .insert(concept)
      .values({
        chapterId,
        slug,
        title: `Konzept ${slug}`,
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
    const result = await recordLearningEvent(handle.db, {
      id: randomUUID(),
      eventType: 'question_answered',
      source: 'theory_session',
      signalClass: 'objective',
      conceptId,
      occurredAt: at(day, hour).toISOString(),
      payload: { correct: true },
      ...overrides,
    } as RecordLearningEventInput);
    expect(result.status).toBe('recorded');
  }

  /* --- Achsen ----------------------------------------------------------- */

  it('fuehrt eine Achse fuer jeden Themenbereich aus AP3', async () => {
    const rows = await handle.db.execute<{ topic_area: string }>(
      sql`select topic_area from skill_rating order by topic_area`,
    );

    expect(rows.rows.map((row) => row.topic_area)).toEqual([...CONCEPT_TOPIC_AREA_IDS].sort());
    expect(rows.rows).toHaveLength(12);

    // Und die Leseform liefert alle zwoelf, auch die ohne Datenlage: Eine
    // fehlende Achse waere in der Anzeige nicht von einer schlechten zu
    // unterscheiden.
    const view = await readSkillRatings(handle.db);
    expect(view).toHaveLength(12);
    expect(view.map((entry) => entry.topicArea)).toEqual([...CONCEPT_TOPIC_AREA_IDS]);
    expect(view.every((entry) => entry.rating === 0 && entry.eventCount === 0)).toBe(true);
    expect(view[0]?.label).toBe('Grundlagen und Mathematik');
  });

  it('wirkt ein Ereignis nur auf die Achse seines eigenen Themenbereichs', async () => {
    const flop = await addConcept('t45-flop', 'flop-spiel');
    await addConcept('t45-turn', 'turn-spiel');

    await record(flop, 0, { payload: { correct: true } });

    const view = await readSkillRatings(handle.db);
    const flopAchse = view.find((entry) => entry.topicArea === 'flop-spiel');
    const turnAchse = view.find((entry) => entry.topicArea === 'turn-spiel');

    expect(flopAchse).toMatchObject({ rating: 1, eventCount: 1 });
    // Alle anderen bleiben unberuehrt - auch die Achse mit einem Konzept, das
    // kein Ereignis gesehen hat.
    expect(turnAchse).toMatchObject({ rating: 0, eventCount: 0 });
    expect(view.filter((entry) => entry.eventCount > 0)).toHaveLength(1);
  });

  it('liest den Themenbereich zur Laufzeit aus dem Konzept', async () => {
    // Die Zuordnung wird nicht im Ereignis dupliziert. Wird ein Konzept
    // umsortiert, zieht das Rating beim naechsten Lauf mit - es gibt keine
    // zweite Wahrheit, die auseinanderlaufen koennte.
    const id = await addConcept('t45-umzug', 'flop-spiel');
    await record(id, 0);
    expect(
      (await readSkillRatings(handle.db)).find((e) => e.topicArea === 'flop-spiel')?.eventCount,
    ).toBe(1);

    await handle.db.execute(sql`update concept set topic_area = 'river-spiel' where id = ${id}`);
    await replayLearningState(handle.db);

    const view = await readSkillRatings(handle.db);
    expect(view.find((e) => e.topicArea === 'river-spiel')?.eventCount).toBe(1);
    expect(view.find((e) => e.topicArea === 'flop-spiel')?.eventCount).toBe(0);
  });

  /* --- Verlauf ----------------------------------------------------------- */

  it('schreibt einen Verlaufspunkt je Kalendertag, nicht je Ereignis', async () => {
    const id = await addConcept('t45-verlauf', 'spieltheorie');

    // 40 Ereignisse ueber 10 Tage - vier am Tag.
    for (let day = 0; day < 10; day += 1) {
      for (let n = 0; n < 4; n += 1) {
        await record(id, day, { payload: { correct: n % 3 !== 0 } }, n);
      }
    }

    const history = await readRatingHistory(handle.db, 'spieltheorie');

    expect(history.points).toHaveLength(10);
    expect(history.points[0]?.day).toBe('2026-01-01');
    expect(history.points[9]?.day).toBe('2026-01-10');

    const gesamt = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from skill_rating_snapshot`,
    );
    // Vierzig Ereignisse, zehn Punkte: Der Verlauf waechst mit den Tagen, nicht
    // mit der Nutzung.
    expect(Number(gesamt.rows[0]?.n)).toBe(10);

    const events = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event`,
    );
    expect(Number(events.rows[0]?.n)).toBe(40);
  });

  it('erzeugt beim Replay dieselben Verlaufspunkte', async () => {
    const id = await addConcept('t45-replay', 'mental-game');
    for (let day = 0; day < 5; day += 1) await record(id, day);

    const vorher = await handle.db.execute<Record<string, unknown>>(
      sql`select * from skill_rating_snapshot order by id`,
    );
    await replayLearningState(handle.db);
    const nachher = await handle.db.execute<Record<string, unknown>>(
      sql`select * from skill_rating_snapshot order by id`,
    );

    // Gleiche Zeilen samt IDs - die stammen aus Themenbereich und Tag, nicht
    // aus `gen_random_uuid()`.
    expect(nachher.rows).toEqual(vorher.rows);
    expect(vorher.rows).toHaveLength(5);
  });

  /* --- Level ------------------------------------------------------------- */

  it('bleibt ohne Datenlage bei "einsteiger"', async () => {
    const level = await readLearnerLevel(handle.db, at(1));

    expect(level.level).toBe('einsteiger');
    expect(level.source).toBe('automatic');
    expect(level.signals).toMatchObject({ coveredTopicAreas: 0, masteredConcepts: 0 });
  });

  it('stuft nach anhaltend guter Leistung hoch', async () => {
    // Sechs Konzepte in drei Themenbereichen, je vier objektive Treffer -
    // genug fuer belastbare Mastery und einen tragfaehigen Schnitt.
    const areas: ConceptTopicArea[] = ['preflop-ranges', 'flop-spiel', 'turn-spiel'];
    for (let i = 0; i < 6; i += 1) {
      const id = await addConcept(`t45-auf-${i}`, areas[i % 3] as ConceptTopicArea);
      for (let n = 0; n < 4; n += 1) await record(id, n, {}, n);
    }

    const level = await readLearnerLevel(handle.db, at(5));

    expect(level.signals.masteredConcepts).toBeGreaterThanOrEqual(5);
    expect(level.signals.objectiveShare).toBe(1);
    expect(level.level).toBe('fortgeschritten');

    const stored = await handle.db.execute<{ level: string }>(sql`select level from learner_state`);
    expect(stored.rows[0]?.level).toBe('fortgeschritten');
  });

  /* --- Manuelle Setzung --------------------------------------------------- */

  it('nimmt eine manuelle Level-Setzung als Ereignis auf und respektiert sie', async () => {
    const result = await setLearnerLevel(handle.db, {
      eventId: randomUUID(),
      level: 'experte',
      reason: 'Ich spiele seit Jahren Turniere.',
    });

    expect(result.status).toBe('recorded');
    // Kein direkter Schreibzugriff: Die Korrektur steht im Protokoll.
    expect(result.conceptId).toBeNull();

    const events = await handle.db.execute<{
      event_type: string;
      concept_id: string | null;
      payload: Record<string, unknown>;
    }>(sql`select event_type, concept_id, payload from learning_event`);
    expect(events.rows[0]).toMatchObject({
      event_type: 'level_set',
      concept_id: null,
      payload: { level: 'experte', reason: 'Ich spiele seit Jahren Turniere.' },
    });

    const stored = await handle.db.execute<{ level: string }>(sql`select level from learner_state`);
    expect(stored.rows[0]?.level).toBe('experte');
  });

  it('laesst die Automatik nach Ablauf der Frist wieder uebernehmen', async () => {
    const setAt = at(0);
    await recordLearningEvent(handle.db, {
      id: randomUUID(),
      eventType: 'level_set',
      source: 'manual',
      signalClass: 'self_reported',
      occurredAt: setAt.toISOString(),
      payload: { level: 'experte' },
    });

    const waehrendFrist = await readLearnerLevel(
      handle.db,
      new Date(setAt.getTime() + (MANUAL_LEVEL_GRACE_DAYS - 1) * DAY),
    );
    const danach = await readLearnerLevel(
      handle.db,
      new Date(setAt.getTime() + (MANUAL_LEVEL_GRACE_DAYS + 1) * DAY),
    );

    expect(waehrendFrist.level).toBe('experte');
    expect(waehrendFrist.source).toBe('manual');
    expect(waehrendFrist.automaticLevel).toBe('einsteiger');

    // Ohne Beleglage holt die Automatik zurueck, was die Setzung vorgriff.
    expect(danach.source).toBe('automatic');
    expect(danach.level).toBe('einsteiger');
  });

  it('lehnt ein level_set mit Konzeptbezug und eine unbekannte Stufe ab', async () => {
    const id = await addConcept('t45-ablehnung');

    await expect(
      recordLearningEvent(handle.db, {
        id: randomUUID(),
        eventType: 'level_set',
        source: 'manual',
        signalClass: 'self_reported',
        conceptId: id,
        payload: { level: 'experte' },
      }),
    ).rejects.toBeInstanceOf(LearningEventValidationError);

    await expect(
      recordLearningEvent(handle.db, {
        id: randomUUID(),
        eventType: 'level_set',
        source: 'manual',
        signalClass: 'self_reported',
        payload: { level: 'grossmeister' },
      } as unknown as RecordLearningEventInput),
    ).rejects.toThrow(/Unbekanntes Level/);

    const events = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event`,
    );
    expect(Number(events.rows[0]?.n)).toBe(0);
  });

  it('lehnt ein Lernereignis ohne Konzeptbezug ab', async () => {
    // Die Kehrseite: Ein Ereignis ohne Konzept, das kein `level_set` ist,
    // wuerde von keiner Ableitung erfasst - es stuende wirkungslos im
    // Protokoll.
    await expect(
      recordLearningEvent(handle.db, {
        id: randomUUID(),
        eventType: 'question_answered',
        source: 'theory_session',
        signalClass: 'objective',
        payload: { correct: true },
      }),
    ).rejects.toThrow(/Konzept-ID muss eine UUID sein/);
  });
});
