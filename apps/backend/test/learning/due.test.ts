import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { ConceptTopicArea, RecordLearningEventInput } from '@gto/shared';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { bookChapter, concept, conceptPrerequisite } from '../../src/db/schema.js';
import { dueReviews, recordLearningEvent, upcomingReviews } from '../../src/learning/service.js';
import { seedLearningState } from '../../src/learning/seed.js';
import { TEST_DATABASE_URL } from '../db/setup.js';
import { clearLearning } from './helpers.js';

/**
 * Der Abruf der Wiederholungs-Queue gegen echte Daten (AP4.T4.4).
 *
 * Das Verfahren selbst ist in `review.test.ts` ohne Datenbank durchgerechnet.
 * Hier geht es um das, was nur die Datenbank beantworten kann: Welche
 * Eintraege sind zu einem gegebenen Zeitpunkt faellig, in welcher Reihenfolge
 * kommen sie, und was steht in der Antwort. **Kein KI-Aufruf.**
 */
describe('dueReviews und upcomingReviews (AP4.T4.4)', () => {
  let handle: DbHandle;
  let chapterId: string;

  /** Zeitpunkte: Der Strom beginnt am 1. Januar. */
  const DAY = 24 * 60 * 60 * 1000;
  const START = new Date('2026-01-01T08:00:00.000Z');
  const at = (day: number): Date => new Date(START.getTime() + day * DAY);

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
        contentHash: 'hash-t44-chapter',
      })
      .returning({ id: bookChapter.id });
    chapterId = (chapter as { id: string }).id;
    await seedLearningState(handle.db);
  });

  /** Legt ein Konzept an und liefert seine ID. */
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

  /** Zeichnet ein Ereignis auf - der einzige Weg in die Queue. */
  async function record(
    conceptId: string,
    day: number,
    overrides: Partial<RecordLearningEventInput> = {},
  ): Promise<void> {
    const input = {
      id: randomUUID(),
      eventType: 'question_answered',
      source: 'theory_session',
      signalClass: 'objective',
      conceptId,
      occurredAt: at(day).toISOString(),
      payload: { correct: false },
      ...overrides,
    } as RecordLearningEventInput;
    const result = await recordLearningEvent(handle.db, input);
    expect(result.status).toBe('recorded');
  }

  /* --- Einplanung je Ursprung ------------------------------------------ */

  it('plant einen Fehlschlag mit Ursprung "error" ein', async () => {
    const id = await addConcept('t44-fehler');
    await record(id, 0, {
      source: 'drill',
      eventType: 'drill_completed',
      payload: { correct: 1, total: 5 },
    });

    const response = await dueReviews(handle.db, { context: 'session', limit: 10, asOf: at(5) });

    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      conceptId: id,
      origin: 'error',
      lapses: 1,
      repetitions: 0,
      intervalDays: 1,
    });
  });

  it('plant einen Stand ohne objektives Signal mit Ursprung "knowledge_gap" ein', async () => {
    const id = await addConcept('t44-luecke');
    await record(id, 0, {
      eventType: 'concept_explained',
      signalClass: 'ai_judged',
      payload: { quality: 0.9 },
    });

    const response = await dueReviews(handle.db, { context: 'session', limit: 10, asOf: at(5) });

    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({ conceptId: id, origin: 'knowledge_gap', lapses: 0 });
  });

  it('plant einen Fehlschlag aus der Hand-Analyse mit Ursprung "practice_finding" ein', async () => {
    const id = await addConcept('t44-praxis');
    await record(id, 0, {
      eventType: 'hand_analyzed',
      source: 'hand_analysis',
      payload: { correct: false, handRef: 'hh-7' },
    });

    const response = await dueReviews(handle.db, { context: 'session', limit: 10, asOf: at(5) });

    expect(response.items[0]).toMatchObject({ conceptId: id, origin: 'practice_finding' });
  });

  it('nimmt ein sauber objektiv belegtes Konzept ohne Fehler nicht auf', async () => {
    const id = await addConcept('t44-sitzt');
    await record(id, 0, { payload: { correct: true } });

    const response = await dueReviews(handle.db, { context: 'session', limit: 10, asOf: at(5) });
    expect(response.dueTotal).toBe(0);
    expect(response.items).toEqual([]);
  });

  /* --- Bezugszeitpunkt --------------------------------------------------- */

  it('liefert je nach Bezugszeitpunkt unterschiedliche Ergebnisse', async () => {
    const id = await addConcept('t44-zeit');
    // Fehlschlag am Tag 0 in der Lernphase: faellig am Tag 1.
    await record(id, 0);

    const vorher = await dueReviews(handle.db, {
      context: 'session',
      limit: 10,
      asOf: at(0.5),
    });
    const nachher = await dueReviews(handle.db, { context: 'session', limit: 10, asOf: at(3) });

    // Derselbe Datenbestand, nur ein anderer Bezugszeitpunkt.
    expect(vorher.dueTotal).toBe(0);
    expect(vorher.items).toEqual([]);
    expect(nachher.dueTotal).toBe(1);
    expect(nachher.items[0]).toMatchObject({ conceptId: id, overdueDays: 2 });
    expect(vorher.asOf).not.toBe(nachher.asOf);
  });

  /* --- Anzahl und Auffuellen -------------------------------------------- */

  it('respektiert die angeforderte Anzahl und weist die tatsaechliche Fälligenzahl aus', async () => {
    for (let i = 0; i < 5; i += 1) {
      const id = await addConcept(`t44-viele-${i}`);
      await record(id, 0);
    }

    const response = await dueReviews(handle.db, { context: 'drill', limit: 2, asOf: at(10) });

    expect(response.returned).toBe(2);
    expect(response.items).toHaveLength(2);
    // Die ehrliche Zahl: Es waren fuenf faellig, geliefert wurden zwei.
    expect(response.dueTotal).toBe(5);
    expect(response.limit).toBe(2);
    expect(response.context).toBe('drill');
  });

  it('fuellt nicht kuenstlich auf, wenn weniger faellig sind als angefordert', async () => {
    const id = await addConcept('t44-wenig');
    await record(id, 0);

    const response = await dueReviews(handle.db, { context: 'session', limit: 10, asOf: at(10) });

    expect(response.items).toHaveLength(1);
    expect(response.returned).toBe(1);
    expect(response.dueTotal).toBe(1);
    expect(response.limit).toBe(10);
  });

  /* --- Reihenfolge gegen echte Daten ------------------------------------ */

  it('ordnet nach Ueberfaelligkeit, Ursprung und Mastery', async () => {
    const alt = await addConcept('t44-ord-alt');
    const fehler = await addConcept('t44-ord-fehler');
    const luecke = await addConcept('t44-ord-luecke');

    // Weit ueberfaellig, aber nur eine Luecke.
    await record(alt, 0, {
      eventType: 'concept_explained',
      signalClass: 'ai_judged',
      payload: { quality: 0.9 },
    });
    // Frisch faellig, aber ein echter Fehler.
    await record(fehler, 9);
    // Ebenfalls frisch faellig, nur eine Luecke.
    await record(luecke, 9, {
      eventType: 'concept_explained',
      signalClass: 'ai_judged',
      payload: { quality: 0.9 },
    });

    const response = await dueReviews(handle.db, { context: 'session', limit: 10, asOf: at(11) });

    expect(response.items.map((item) => item.conceptId)).toEqual([alt, fehler, luecke]);
    expect(response.items[0]?.overdueDays).toBeGreaterThan(
      response.items[1]?.overdueDays as number,
    );
  });

  it('zieht eine faellige Voraussetzung vor das darauf aufbauende Konzept', async () => {
    const basis = await addConcept('t44-basis');
    const aufbau = await addConcept('t44-aufbau');
    await handle.db
      .insert(conceptPrerequisite)
      .values({ conceptId: aufbau, prerequisiteId: basis });

    // Der Aufbau ist der dringendere Fall - ein Fehler gegen eine blosse
    // Luecke -, kommt aber trotzdem hinter seiner Voraussetzung.
    await record(aufbau, 0);
    await record(basis, 0, {
      eventType: 'concept_explained',
      signalClass: 'ai_judged',
      payload: { quality: 0.9 },
    });

    const response = await dueReviews(handle.db, { context: 'session', limit: 10, asOf: at(5) });

    expect(response.items.map((item) => item.conceptId)).toEqual([basis, aufbau]);
  });

  /* --- Kontext-Filter (Andockpunkt fuer AP8) ---------------------------- */

  it('schraenkt auf Themenbereiche ein, wenn der Aufrufer welche angibt', async () => {
    const preflop = await addConcept('t44-preflop', 'preflop-ranges');
    const flop = await addConcept('t44-flop', 'flop-spiel');
    await record(preflop, 0);
    await record(flop, 0);

    const alle = await dueReviews(handle.db, { context: 'tournament', limit: 10, asOf: at(5) });
    const nurPreflop = await dueReviews(handle.db, {
      context: 'tournament',
      limit: 10,
      asOf: at(5),
      topicAreas: ['preflop-ranges'],
    });

    expect(alle.dueTotal).toBe(2);
    expect(nurPreflop.dueTotal).toBe(1);
    expect(nurPreflop.items[0]?.conceptId).toBe(preflop);
    expect(nurPreflop.items[0]?.topicArea).toBe('preflop-ranges');
  });

  /* --- Vorschau ---------------------------------------------------------- */

  it('liefert als Vorschau, was demnaechst faellig wird - aber nichts Faelliges', async () => {
    const bald = await addConcept('t44-bald');
    const jetzt = await addConcept('t44-jetzt');
    // `bald` ist am Tag 1 faellig, `jetzt` ebenfalls - wir fragen am Tag 0,5
    // beziehungsweise am Tag 2.
    await record(bald, 0);
    await record(jetzt, 0);

    const vorschau = await upcomingReviews(handle.db, {
      asOf: at(0.5),
      withinDays: 7,
      limit: 10,
    });
    expect(vorschau.total).toBe(2);
    expect(vorschau.items.map((item) => item.conceptId).sort()).toEqual([bald, jetzt].sort());
    expect(vorschau.items[0]?.inDays).toBe(1);

    // Nach der Faelligkeit taucht nichts mehr in der Vorschau auf - dafuer ist
    // `dueReviews` zustaendig.
    const spaeter = await upcomingReviews(handle.db, { asOf: at(3), withinDays: 7, limit: 10 });
    expect(spaeter.total).toBe(0);
  });

  it('weist auch in der Vorschau die Gesamtzahl unabhaengig vom Limit aus', async () => {
    for (let i = 0; i < 4; i += 1) {
      const id = await addConcept(`t44-vorschau-${i}`);
      await record(id, 0);
    }

    const vorschau = await upcomingReviews(handle.db, {
      asOf: at(0.5),
      withinDays: 30,
      limit: 2,
    });

    expect(vorschau.items).toHaveLength(2);
    expect(vorschau.total).toBe(4);
  });

  /* --- Determinismus gegen echte Daten ---------------------------------- */

  it('erzeugt bei derselben Ereignisfolge dieselben Faelligkeiten', async () => {
    const id = await addConcept('t44-determinismus');
    await record(id, 0, { payload: { correct: true } });
    await record(id, 1, { payload: { correct: true } });
    await record(id, 7, { payload: { correct: false } });

    const queue = await handle.db.execute<{ due_at: string; interval_days: number }>(
      sql`select due_at, interval_days from review_queue`,
    );
    const erste = queue.rows[0];

    // Ein Fehlschlag nach zwei Erfolgen ist ein echter Rueckfall: Intervall 0,
    // wieder faellig eine Stunde nach dem Ereignis am Tag 7.
    expect(erste?.interval_days).toBe(0);
    expect(new Date(erste?.due_at ?? 0).toISOString()).toBe('2026-01-08T09:00:00.000Z');

    // Der Konzept-Eintrag haengt am Ereignisstrom, nicht an der Uhr: Ein
    // erneuter Abruf zu einem ganz anderen Zeitpunkt aendert die Faelligkeit
    // nicht.
    const spaet = await dueReviews(handle.db, { context: 'session', limit: 10, asOf: at(400) });
    expect(spaet.items[0]?.dueAt).toBe('2026-01-08T09:00:00.000Z');
  });

  it('haelt die Queue an das Ereignisprotokoll gebunden - eine Korrektur wirkt durch', async () => {
    const id = await addConcept('t44-korrektur');
    const fehler = randomUUID();
    await recordLearningEvent(handle.db, {
      id: fehler,
      eventType: 'question_answered',
      source: 'theory_session',
      signalClass: 'objective',
      conceptId: id,
      occurredAt: at(0).toISOString(),
      payload: { correct: false },
    });
    expect(
      (await dueReviews(handle.db, { context: 'session', limit: 5, asOf: at(5) })).dueTotal,
    ).toBe(1);

    await recordLearningEvent(handle.db, {
      id: randomUUID(),
      eventType: 'manual_correction',
      source: 'manual',
      signalClass: 'self_reported',
      conceptId: id,
      occurredAt: at(1).toISOString(),
      correctsEventId: fehler,
      payload: { reason: 'Chart war falsch digitalisiert.' },
    });

    // Das aufgehobene Ereignis traegt nichts mehr bei - der Eintrag ist weg.
    const nachher = await dueReviews(handle.db, { context: 'session', limit: 5, asOf: at(5) });
    expect(nachher.dueTotal).toBe(0);

    // Das urspruengliche Ereignis steht weiterhin unveraendert im Protokoll -
    // korrigiert wird die Wirkung, nicht die Historie.
    const events = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event where id = ${fehler}`,
    );
    expect(Number(events.rows[0]?.n)).toBe(1);
  });
});
