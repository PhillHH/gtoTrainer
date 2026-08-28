import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADVANCE_REASONS,
  CONCEPT_TOPIC_AREA_IDS,
  LEARNER_LEVELS,
  LEARNING_ERROR_SEVERITIES,
  REVIEW_QUEUE_ORIGINS,
} from '@gto/shared';
import type {
  ConceptLearningDetail,
  ConceptTopicArea,
  LearningDashboard,
  QueuePreview,
  RatingsOverview,
  RecordLearningEventInput,
} from '@gto/shared';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { bookChapter, concept, conceptPrerequisite } from '../../src/db/schema.js';
import {
  readConceptDetail,
  readDashboard,
  readQueuePreview,
  readRatingsOverview,
} from '../../src/learning/read.js';
import { recordLearningEvent } from '../../src/learning/service.js';
import { seedLearningState } from '../../src/learning/seed.js';
import { TEST_DATABASE_URL } from '../db/setup.js';
import { attachApprovedChart, clearLearning } from './helpers.js';

/**
 * Die State-API gegen echte Daten (AP4.T4.7).
 *
 * Drei Dinge werden hier geprueft, die nur zusammen etwas wert sind:
 *
 * 1. **Vertrag** - die Antworten passen zu den Typen aus `packages/shared`.
 *    Ein stillschweigend geaendertes Feld macht einen Test rot, damit AP6 sich
 *    darauf verlassen kann.
 * 2. **Kein N+1** - die Zahl der Abfragen des Aggregats haengt nicht an der
 *    Zahl der Konzepte.
 * 3. **Lesend bleibt lesend** - kein Abruf fasst den Lernstand an.
 *
 * **Kein KI-Aufruf.**
 */
