import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CONCEPT_TOPIC_AREA_IDS, LEARNER_STATE_DEFAULTS, SKILL_RATING_START } from '@gto/shared';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { countLearningRows, seedLearningState } from '../../src/learning/seed.js';
import {
  assertLearningResetAllowed,
  LearningResetBlockedError,
  resetLearningState,
} from '../../src/learning/reset.js';
import { TEST_DATABASE_URL } from '../db/setup.js';
import { anEvent, clearLearning, seedConcepts } from './helpers.js';
import type { LearningFixture } from './helpers.js';
import { learningEvent } from '../../src/db/schema.js';

describe('Lernstand-Seed und Neuanfang (AP4.T4.1)', () => {
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

  it('legt learner_state und je Themenbereich ein Rating an und ist idempotent', async () => {
    const first = await seedLearningState(handle.db);
    const afterFirst = await countLearningRows(handle.db);

    const second = await seedLearningState(handle.db);
    const afterSecond = await countLearningRows(handle.db);

    expect(first.learnerStateCreated).toBe(true);
    expect(first.skillRatingsCreated).toBe(CONCEPT_TOPIC_AREA_IDS.length);
    expect(second.learnerStateCreated).toBe(false);
    expect(second.skillRatingsCreated).toBe(0);

    // Der zweite Lauf darf weder Duplikate erzeugen noch fehlschlagen.
    expect(afterSecond).toEqual(afterFirst);
    expect(afterFirst.learnerState).toBe(1);
    expect(afterFirst.skillRating).toBe(CONCEPT_TOPIC_AREA_IDS.length);
  });

  it('setzt die Startwerte aus dem Vertrag', async () => {
    const state = await handle.db.execute<{
      level: string;
      current_chapter: number;
      mastery_threshold: number;
      min_objective_anchors: number;
    }>(
      sql`select level, current_chapter, mastery_threshold, min_objective_anchors
          from learner_state`,
    );
    expect(state.rows[0]).toMatchObject({
      level: LEARNER_STATE_DEFAULTS.level,
      current_chapter: LEARNER_STATE_DEFAULTS.currentChapter,
      mastery_threshold: LEARNER_STATE_DEFAULTS.masteryThreshold,
      min_objective_anchors: LEARNER_STATE_DEFAULTS.minObjectiveAnchors,
    });

    const ratings = await handle.db.execute<{ topic_area: string; rating: number }>(
      sql`select topic_area, rating from skill_rating order by topic_area`,
    );
    expect(ratings.rows.map((row) => row.topic_area)).toEqual([...CONCEPT_TOPIC_AREA_IDS].sort());
    expect(ratings.rows.every((row) => row.rating === SKILL_RATING_START)).toBe(true);
  });

  it('ueberschreibt vom Nutzer geaenderte Werte nicht', async () => {
    await handle.db.execute(sql`update learner_state set mastery_threshold = 0.65`);
    await seedLearningState(handle.db);

    const state = await handle.db.execute<{ mastery_threshold: number }>(
      sql`select mastery_threshold from learner_state`,
    );
    expect(state.rows[0]?.mastery_threshold).toBe(0.65);
  });

  it('verwirft beim Neuanfang den Lernfortschritt und legt die Ersteinrichtung neu an', async () => {
    await handle.db.insert(learningEvent).values(anEvent(fixture.approvedConceptId));
    expect((await countLearningRows(handle.db)).learningEvent).toBe(1);

    await resetLearningState(handle.db);

    const after = await countLearningRows(handle.db);
    expect(after.learningEvent).toBe(0);
    expect(after.learnerState).toBe(1);
    expect(after.skillRating).toBe(CONCEPT_TOPIC_AREA_IDS.length);

    // Der Konzept-Graph bleibt unangetastet.
    const concepts = await handle.db.execute<{ n: string }>(sql`select count(*) as n from concept`);
    expect(Number(concepts.rows[0]?.n)).toBe(2);
  });

  it('blockiert den Neuanfang ohne ausdrueckliche Bestaetigung', () => {
    expect(() => assertLearningResetAllowed(undefined)).toThrow(LearningResetBlockedError);
    expect(() => assertLearningResetAllowed('vielleicht')).toThrow(/LEARNING_RESET_CONFIRM/);
    expect(() => assertLearningResetAllowed('yes')).not.toThrow();
  });
});
