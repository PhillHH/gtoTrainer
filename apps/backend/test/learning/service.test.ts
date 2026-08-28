import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RecordLearningEventInput } from '@gto/shared';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import {
  LearningEventValidationError,
  recordLearningEvent,
  replayLearningState,
} from '../../src/learning/service.js';
import { seedLearningState } from '../../src/learning/seed.js';
import { TEST_DATABASE_URL } from '../db/setup.js';
import { clearLearning, derivedState, failing, seedConcepts } from './helpers.js';
import type { LearningFixture } from './helpers.js';

/**
 * `recordLearningEvent` und der Replay (AP4.T4.2).
 *
 * Echte Datenbank, nichts gemockt: Idempotenz, Rennsicherheit und
 * Transaktionalitaet haengen an Postgres und liessen sich gegen eine Attrappe
 * gar nicht pruefen. **Kein KI-Aufruf.**
 */
describe('recordLearningEvent (AP4.T4.2)', () => {
  let handle: DbHandle;
  let fixture: LearningFixture;

  /** Ein Ereignis mit Vorgaben, die jeder Test gezielt ueberschreiben kann. */
  function anInput(overrides: Partial<RecordLearningEventInput> = {}): RecordLearningEventInput {
    return {
      id: randomUUID(),
      eventType: 'question_answered',
      source: 'theory_session',
      signalClass: 'objective',
      conceptId: fixture.approvedConceptId,
      occurredAt: '2026-08-20T10:00:00.000Z',
      payload: { correct: true },
      ...overrides,
    } as RecordLearningEventInput;
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL, { max: 6 });
  });

  afterAll(async () => {
    await clearLearning(handle.db);
    await handle.close();
  });

  beforeEach(async () => {
    await clearLearning(handle.db);
    fixture = await seedConcepts(handle.db);
    await seedLearningState(handle.db);
  });

  /* --- Ableitungen ------------------------------------------------------ */

  it('stoesst mit einem Ereignis alle vier Ableitungen an', async () => {
    const before = await derivedState(handle.db);
    expect(before['conceptMastery']).toHaveLength(0);
    expect(before['reviewQueue']).toHaveLength(0);
    expect(before['errorLog']).toHaveLength(0);
    expect(
      (before['skillRating'] as { rating: number; event_count: number }[]).every(
        (row) => row.rating === 0 && row.event_count === 0,
      ),
    ).toBe(true);

    // Ein falsch beantwortetes Drill-Ergebnis - damit alle vier Ableitungen
    // etwas zu tun bekommen (ein richtiges erzeugte weder Queue noch Fehler).
    const result = await recordLearningEvent(
      handle.db,
      anInput({
        eventType: 'drill_completed',
        source: 'drill',
        signalClass: 'objective',
        payload: { correct: 1, total: 4, drillId: 'drill-7' },
      }),
    );
    expect(result.status).toBe('recorded');

    const after = await derivedState(handle.db);

    // 1. Mastery: Score 0,25 (1 von 4), Konfidenz 1 (rein objektiv).
    expect(after['conceptMastery']).toHaveLength(1);
    expect(after['conceptMastery']?.[0]).toMatchObject({
      concept_id: fixture.approvedConceptId,
      score: 0.25,
      confidence: 1,
      objective_signals: 1,
      ai_judged_signals: 0,
      self_reported_signals: 0,
    });

    // 2. Queue: der Drill lief schief, das Konzept kommt wieder.
    expect(after['reviewQueue']).toHaveLength(1);
    expect(after['reviewQueue']?.[0]).toMatchObject({
      concept_id: fixture.approvedConceptId,
      origin: 'error',
      lapses: 1,
      repetitions: 0,
    });

    // 3. Fehlerprotokoll: automatisch, kein separater Schreibweg.
    expect(after['errorLog']).toHaveLength(1);
    expect(after['errorLog']?.[0]).toMatchObject({
      concept_id: fixture.approvedConceptId,
      context_kind: 'drill',
      context_ref: 'drill-7',
      severity: 'medium',
      pattern_tag: null,
    });

    // 4. Skill-Rating der Achse des Konzepts.
    const rating = (
      after['skillRating'] as { topic_area: string; rating: number; event_count: number }[]
    ).find((row) => row.topic_area === 'grundlagen-mathematik');
    expect(rating).toMatchObject({ rating: 0.25, event_count: 1 });
  });

  it('leitet die Faelligkeit aus dem Ereigniszeitpunkt ab, nicht aus der Systemzeit', async () => {
    await recordLearningEvent(
      handle.db,
      anInput({ occurredAt: '2026-01-15T08:00:00.000Z', payload: { correct: false } }),
    );

    const rows = await handle.db.execute<{ due_at: string; last_reviewed_at: string }>(
      sql`select due_at, last_reviewed_at from review_queue`,
    );
    // Genau ein Tag nach dem Ereignis - reproduzierbar bei jedem Replay.
    expect(new Date(rows.rows[0]?.due_at ?? 0).toISOString()).toBe('2026-01-16T08:00:00.000Z');
    expect(new Date(rows.rows[0]?.last_reviewed_at ?? 0).toISOString()).toBe(
      '2026-01-15T08:00:00.000Z',
    );
  });

  /* --- Idempotenz ------------------------------------------------------- */

  it('zaehlt dasselbe Ereignis nicht zweimal und meldet beide Male Erfolg', async () => {
    const input = anInput({ payload: { correct: false } });

    const first = await recordLearningEvent(handle.db, input);
    const afterFirst = await derivedState(handle.db);

    const second = await recordLearningEvent(handle.db, input);
    const afterSecond = await derivedState(handle.db);

    expect(first.status).toBe('recorded');
    // Kein Fehler beim Aufrufer - ein Wiederholungsversuch nach
    // Netzwerkabbruch darf nicht in den Fehlerpfad laufen.
    expect(second.status).toBe('duplicate');
    expect(second.eventId).toBe(input.id);

    expect(afterSecond).toEqual(afterFirst);
    const events = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event`,
    );
    expect(Number(events.rows[0]?.n)).toBe(1);
  });

  it('laesst bei zwei gleichzeitigen Aufrufen mit derselben ID nur einen durch', async () => {
    const input = anInput({ payload: { correct: false } });

    const results = await Promise.all([
      recordLearningEvent(handle.db, input),
      recordLearningEvent(handle.db, input),
      recordLearningEvent(handle.db, input),
    ]);

    // Genau einer schreibt; die anderen sehen den Primaerschluessel-Konflikt.
    expect(results.filter((r) => r.status === 'recorded')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(2);

    const events = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event`,
    );
    expect(Number(events.rows[0]?.n)).toBe(1);

    const state = await derivedState(handle.db);
    expect(state['conceptMastery']).toHaveLength(1);
    expect(state['errorLog']).toHaveLength(1);
  });

  /* --- Transaktionalitaet ----------------------------------------------- */

  it('persistiert das Ereignis nicht, wenn eine Ableitung fehlschlaegt', async () => {
    // Kuenstlich herbeigefuehrter Fehler: Ein Trigger laesst jeden Schreibzugriff
    // auf `concept_mastery` scheitern. Realistischer als ein gemocktes Modul -
    // geprueft wird der echte Transaktionsrahmen.
    await handle.db.execute(sql`
      create or replace function tmp_fail_mastery() returns trigger
      language plpgsql as $$ begin raise exception 'Ableitung kaputt (Test)'; end; $$`);
    await handle.db.execute(sql`
      create trigger tmp_fail_mastery before insert or update on concept_mastery
      for each row execute function tmp_fail_mastery()`);

    const input = anInput({ payload: { correct: false } });
    try {
      expect(await failing(() => recordLearningEvent(handle.db, input))).toMatch(
        /Ableitung kaputt/,
      );
    } finally {
      await handle.db.execute(sql`drop trigger tmp_fail_mastery on concept_mastery`);
      await handle.db.execute(sql`drop function tmp_fail_mastery()`);
    }

    // Entweder alles oder nichts: Das Ereignis darf nicht dastehen.
    const events = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event where id = ${input.id}`,
    );
    expect(Number(events.rows[0]?.n)).toBe(0);

    const state = await derivedState(handle.db);
    expect(state['conceptMastery']).toHaveLength(0);
    expect(state['errorLog']).toHaveLength(0);
  });

  /* --- Validierung ------------------------------------------------------ */

  it('weist ungueltige Nutzdaten ab, ohne etwas zu schreiben', async () => {
    const input = anInput({
      eventType: 'drill_completed',
      source: 'drill',
      // "korrekt" statt "correct": ein Tippfehler, der sonst still als
      // "kein Ergebnis" durchrutschte.
      payload: { korrekt: 3, total: 5 },
    } as Partial<RecordLearningEventInput>);

    const error = await captureValidationError(() => recordLearningEvent(handle.db, input));
    expect(error.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'payload.korrekt',
          message: expect.stringContaining('Unbekanntes Feld "korrekt"'),
        }),
        expect.objectContaining({
          field: 'payload.correct',
          message: '"correct" muss eine ganze Zahl ab 0 sein.',
        }),
      ]),
    );

    const events = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event`,
    );
    expect(Number(events.rows[0]?.n)).toBe(0);
  });

  it('weist einen unbekannten Ereignistyp ab', async () => {
    const error = await captureValidationError(() =>
      recordLearningEvent(handle.db, anInput({ eventType: 'geraten' } as never)),
    );
    expect(error.fields).toContainEqual({
      field: 'eventType',
      message: 'Unbekannter Ereignistyp "geraten".',
    });
  });

  it('weist ein unbekanntes Konzept ab', async () => {
    const unknownId = '00000000-0000-4000-8000-000000000000';
    const error = await captureValidationError(() =>
      recordLearningEvent(handle.db, anInput({ conceptId: unknownId })),
    );
    expect(error.fields).toContainEqual({
      field: 'conceptId',
      message: `Konzept "${unknownId}" existiert nicht.`,
    });

    const events = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event`,
    );
    expect(Number(events.rows[0]?.n)).toBe(0);
  });

  it('weist eine fehlende Signalklasse ab', async () => {
    const error = await captureValidationError(() =>
      recordLearningEvent(handle.db, anInput({ signalClass: undefined } as never)),
    );
    expect(error.fields[0]?.field).toBe('signalClass');
    expect(error.fields[0]?.message).toContain('Replay');
  });

  it('weist eine Korrektur ohne Bezug und einen Bezug ohne Korrektur ab', async () => {
    const ohneBezug = await captureValidationError(() =>
      recordLearningEvent(
        handle.db,
        anInput({
          eventType: 'manual_correction',
          source: 'manual',
          payload: { reason: 'Chart war falsch digitalisiert.' },
        }),
      ),
    );
    expect(ohneBezug.fields).toContainEqual({
      field: 'correctsEventId',
      message: 'Eine Korrektur muss auf das zu korrigierende Ereignis zeigen.',
    });

    const original = anInput({ payload: { correct: true } });
    await recordLearningEvent(handle.db, original);

    const falscherTyp = await captureValidationError(() =>
      recordLearningEvent(handle.db, anInput({ correctsEventId: original.id })),
    );
    expect(falscherTyp.fields).toContainEqual({
      field: 'correctsEventId',
      message: 'Nur ein Ereignis vom Typ "manual_correction" darf auf ein anderes zeigen.',
    });
  });

  /* --- Korrektur-Mechanik ----------------------------------------------- */

  it('hebt mit einer Korrektur die Wirkung auf, ohne das Ereignis zu veraendern', async () => {
    const original = anInput({
      eventType: 'drill_completed',
      source: 'drill',
      payload: { correct: 0, total: 4, drillId: 'drill-9' },
    });
    await recordLearningEvent(handle.db, original);

    const before = await derivedState(handle.db);
    expect(before['conceptMastery']?.[0]).toMatchObject({ score: 0 });
    expect(before['errorLog']).toHaveLength(1);
    expect(before['reviewQueue']).toHaveLength(1);

    await recordLearningEvent(
      handle.db,
      anInput({
        eventType: 'manual_correction',
        source: 'manual',
        signalClass: 'self_reported',
        occurredAt: '2026-08-21T10:00:00.000Z',
        correctsEventId: original.id,
        payload: { reason: 'Das Chart war falsch digitalisiert.' },
      }),
    );

    const after = await derivedState(handle.db);
    // Die Wirkung ist weg: kein Mastery-Stand, kein Fehler, keine Queue.
    expect(after['conceptMastery']).toHaveLength(0);
    expect(after['errorLog']).toHaveLength(0);
    expect(after['reviewQueue']).toHaveLength(0);

    // Das urspruengliche Ereignis steht unveraendert im Protokoll - die
    // Historie wird nicht gefaelscht, nur neu bewertet.
    const rows = await handle.db.execute<{
      id: string;
      event_type: string;
      payload: Record<string, unknown>;
    }>(sql`select id, event_type, payload from learning_event where id = ${original.id}`);
    expect(rows.rows[0]).toMatchObject({
      event_type: 'drill_completed',
      payload: { correct: 0, total: 4, drillId: 'drill-9' },
    });

    // Und es sind zwei Ereignisse, nicht eines.
    const count = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event`,
    );
    expect(Number(count.rows[0]?.n)).toBe(2);
  });

  it('ersetzt mit einer Korrektur das Ergebnis, wenn ein Ersatzwert angegeben ist', async () => {
    const original = anInput({ payload: { correct: false } });
    await recordLearningEvent(handle.db, original);

    await recordLearningEvent(
      handle.db,
      anInput({
        eventType: 'manual_correction',
        source: 'manual',
        signalClass: 'self_reported',
        occurredAt: '2026-08-21T10:00:00.000Z',
        correctsEventId: original.id,
        payload: { reason: 'Antwort war doch richtig.', replacementOutcome: 1 },
      }),
    );

    const state = await derivedState(handle.db);
    expect(state['conceptMastery']?.[0]).toMatchObject({ score: 1, objective_signals: 1 });
    // Kein Fehler mehr - und die Queue ist leer, weil nichts mehr misslang.
    expect(state['errorLog']).toHaveLength(0);
    expect(state['reviewQueue']).toHaveLength(0);
  });

  /* --- Replay (DoD-Kern) ------------------------------------------------ */

  it('erzeugt mit dem Replay denselben abgeleiteten Zustand wie der inkrementelle Weg', async () => {
    const korrigiert = anInput({
      eventType: 'drill_completed',
      source: 'drill',
      signalClass: 'objective',
      occurredAt: '2026-08-20T09:00:00.000Z',
      payload: { correct: 0, total: 5, drillId: 'drill-1' },
    });

    const eingespielt: RecordLearningEventInput[] = [
      // 1. objektiv richtig beantwortete Frage
      anInput({ occurredAt: '2026-08-20T08:00:00.000Z', payload: { correct: true } }),
      // 2. Drill, der spaeter korrigiert wird
      korrigiert,
      // 3. KI-bewertete Erklaerung
      anInput({
        eventType: 'concept_explained',
        source: 'theory_session',
        signalClass: 'ai_judged',
        occurredAt: '2026-08-20T10:00:00.000Z',
        payload: { quality: 0.7, rationale: 'Kern getroffen, Randfall fehlt.' },
      }),
      // 4. Hand-Analyse auf dem draft-Konzept (anderer Themenbereich)
      anInput({
        eventType: 'hand_analyzed',
        source: 'hand_analysis',
        signalClass: 'objective',
        conceptId: fixture.draftConceptId,
        occurredAt: '2026-08-20T11:00:00.000Z',
        payload: { correct: false, handRef: 'hh-42', mistake: 'Zu weite Verteidigung.' },
      }),
      // 5. selbst eingeschaetzte Wiederholung
      anInput({
        eventType: 'review_performed',
        source: 'journal',
        signalClass: 'self_reported',
        occurredAt: '2026-08-21T08:00:00.000Z',
        payload: { correct: true },
      }),
      // 6. Korrektur auf Ereignis 2 - mit Ersatzwert
      anInput({
        eventType: 'manual_correction',
        source: 'manual',
        signalClass: 'self_reported',
        occurredAt: '2026-08-21T09:00:00.000Z',
        correctsEventId: korrigiert.id,
        payload: { reason: 'Chart HR 17 war falsch gelesen.', replacementOutcome: 0.8 },
      }),
    ];

    for (const input of eingespielt) {
      const result = await recordLearningEvent(handle.db, input);
      expect(result.status).toBe('recorded');
    }

    const inkrementell = await derivedState(handle.db);
    // Gegenprobe, dass ueberhaupt etwas abgeleitet wurde.
    expect(inkrementell['conceptMastery']).toHaveLength(2);
    expect(inkrementell['errorLog']).toHaveLength(1);
    expect(inkrementell['reviewQueue']).toHaveLength(1);

    // Abgeleitetes komplett verwerfen ...
    await handle.db.execute(sql`delete from error_log`);
    await handle.db.execute(sql`delete from review_queue`);
    await handle.db.execute(sql`delete from concept_mastery`);
    await handle.db.execute(sql`update skill_rating set rating = 0, event_count = 0`);
    const geleert = await derivedState(handle.db);
    expect(geleert['conceptMastery']).toHaveLength(0);

    // ... und aus den Ereignissen neu berechnen.
    const replay = await replayLearningState(handle.db);
    expect(replay.events).toBe(6);
    expect(replay.concepts).toBe(2);
    expect(replay.topicAreas).toBe(2);

    const nachReplay = await derivedState(handle.db);
    expect(nachReplay).toEqual(inkrementell);

    // Die Ereignisse selbst hat der Replay nicht angefasst.
    const events = await handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event`,
    );
    expect(Number(events.rows[0]?.n)).toBe(6);
  });

  it('ist beim zweiten Replay unveraendert', async () => {
    await recordLearningEvent(handle.db, anInput({ payload: { correct: false } }));
    await replayLearningState(handle.db);
    const first = await derivedState(handle.db);
    await replayLearningState(handle.db);
    expect(await derivedState(handle.db)).toEqual(first);
  });
});

/** Faengt die Ablehnung ab und liefert sie typisiert - sonst schlaegt der Test fehl. */
async function captureValidationError(
  run: () => Promise<unknown>,
): Promise<LearningEventValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof LearningEventValidationError) return error;
    throw error;
  }
  throw new Error('Das Ereignis haette abgelehnt werden muessen.');
}