describe('State-API (AP4.T4.7)', () => {
  let handle: DbHandle;
  let chapterIds: Record<number, string>;

  const DAY = 24 * 60 * 60 * 1000;
  const START = new Date('2026-01-05T09:00:00.000Z');
  const at = (day: number, hour = 0): Date =>
    new Date(START.getTime() + day * DAY + hour * 60 * 60 * 1000);
  const AS_OF = at(30);

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL, { max: 4 });
  });

  afterAll(async () => {
    await clearLearning(handle.db);
    await handle.close();
  });

  beforeEach(async () => {
    await clearLearning(handle.db);
    chapterIds = {};
    for (const [number, title] of [
      [1, 'Poker Fundamentals'],
      [2, 'The Elements of Game Theory'],
    ] as const) {
      const [row] = await handle.db
        .insert(bookChapter)
        .values({
          partNumber: 1,
          partTitle: 'Testteil',
          chapterNumber: number,
          title,
          ordinal: number - 1,
          contentHash: `hash-t47-${number}`,
        })
        .returning({ id: bookChapter.id });
      chapterIds[number] = (row as { id: string }).id;
    }
    await seedLearningState(handle.db);
  });

  async function addConcept(
    slug: string,
    title: string,
    topicArea: ConceptTopicArea,
    chapter = 1,
  ): Promise<string> {
    const [row] = await handle.db
      .insert(concept)
      .values({
        chapterId: chapterIds[chapter] as string,
        slug,
        title,
        summary: `Kurzdefinition zu ${title}.`,
        topicArea,
        minLevel: 'fortgeschritten',
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
      payload: { correct: true },
      ...overrides,
    } as RecordLearningEventInput);
  }

  /**
   * Ein kleiner, aber realistischer Lernverlauf: ein Konzept, das sitzt, eines
   * mit einem Fehler und anschliessender Wiederholung, und eines, das nur auf
   * Modellurteilen beruht.
   */
  async function seedHistory(): Promise<{ solide: string; wackelig: string; duenn: string }> {
    const solide = await addConcept('t47-solide', 'Position am Tisch', 'grundlagen-mathematik', 1);
    const wackelig = await addConcept('t47-wackelig', 'SB-Verteidigung', 'preflop-verteidigung', 1);
    const duenn = await addConcept('t47-duenn', 'Gleichgewicht', 'spieltheorie', 2);
    await addConcept('t47-unberuehrt', 'Noch nie geübt', 'river-spiel', 2);

    await attachApprovedChart(handle.db, solide);

    for (const day of [0, 2, 5, 9]) await record(solide, day);
    // Fehler, dann Wiederholung - der Fall, der sich in Mastery, Queue und
    // Rating zugleich niederschlagen muss.
    await record(wackelig, 3, { payload: { correct: false } });
    await record(wackelig, 6, { eventType: 'review_performed', payload: { correct: true } });
    await record(wackelig, 12, { payload: { correct: false } });
    for (const day of [1, 4, 8])
      await record(duenn, day, {
        eventType: 'concept_explained',
        source: 'theory_session',
        signalClass: 'ai_judged',
        payload: { quality: 0.9 },
      });

    return { solide, wackelig, duenn };
  }

  /* --- 1. Dashboard ------------------------------------------------------ */

  it('liefert ein vollstaendiges Dashboard-Aggregat gegen echte Daten', async () => {
    const { wackelig } = await seedHistory();
    const dashboard = await readDashboard(handle.db, AS_OF);

    expectDashboardContract(dashboard);
    expect(dashboard.empty).toBe(false);
    expect(dashboard.totals).toMatchObject({ concepts: 4, withEvidence: 3, events: 10 });
    expect(dashboard.chapters.map((c) => [c.chapterNumber, c.concepts, c.untouched])).toEqual([
      [1, 2, 0],
      [2, 2, 1],
    ]);
    // Das wacklige Konzept steht in der Queue und im Fehlerprotokoll.
    expect(dashboard.dueCount).toBeGreaterThan(0);
    expect(dashboard.duePreview.some((item) => item.conceptId === wackelig)).toBe(true);
    expect(dashboard.totals.openErrors).toBe(2);
    // Alle zwoelf Achsen, auch die ohne Datenlage.
    expect(dashboard.ratings).toHaveLength(12);
  });

  it('liefert beim Erststart eine sinnvolle Antwort statt eines Fehlers', async () => {
    // Kein einziges Ereignis - der Zustand, in dem die Seite zum ersten Mal
    // geoeffnet wird.
    const dashboard = await readDashboard(handle.db, AS_OF);

    expectDashboardContract(dashboard);
    expect(dashboard.empty).toBe(true);
    expect(dashboard.level).toBe('einsteiger');
    expect(dashboard.currentChapter).toBe(1);
    expect(dashboard.dueCount).toBe(0);
    expect(dashboard.duePreview).toEqual([]);
    expect(dashboard.report).toBeNull();
    expect(dashboard.totals).toEqual({
      concepts: 0,
      withEvidence: 0,
      mastered: 0,
      events: 0,
      openErrors: 0,
    });
    // Die Achsen sind da, nur leer - eine fehlende Achse waere in der Anzeige
    // nicht von einer schlechten zu unterscheiden.
    expect(dashboard.ratings).toHaveLength(12);
    expect(dashboard.ratings.every((entry) => entry.rating === 0)).toBe(true);
    // Und die Kapitel stehen, obwohl noch nichts gelernt wurde.
    expect(dashboard.chapters).toHaveLength(2);
  });

  it('kommt ohne N+1 aus: die Abfragezahl haengt nicht an der Zahl der Konzepte', async () => {
    await seedHistory();
    const klein = await countQueries(handle.pool, () => readDashboard(handle.db, AS_OF));

    // Zwanzig weitere Konzepte, jedes mit Ereignissen.
    for (let i = 0; i < 20; i += 1) {
      const id = await addConcept(`t47-n1-${i}`, `Konzept ${i}`, 'flop-spiel', 2);
      await record(id, 1 + (i % 5));
    }
    const gross = await countQueries(handle.pool, () => readDashboard(handle.db, AS_OF));

    // Gleiche Abfragezahl bei sechsfacher Konzeptzahl.
    expect(gross.queries).toBe(klein.queries);
    expect(gross.result.totals.concepts).toBe(24);
    // Und die Zahl ist klein und konstant, nicht "nur zufaellig gleich".
    expect(klein.queries).toBeLessThanOrEqual(12);
    console.warn(
      `[T4.7] Dashboard-Aggregat: ${klein.queries} Abfragen bei 4 und bei 24 Konzepten.`,
    );
  });

  /* --- 2. Konzeptdetail --------------------------------------------------- */

  it('zeigt Score und Konfidenz getrennt, mit Zaehlern je Signalklasse', async () => {
    const { duenn } = await seedHistory();
    const detail = await readConceptDetail(handle.db, duenn, AS_OF);

    expect(detail).not.toBeNull();
    expectConceptDetailContract(detail as ConceptLearningDetail);

    // Drei KI-Bewertungen: guter Score, aber niedrige Konfidenz und **kein**
    // objektives Signal - genau der Unterschied, den T4.3 sichtbar macht.
    expect(detail?.mastery?.signalCounts).toEqual({
      objective: 0,
      aiJudged: 3,
      selfReported: 0,
    });
    expect(detail?.mastery?.score).toBeGreaterThan(0.5);
    expect(detail?.mastery?.confidence).toBeLessThan(detail?.mastery?.score as number);
    // Fuer dieses Konzept gibt es kein freigegebenes Chart (Scope-Delta 2).
    expect(detail?.objectiveAnchorsPossible).toBe(false);
    expect(detail?.charts).toEqual([]);
  });

  it('reicht die Weiterschalt-Entscheidung unveraendert durch', async () => {
    const { solide, duenn } = await seedHistory();

    const mitAnker = await readConceptDetail(handle.db, solide, AS_OF);
    const ohneAnker = await readConceptDetail(handle.db, duenn, AS_OF);

    // Alle Begruendungsbausteine aus T4.3 sind da - unveraendert.
    expect(Object.keys(mitAnker?.advance ?? {}).sort()).toEqual([
      'allowed',
      'blockers',
      'confidence',
      'daysSinceLastCheck',
      'objectiveAnchors',
      'objectiveAnchorsPossible',
      'reason',
      'requiredObjectiveAnchors',
      'score',
      'signalCounts',
      'storedConfidence',
      'substituteAnchors',
      'threshold',
    ]);

    expect(ADVANCE_REASONS).toContain(mitAnker?.advance.reason);
    expect(mitAnker?.advance.objectiveAnchorsPossible).toBe(true);

    // Ohne moegliche Anker greift der Uebergangszustand aus Scope-Delta 2 -
    // und der laesst eine reine Serie von Modellurteilen trotzdem nicht durch.
    // Genau das ist die Absicherung gegen R3, hier bis in die Anzeige sichtbar.
    expect(ohneAnker?.advance.objectiveAnchorsPossible).toBe(false);
    expect(ohneAnker?.advance.reason).toBe('insufficient_substitute_anchors');
    expect(ohneAnker?.advance.substituteAnchors).toBe(0);
    expect(ohneAnker?.advance.signalCounts).toEqual({
      objective: 0,
      aiJudged: 3,
      selfReported: 0,
    });
  });

  it('liefert Mastery-Historie, Queue-Zustand und Voraussetzungen in beide Richtungen', async () => {
    const { solide, wackelig } = await seedHistory();
    await handle.db
      .insert(conceptPrerequisite)
      .values({ conceptId: wackelig, prerequisiteId: solide });

    const aufbau = await readConceptDetail(handle.db, wackelig, AS_OF);
    const basis = await readConceptDetail(handle.db, solide, AS_OF);

    expect(aufbau?.prerequisites.map((entry) => entry.title)).toEqual(['Position am Tisch']);
    expect(basis?.dependents.map((entry) => entry.title)).toEqual(['SB-Verteidigung']);

    // Ein Punkt je Tag mit Ereignissen - drei Ereignisse an drei Tagen.
    expect(aufbau?.history.map((point) => point.day)).toEqual([
      '2026-01-08',
      '2026-01-11',
      '2026-01-17',
    ]);
    // Der Fehler nach der Wiederholung ist ein echter Rueckfall.
    expect(aufbau?.queue).toMatchObject({ origin: 'error', lapses: 2, repetitions: 0 });
    expect(aufbau?.recentErrors).toHaveLength(2);
  });

  it('liefert fuer ein unbekanntes Konzept null statt eines Fehlers', async () => {
    expect(
      await readConceptDetail(handle.db, '00000000-0000-4000-8000-000000000000', AS_OF),
    ).toBeNull();
  });

  /* --- 3. Queue-Vorschau -------------------------------------------------- */

  it('respektiert den Bezugszeitpunkt und die Reihenfolge aus T4.4', async () => {
    await seedHistory();

    // Faelligkeiten stehen fest (aus den Ereigniszeitstempeln); der
    // Bezugszeitpunkt entscheidet nur, was davon **jetzt** dran ist.
    const frueh = await readQueuePreview(handle.db, { asOf: at(13) });
    const spaet = await readQueuePreview(handle.db, { asOf: at(30) });

    expectQueueContract(frueh);
    expectQueueContract(spaet);

    // Derselbe Bestand, zwei Zeitpunkte, zwei Ergebnisse.
    expect(frueh.due.dueTotal).toBe(1);
    expect(spaet.due.dueTotal).toBe(2);
    expect(frueh.upcoming.total).toBeGreaterThan(0);
    expect(spaet.upcoming.total).toBe(0);
    expect(frueh.asOf).not.toBe(spaet.asOf);
    // Reihenfolge: das am laengsten Ueberfaellige zuerst.
    const overdue = spaet.due.items.map((item) => item.overdueDays);
    expect([...overdue].sort((a, b) => b - a)).toEqual(overdue);
  });

  it('filtert nach Kontext und reicht die tatsaechliche Faelligenzahl durch', async () => {
    await seedHistory();
    const preview = await readQueuePreview(handle.db, { asOf: at(30), context: 'drill', limit: 1 });

    expect(preview.context).toBe('drill');
    expect(preview.due.limit).toBe(1);
    expect(preview.due.items.length).toBeLessThanOrEqual(1);
    // Die ehrliche Zahl bleibt sichtbar.
    expect(preview.due.dueTotal).toBeGreaterThanOrEqual(preview.due.returned);
  });

  /* --- 4. Ratings- und Level-Verlauf -------------------------------------- */

  it('liefert Ratings mit Verlauf und den Level-Verlauf', async () => {
    await seedHistory();
    const overview = await readRatingsOverview(handle.db, { asOf: AS_OF, days: 90 });

    expectRatingsContract(overview);
    expect(overview.current).toHaveLength(12);
    expect(overview.history).toHaveLength(12);

    const grundlagen = overview.history.find(
      (entry) => entry.topicArea === 'grundlagen-mathematik',
    );
    // Vier Ereignisse an vier Tagen ergeben vier Verlaufspunkte.
    expect(grundlagen?.points.map((point) => point.day)).toEqual([
      '2026-01-05',
      '2026-01-07',
      '2026-01-10',
      '2026-01-14',
    ]);
    expect(grundlagen?.points.every((point) => point.rating >= 0 && point.rating <= 1)).toBe(true);
  });

  it('zeigt im Level-Verlauf, wann und warum sich das Niveau geaendert hat', async () => {
    // Genug Beleglage fuer einen Aufstieg: sechs Konzepte in drei
    // Themenbereichen, je vier objektive Treffer.
    const areas: ConceptTopicArea[] = ['preflop-ranges', 'flop-spiel', 'turn-spiel'];
    for (let i = 0; i < 6; i += 1) {
      const id = await addConcept(
        `t47-lvl-${i}`,
        `Level-Konzept ${i}`,
        areas[i % 3] as ConceptTopicArea,
        2,
      );
      for (let n = 0; n < 4; n += 1) await record(id, n, {}, n);
    }

    const overview = await readRatingsOverview(handle.db, { asOf: AS_OF, days: 90 });

    expect(overview.levelHistory.length).toBeGreaterThanOrEqual(1);
    const wechsel = overview.levelHistory[0];
    expect(wechsel?.previousLevel).toBe('einsteiger');
    expect(LEARNER_LEVELS).toContain(wechsel?.level);
    expect(wechsel?.source).toBe('automatic');
    // Das "warum": die Kennzahlen, die den Wechsel getragen haben.
    expect(wechsel?.signals.masteredConcepts).toBeGreaterThanOrEqual(5);
    expect(wechsel?.signals.objectiveShare).toBe(1);
    expect(wechsel?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('weist eine manuelle Level-Setzung im Verlauf als solche aus', async () => {
    await seedHistory();
    // Mit ausdruecklichem Zeitpunkt im betrachteten Zeitraum - `asOf` steuert,
    // welcher Ausschnitt der Historie gezeigt wird.
    await recordLearningEvent(handle.db, {
      id: randomUUID(),
      eventType: 'level_set',
      source: 'manual',
      signalClass: 'self_reported',
      occurredAt: at(20).toISOString(),
      payload: { level: 'experte' },
    });

    const overview = await readRatingsOverview(handle.db, { asOf: AS_OF, days: 90 });
    const manuell = overview.levelHistory.find((point) => point.source === 'manual');

    expect(manuell?.level).toBe('experte');
    expect(manuell?.previousLevel).toBe('einsteiger');
  });

  /* --- Lesend bleibt lesend ------------------------------------------------ */

  it('veraendert bei keinem der vier Abrufe den Lernstand', async () => {
    const { solide } = await seedHistory();

    const zaehlstaende = async (): Promise<Record<string, number>> => {
      const rows = await handle.db.execute<Record<string, string>>(
        sql`select (select count(*) from learning_event)  as ereignisse,
                   (select count(*) from concept_mastery) as mastery,
                   (select count(*) from review_queue)    as queue,
                   (select count(*) from skill_rating)    as ratings,
                   (select count(*) from error_log)       as fehler,
                   (select count(*) from skill_rating_snapshot) as snapshots,
                   (select coalesce(sum(score), 0) from concept_mastery)  as score_summe,
                   (select coalesce(sum(rating), 0) from skill_rating)    as rating_summe`,
      );
      return Object.fromEntries(
        Object.entries(rows.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
      );
    };

    const vorher = await zaehlstaende();

    await readDashboard(handle.db, AS_OF);
    await readConceptDetail(handle.db, solide, AS_OF);
    await readQueuePreview(handle.db, { asOf: AS_OF });
    await readRatingsOverview(handle.db, { asOf: AS_OF, days: 90 });

    // Nicht nur die Zeilenzahlen - auch die Werte. Ein Abruf, der einen Score
    // neu berechnet und speichert, faellt hier auf.
    expect(await zaehlstaende()).toEqual(vorher);
  });
});

/* -------------------------------------------------------------------------
 * Vertragspruefungen gegen die `shared`-Typen
 *
 * TypeScript prueft die Form zur Uebersetzungszeit; diese Funktionen pruefen
 * sie zur Laufzeit. Beides zusammen faengt den Fall ab, dass eine Antwort
 * strukturell passt, aber ein Pflichtfeld `undefined` enthaelt - was der
 * Compiler bei einer Datenbankantwort nicht sieht.
 * ---------------------------------------------------------------------- */

function expectDashboardContract(value: LearningDashboard): void {
  expect(typeof value.asOf).toBe('string');
  expect(typeof value.empty).toBe('boolean');
  expect(LEARNER_LEVELS).toContain(value.level);
  expect(['automatic', 'manual']).toContain(value.levelSource);
  expect(LEARNER_LEVELS).toContain(value.automaticLevel);
  expect(Array.isArray(value.chapters)).toBe(true);
  for (const chapter of value.chapters) {
    expect(Object.keys(chapter).sort()).toEqual([
      'averageScore',
      'chapterNumber',
      'concepts',
      'inProgress',
      'mastered',
      'title',
      'untouched',
    ]);
    expect(chapter.concepts).toBe(chapter.mastered + chapter.inProgress + chapter.untouched);
  }
  expect(value.ratings.map((entry) => entry.topicArea)).toEqual([...CONCEPT_TOPIC_AREA_IDS]);
  expect(Object.keys(value.totals).sort()).toEqual([
    'concepts',
    'events',
    'mastered',
    'openErrors',
    'withEvidence',
  ]);
  expect(typeof value.dueCount).toBe('number');
  expect(typeof value.upcomingCount).toBe('number');
  expect(typeof value.currentChapter).toBe('number');
  if (value.report !== null) {
    expect(Object.keys(value.report).sort()).toEqual([
      'generatedAt',
      'id',
      'note',
      'patterns',
      'status',
    ]);
  }
}

function expectConceptDetailContract(value: ConceptLearningDetail): void {
  expect(Object.keys(value).sort()).toEqual([
    'advance',
    'chapterNumber',
    'chapterTitle',
    'charts',
    'conceptId',
    'dependents',
    'history',
    'mastery',
    'minLevel',
    'objectiveAnchorsPossible',
    'prerequisites',
    'queue',
    'recentErrors',
    'state',
    'summary',
    'title',
    'topicArea',
    'topicAreaLabel',
  ]);
  expect(CONCEPT_TOPIC_AREA_IDS).toContain(value.topicArea);
  expect(['draft', 'approved']).toContain(value.state);
  expect(LEARNER_LEVELS).toContain(value.minLevel);
  expect(ADVANCE_REASONS).toContain(value.advance.reason);
  for (const point of value.history) {
    expect(point.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(point.score).toBeGreaterThanOrEqual(0);
    expect(point.confidence).toBeLessThanOrEqual(1);
  }
  for (const entry of value.recentErrors) {
    expect(LEARNING_ERROR_SEVERITIES).toContain(entry.severity);
  }
  if (value.queue !== null) {
    expect(REVIEW_QUEUE_ORIGINS).toContain(value.queue.origin);
  }
}

function expectQueueContract(value: QueuePreview): void {
  expect(Object.keys(value).sort()).toEqual(['asOf', 'context', 'due', 'upcoming']);
  expect(Object.keys(value.due).sort()).toEqual([
    'asOf',
    'context',
    'dueTotal',
    'items',
    'limit',
    'returned',
  ]);
  expect(Object.keys(value.upcoming).sort()).toEqual(['asOf', 'items', 'total', 'withinDays']);
  for (const item of value.due.items) {
    expect(REVIEW_QUEUE_ORIGINS).toContain(item.origin);
    expect(typeof item.conceptTitle).toBe('string');
  }
}

function expectRatingsContract(value: RatingsOverview): void {
  expect(Object.keys(value).sort()).toEqual([
    'asOf',
    'current',
    'days',
    'history',
    'level',
    'levelHistory',
  ]);
  expect(value.current.map((entry) => entry.topicArea)).toEqual([...CONCEPT_TOPIC_AREA_IDS]);
  expect(value.history.map((entry) => entry.topicArea)).toEqual([...CONCEPT_TOPIC_AREA_IDS]);
  expect(LEARNER_LEVELS).toContain(value.level);
  for (const point of value.levelHistory) {
    expect(LEARNER_LEVELS).toContain(point.level);
    expect(LEARNER_LEVELS).toContain(point.previousLevel);
    expect(Object.keys(point.signals).sort()).toEqual([
      'averageRating',
      'coveredTopicAreas',
      'masteredConcepts',
      'objectiveShare',
      'totalSignals',
    ]);
  }
}

/**
 * Zaehlt die Datenbankabfragen eines Aufrufs.
 *
 * Gemessen wird am Pool, nicht am ORM: So zaehlt jede Rundreise, auch die, die
 * Drizzle intern absetzt.
 */
async function countQueries<T>(
  pool: DbHandle['pool'],
  run: () => Promise<T>,
): Promise<{ result: T; queries: number }> {
  let queries = 0;
  const original = pool.query.bind(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = (...args: unknown[]) => {
    queries += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (original as any)(...args);
  };
  try {
    return { result: await run(), queries };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = original;
  }
}
