import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  CONCEPT_TOPIC_AREA_IDS,
  LEARNING_ERROR_SEVERITIES,
  LEARNING_EVENT_SOURCES,
  LEARNING_EVENT_TYPES,
  LEARNING_SIGNAL_CLASSES,
  REVIEW_QUEUE_ORIGINS,
} from '@gto/shared';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import {
  LEARNING_ERROR_SEVERITIES as DB_ERROR_SEVERITIES,
  LEARNING_EVENT_SOURCES as DB_EVENT_SOURCES,
  LEARNING_EVENT_TYPES as DB_EVENT_TYPES,
  LEARNING_SIGNAL_CLASSES as DB_SIGNAL_CLASSES,
  LEARNING_TABLES,
  REVIEW_QUEUE_ORIGINS as DB_QUEUE_ORIGINS,
  conceptMastery,
  errorLog,
  learnerState,
  learningEvent,
  reviewQueue,
  skillRating,
  skillRatingSnapshot,
} from '../../src/db/schema.js';
import { TEST_DATABASE_URL } from '../db/setup.js';
import { anEvent, clearLearning, failing, seedConcepts } from './helpers.js';
import type { LearningFixture } from './helpers.js';

/**
 * Schema, Invarianten und Fremdschluessel des Lernstand-Kerns (AP4.T4.1).
 *
 * Jede Invariante aus dem Task hat hier genau einen Test, der ihre Verletzung
 * nachweislich verhindert. Geprueft wird gegen eine echte Postgres-Instanz -
 * eine Zusicherung, die nur im TypeScript steht, ist keine Invariante.
 */
