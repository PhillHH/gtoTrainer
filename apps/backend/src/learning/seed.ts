import { sql } from 'drizzle-orm';
import { CONCEPT_TOPIC_AREA_IDS, LEARNER_STATE_DEFAULTS, SKILL_RATING_START } from '@gto/shared';
import type { Database } from '../db/client.js';
import { learnerState, skillRating } from '../db/schema.js';

/**
 * Ersteinrichtung des Lernstands (AP4.T4.1).
 *
 * Zwei Dinge muessen vor dem ersten Ereignis stehen: der globale
 * `learner_state` und je Themenbereich eine Rating-Achse. Alles andere -
 * Mastery, Queue, Fehlerlog - entsteht erst aus Ereignissen und wird hier
 * bewusst **nicht** vorbelegt.
 *
 * Idempotent: Ein zweiter Lauf legt nichts an und setzt nichts zurueck. Ein
 * Seed, der vorhandene Werte ueberschreibt, wuerde beim naechsten Deploy den
 * Lernfortschritt des Nutzers vernichten.
 */

export interface LearningSeedResult {
  /** Wurde der `learner_state` in diesem Lauf angelegt? */
  readonly learnerStateCreated: boolean;
  /** Wie viele Rating-Achsen in diesem Lauf neu entstanden sind. */
  readonly skillRatingsCreated: number;
  /** Wie viele Achsen es danach insgesamt gibt (immer die volle Liste aus T3.2). */
  readonly skillRatingsTotal: number;
}

/**
 * Legt `learner_state` und die Rating-Achsen an, falls sie fehlen.
 *
 * Die Themenbereiche stammen ausschliesslich aus `CONCEPT_TOPIC_AREA_IDS`
 * (T3.2). Hier wird keine zweite Liste gefuehrt - der CHECK auf
 * `skill_rating.topic_area` wuerde einen erfundenen Bereich ohnehin ablehnen.
 */
export async function seedLearningState(db: Database): Promise<LearningSeedResult> {
  return db.transaction(async (tx) => {
    const state = await tx
      .insert(learnerState)
      .values({
        level: LEARNER_STATE_DEFAULTS.level,
        currentChapter: LEARNER_STATE_DEFAULTS.currentChapter,
        masteryThreshold: LEARNER_STATE_DEFAULTS.masteryThreshold,
        minObjectiveAnchors: LEARNER_STATE_DEFAULTS.minObjectiveAnchors,
      })
      // Der Unique-Index auf `singleton` traegt die Einzigartigkeit; beim
      // zweiten Lauf greift genau er.
      .onConflictDoNothing({ target: learnerState.singleton })
      .returning({ id: learnerState.id });

    const created = await tx
      .insert(skillRating)
      .values(
        CONCEPT_TOPIC_AREA_IDS.map((topicArea) => ({
          topicArea,
          rating: SKILL_RATING_START,
          eventCount: 0,
        })),
      )
      .onConflictDoNothing({ target: skillRating.topicArea })
      .returning({ topicArea: skillRating.topicArea });

    const total = await tx.execute<{ n: string }>(sql`select count(*) as n from ${skillRating}`);

    return {
      learnerStateCreated: state.length > 0,
      skillRatingsCreated: created.length,
      skillRatingsTotal: Number(total.rows[0]?.n ?? 0),
    };
  });
}

/** Zeilenzahlen der Lernstand-Tabellen - Nachweis der Idempotenz in Tests und RUNBOOK. */
export interface LearningRowCounts {
  readonly learningEvent: number;
  readonly conceptMastery: number;
  readonly reviewQueue: number;
  readonly errorLog: number;
  readonly skillRating: number;
  readonly skillRatingSnapshot: number;
  readonly learnerState: number;
}

export async function countLearningRows(db: Database): Promise<LearningRowCounts> {
  const result = await db.execute<Record<string, string>>(
    sql`select (select count(*) from learning_event)        as learning_event,
               (select count(*) from concept_mastery)       as concept_mastery,
               (select count(*) from review_queue)          as review_queue,
               (select count(*) from error_log)             as error_log,
               (select count(*) from skill_rating)          as skill_rating,
               (select count(*) from skill_rating_snapshot) as skill_rating_snapshot,
               (select count(*) from learner_state)         as learner_state`,
  );
  const row = result.rows[0] ?? {};
  const n = (key: string): number => Number(row[key] ?? 0);
  return {
    learningEvent: n('learning_event'),
    conceptMastery: n('concept_mastery'),
    reviewQueue: n('review_queue'),
    errorLog: n('error_log'),
    skillRating: n('skill_rating'),
    skillRatingSnapshot: n('skill_rating_snapshot'),
    learnerState: n('learner_state'),
  };
}