describe('Lernstand-Schema (AP4.T4.1)', () => {
  let handle: DbHandle;
  let fixture: LearningFixture;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL, { max: 2 });
    await clearLearning(handle.db);
    fixture = await seedConcepts(handle.db);
  });

  afterAll(async () => {
    await clearLearning(handle.db);
    await handle.close();
  });

  /* --- Migration -------------------------------------------------------- */

  it('legt alle sechs Lernstand-Tabellen an', async () => {
    const result = await handle.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
            and table_name = any(${sql.raw(`array[${LEARNING_TABLES.map((t) => `'${t}'`).join(',')}]`)})
          order by table_name`,
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([...LEARNING_TABLES].sort());
  });

  it('haelt die geschlossenen Mengen im Schema deckungsgleich mit packages/shared', () => {
    expect(DB_SIGNAL_CLASSES).toEqual(LEARNING_SIGNAL_CLASSES);
    expect(DB_EVENT_TYPES).toEqual(LEARNING_EVENT_TYPES);
    expect(DB_EVENT_SOURCES).toEqual(LEARNING_EVENT_SOURCES);
    expect(DB_QUEUE_ORIGINS).toEqual(REVIEW_QUEUE_ORIGINS);
    expect(DB_ERROR_SEVERITIES).toEqual(LEARNING_ERROR_SEVERITIES);
  });

  /* --- Invariante 1: Ereignisse sind unveraenderlich -------------------- */

  it('verhindert das Aendern eines Ereignisses (Append-only)', async () => {
    const [row] = await handle.db
      .insert(learningEvent)
      .values(anEvent(fixture.approvedConceptId))
      .returning({ id: learningEvent.id });
    const id = (row as { id: string }).id;

    expect(
      await failing(() =>
        handle.db.execute(
          sql`update learning_event set signal_class = 'self_reported' where id = ${id}`,
        ),
      ),
    ).toMatch(/append-only: UPDATE ist nicht zulaessig/);

    // Der Wert steht unveraendert in der Tabelle.
    const after = await handle.db.execute<{ signal_class: string }>(
      sql`select signal_class from learning_event where id = ${id}`,
    );
    expect(after.rows[0]?.signal_class).toBe('objective');
  });

  it('verhindert das Loeschen eines Ereignisses (Append-only)', async () => {
    const [row] = await handle.db
      .insert(learningEvent)
      .values(anEvent(fixture.approvedConceptId))
      .returning({ id: learningEvent.id });
    const id = (row as { id: string }).id;

    expect(
      await failing(() => handle.db.execute(sql`delete from learning_event where id = ${id}`)),
    ).toMatch(/append-only: DELETE ist nicht zulaessig/);

    const after = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event where id = ${id}`,
    );
    expect(Number(after.rows[0]?.n)).toBe(1);
  });

  it('nimmt eine Korrektur als neues Ereignis mit Bezug auf das urspruengliche an', async () => {
    const [original] = await handle.db
      .insert(learningEvent)
      .values(anEvent(fixture.approvedConceptId))
      .returning({ id: learningEvent.id });
    const originalId = (original as { id: string }).id;

    const [correction] = await handle.db
      .insert(learningEvent)
      .values(
        anEvent(fixture.approvedConceptId, {
          eventType: 'manual_correction',
          source: 'manual',
          signalClass: 'self_reported',
          correctsEventId: originalId,
        }),
      )
      .returning({ id: learningEvent.id, correctsEventId: learningEvent.correctsEventId });

    expect(correction?.correctsEventId).toBe(originalId);
  });

  it('lehnt eine Korrektur ohne Bezug auf ein Ereignis ab', async () => {
    expect(
      await failing(() =>
        handle.db.insert(learningEvent).values(
          anEvent(fixture.approvedConceptId, {
            eventType: 'manual_correction',
            source: 'manual',
          }),
        ),
      ),
    ).toMatch(/learning_event_correction_check/);
  });

  it('lehnt einen unbekannten Ereignistyp ab', async () => {
    expect(
      await failing(() =>
        handle.db
          .insert(learningEvent)
          .values(anEvent(fixture.approvedConceptId, { eventType: 'geraten' })),
      ),
    ).toMatch(/learning_event_type_check/);
  });

  it('lehnt eine unbekannte Signalklasse ab', async () => {
    expect(
      await failing(() =>
        handle.db
          .insert(learningEvent)
          .values(anEvent(fixture.approvedConceptId, { signalClass: 'bauchgefuehl' })),
      ),
    ).toMatch(/learning_event_signal_class_check/);
  });

  /* --- Invariante 2: Score und Konfidenz liegen zwischen 0 und 1 -------- */

  it('lehnt einen Mastery-Score ausserhalb von 0 bis 1 ab', async () => {
    expect(
      await failing(() =>
        handle.db
          .insert(conceptMastery)
          .values({ conceptId: fixture.approvedConceptId, score: 1.4, confidence: 0.5 }),
      ),
    ).toMatch(/concept_mastery_score_check/);
  });

  it('lehnt eine Konfidenz ausserhalb von 0 bis 1 ab', async () => {
    expect(
      await failing(() =>
        handle.db
          .insert(conceptMastery)
          .values({ conceptId: fixture.approvedConceptId, score: 0.5, confidence: -0.1 }),
      ),
    ).toMatch(/concept_mastery_confidence_check/);
  });

  it('fuehrt Score, Konfidenz und die Zaehler je Signalklasse getrennt', async () => {
    await handle.db.execute(sql`delete from concept_mastery`);
    const [row] = await handle.db
      .insert(conceptMastery)
      .values({
        conceptId: fixture.approvedConceptId,
        score: 0.9,
        confidence: 0.25,
        objectiveSignals: 0,
        aiJudgedSignals: 7,
        selfReportedSignals: 2,
      })
      .returning();

    // Hoher Score, niedrige Konfidenz, kein einziger objektiver Anker - genau
    // der Fall, den Scope-Delta 2 sichtbar machen will.
    expect(row).toMatchObject({
      score: 0.9,
      confidence: 0.25,
      objectiveSignals: 0,
      aiJudgedSignals: 7,
      selfReportedSignals: 2,
    });
    await handle.db.execute(sql`delete from concept_mastery`);
  });

  /* --- Invariante 3: genau ein Mastery-Datensatz je Konzept ------------- */

  it('laesst je Konzept nur einen Mastery-Datensatz zu', async () => {
    await handle.db.execute(sql`delete from concept_mastery`);
    await handle.db.insert(conceptMastery).values({ conceptId: fixture.approvedConceptId });

    expect(
      await failing(() =>
        handle.db.insert(conceptMastery).values({ conceptId: fixture.approvedConceptId }),
      ),
    ).toMatch(/concept_mastery_pkey/);

    await handle.db.execute(sql`delete from concept_mastery`);
  });

  /* --- Invariante 4: genau ein learner_state ---------------------------- */

  it('laesst nur einen einzigen learner_state zu', async () => {
    await handle.db.execute(sql`delete from learner_state`);
    await handle.db.insert(learnerState).values({});

    expect(await failing(() => handle.db.insert(learnerState).values({}))).toMatch(
      /learner_state_singleton_key/,
    );
  });

  it('lehnt eine learner_state-Zeile mit singleton = false ab', async () => {
    expect(
      await failing(() => handle.db.insert(learnerState).values({ singleton: false })),
    ).toMatch(/learner_state_singleton_check/);
  });

  it('lehnt eine Mastery-Schwelle ausserhalb von 0 bis 1 ab', async () => {
    expect(
      await failing(() => handle.db.execute(sql`update learner_state set mastery_threshold = 1.5`)),
    ).toMatch(/learner_state_threshold_check/);
  });

  /* --- Invariante 5: Ease-Faktor bleibt im Bereich ---------------------- */

  it('lehnt einen Ease-Faktor unterhalb von 1.3 ab', async () => {
    expect(
      await failing(() =>
        handle.db
          .insert(reviewQueue)
          .values({ conceptId: fixture.approvedConceptId, origin: 'error', easeFactor: 1.0 }),
      ),
    ).toMatch(/review_queue_ease_check/);
  });

  it('lehnt einen Ease-Faktor oberhalb von 3.0 ab', async () => {
    expect(
      await failing(() =>
        handle.db
          .insert(reviewQueue)
          .values({ conceptId: fixture.approvedConceptId, origin: 'error', easeFactor: 4.2 }),
      ),
    ).toMatch(/review_queue_ease_check/);
  });

  it('lehnt einen unbekannten Ursprung eines Queue-Eintrags ab', async () => {
    expect(
      await failing(() =>
        handle.db
          .insert(reviewQueue)
          .values({ conceptId: fixture.approvedConceptId, origin: 'langeweile' }),
      ),
    ).toMatch(/review_queue_origin_check/);
  });

  /* --- Invariante 6: Skill-Ratings nur fuer bekannte Themenbereiche ----- */

  it('lehnt ein Skill-Rating auf einen unbekannten Themenbereich ab', async () => {
    expect(
      await failing(() =>
        handle.db.insert(skillRating).values({ topicArea: 'erfundener-bereich', rating: 0.5 }),
      ),
    ).toMatch(/skill_rating_topic_area_check/);
  });

  it('nimmt ein Skill-Rating auf jeden Themenbereich aus T3.2 an', async () => {
    await handle.db.execute(sql`delete from skill_rating`);
    await handle.db
      .insert(skillRating)
      .values(CONCEPT_TOPIC_AREA_IDS.map((topicArea) => ({ topicArea })));

    const rows = await handle.db.execute<{ topic_area: string }>(
      sql`select topic_area from skill_rating order by topic_area`,
    );
    expect(rows.rows.map((row) => row.topic_area)).toEqual([...CONCEPT_TOPIC_AREA_IDS].sort());
  });

  it('haengt den Rating-Verlauf als Snapshots an die Achse', async () => {
    const captured = new Date('2026-08-28T10:00:00.000Z');
    await handle.db
      .insert(skillRatingSnapshot)
      .values({ topicArea: 'flop-spiel', rating: 0.42, capturedAt: captured });

    const rows = await handle.db.execute<{ rating: number }>(
      sql`select rating from skill_rating_snapshot where topic_area = 'flop-spiel'`,
    );
    expect(rows.rows).toHaveLength(1);

    // Derselbe Zeitpunkt zweimal waere ein doppelter Messpunkt.
    expect(
      await failing(() =>
        handle.db
          .insert(skillRatingSnapshot)
          .values({ topicArea: 'flop-spiel', rating: 0.43, capturedAt: captured }),
      ),
    ).toMatch(/skill_rating_snapshot_key/);
  });

  /* --- Fremdschluessel und draft-Konzepte ------------------------------- */

  it('lehnt einen Mastery-Eintrag auf ein nicht existierendes Konzept ab', async () => {
    expect(
      await failing(() =>
        handle.db
          .insert(conceptMastery)
          .values({ conceptId: '00000000-0000-4000-8000-000000000000' }),
      ),
    ).toMatch(/concept_mastery_concept_id_concept_id_fk/);
  });

  it('lehnt ein Ereignis auf ein nicht existierendes Konzept ab', async () => {
    expect(
      await failing(() =>
        handle.db.insert(learningEvent).values(anEvent('00000000-0000-4000-8000-000000000000')),
      ),
    ).toMatch(/learning_event_concept_id_concept_id_fk/);
  });

  it('fuehrt Mastery und Queue auch auf einem draft-Konzept (Scope-Delta 3)', async () => {
    const [mastery] = await handle.db
      .insert(conceptMastery)
      .values({ conceptId: fixture.draftConceptId, score: 0.4, confidence: 0.3 })
      .returning({ conceptId: conceptMastery.conceptId });
    const [queue] = await handle.db
      .insert(reviewQueue)
      .values({ conceptId: fixture.draftConceptId, origin: 'knowledge_gap' })
      .returning({ conceptId: reviewQueue.conceptId });

    expect(mastery?.conceptId).toBe(fixture.draftConceptId);
    expect(queue?.conceptId).toBe(fixture.draftConceptId);

    // Gegenprobe: Das Konzept steht wirklich auf `draft`.
    const state = await handle.db.execute<{ state: string }>(
      sql`select state from concept where id = ${fixture.draftConceptId}`,
    );
    expect(state.rows[0]?.state).toBe('draft');

    await handle.db.execute(sql`delete from review_queue`);
    await handle.db.execute(sql`delete from concept_mastery`);
  });

  it('bindet einen Fehlerlog-Eintrag an sein ausloesendes Ereignis', async () => {
    const [event] = await handle.db
      .insert(learningEvent)
      .values(anEvent(fixture.draftConceptId, { source: 'drill', eventType: 'drill_completed' }))
      .returning({ id: learningEvent.id });
    const eventId = (event as { id: string }).id;

    const [entry] = await handle.db
      .insert(errorLog)
      .values({
        eventId,
        conceptId: fixture.draftConceptId,
        contextKind: 'drill',
        contextRef: 'drill-fixture-1',
        description: 'Fixture-Fehler.',
        severity: 'medium',
      })
      .returning({ id: errorLog.id, patternTag: errorLog.patternTag });

    // Der Muster-Tag bleibt leer - er wird erst in T4.6 gesetzt.
    expect(entry?.patternTag).toBeNull();

    expect(
      await failing(() =>
        handle.db.insert(errorLog).values({
          eventId: '00000000-0000-4000-8000-000000000000',
          conceptId: fixture.draftConceptId,
          contextKind: 'drill',
          description: 'Fixture-Fehler ohne Ereignis.',
          severity: 'low',
        }),
      ),
    ).toMatch(/error_log_event_id_learning_event_id_fk/);
  });
});
