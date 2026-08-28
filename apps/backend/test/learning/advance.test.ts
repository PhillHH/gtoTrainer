import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEARNING_THRESHOLD_RANGES } from '@gto/shared';
import type { RecordLearningEventInput } from '@gto/shared';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import {
  LearningEventValidationError,
  evaluateConceptAdvance,
  objectiveAnchorsPossible,
  readLearningThresholds,
  recordLearningEvent,
  updateLearningThresholds,
} from '../../src/learning/service.js';
import { seedLearningState } from '../../src/learning/seed.js';
import { TEST_DATABASE_URL } from '../db/setup.js';
import { attachApprovedChart, clearLearning, seedConcepts } from './helpers.js';
import type { LearningFixture } from './helpers.js';

/**
 * Die Weiterschalt-Entscheidung gegen echte Daten (AP4.T4.3).
 *
 * Die Formeln sind in `mastery.test.ts` ohne Datenbank durchgerechnet. Hier
 * geht es um das, was nur die Datenbank beantworten kann: Sind fuer dieses
 * Konzept objektive Anker ueberhaupt moeglich, und greifen die Schwellen aus
 * `learner_state`? **Kein KI-Aufruf.**
 */
describe('evaluateConceptAdvance (AP4.T4.3)', () => {
  let handle: DbHandle;
  let fixture: LearningFixture;

  const AT = '2026-08-20T10:00:00.000Z';

  function anInput(overrides: Partial<RecordLearningEventInput> = {}): RecordLearningEventInput {
    return {
      id: randomUUID(),
      eventType: 'question_answered',
      source: 'theory_session',
      signalClass: 'objective',
      conceptId: fixture.approvedConceptId,
      occurredAt: AT,
      payload: { correct: true },
      ...overrides,
    } as RecordLearningEventInput;
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL, { max: 4 });
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

  /* --- Ermittlung der Anker-Moeglichkeit -------------------------------- */

  it('erkennt an einem freigegebenen Chart, dass objektive Anker moeglich sind', async () => {
    expect(await objectiveAnchorsPossible(handle.db, fixture.approvedConceptId)).toBe(false);

    await attachApprovedChart(handle.db, fixture.approvedConceptId);

    expect(await objectiveAnchorsPossible(handle.db, fixture.approvedConceptId)).toBe(true);
    // Das andere Konzept hat weiterhin keines.
    expect(await objectiveAnchorsPossible(handle.db, fixture.draftConceptId)).toBe(false);
  });

  it('zaehlt ein nicht freigegebenes Chart nicht als Ankermoeglichkeit', async () => {
    await attachApprovedChart(handle.db, fixture.approvedConceptId);
    // Dasselbe Chart, nur nicht mehr freigegeben: Seine Zahlen sind ungeprueft
    // und taugen damit nicht als objektiver Anker.
    await handle.db.execute(sql`update range_chart set state = 'validated'`);

    expect(await objectiveAnchorsPossible(handle.db, fixture.approvedConceptId)).toBe(false);
  });

  /* --- Entscheidung gegen echten Lernstand ------------------------------ */

  it('blockiert bei hohem Score aus KI-Bewertungen, weil die objektiven Anker fehlen', async () => {
    await attachApprovedChart(handle.db, fixture.approvedConceptId);

    // Acht freundliche KI-Bewertungen: Score 0,8 - und trotzdem kein Weiterkommen.
    for (let i = 0; i < 8; i += 1) {
      await recordLearningEvent(
        handle.db,
        anInput({
          eventType: 'concept_explained',
          signalClass: 'ai_judged',
          occurredAt: new Date(Date.parse(AT) + i * 1000).toISOString(),
          payload: { quality: 1 },
        }),
      );
    }

    const decision = await evaluateConceptAdvance(
      handle.db,
      fixture.approvedConceptId,
      new Date(AT),
    );

    expect(decision.score).toBeCloseTo(0.8, 3);
    expect(decision.score).toBeGreaterThan(decision.threshold);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('insufficient_objective_anchors');
    expect(decision.objectiveAnchors).toBe(0);
    expect(decision.requiredObjectiveAnchors).toBe(2);
  });

  it('schaltet weiter, wenn objektive Treffer Score und Anker tragen', async () => {
    await attachApprovedChart(handle.db, fixture.approvedConceptId);

    for (let i = 0; i < 4; i += 1) {
      await recordLearningEvent(
        handle.db,
        anInput({ occurredAt: new Date(Date.parse(AT) + i * 1000).toISOString() }),
      );
    }

    const decision = await evaluateConceptAdvance(
      handle.db,
      fixture.approvedConceptId,
      new Date(AT),
    );

    expect(decision).toMatchObject({
      allowed: true,
      reason: 'mastered',
      objectiveAnchors: 4,
      objectiveAnchorsPossible: true,
      blockers: [],
    });
    expect(decision.score).toBeCloseTo(0.8, 3);
  });

  it('schaltet ohne moegliche Anker weiter, kennzeichnet es aber (Scope-Delta 2)', async () => {
    // Kein Chart an diesem Konzept - der Regelfall im aktuellen Bestand
    // (16 von 168 Konzepten haben ein freigegebenes Chart).
    for (let i = 0; i < 6; i += 1) {
      await recordLearningEvent(
        handle.db,
        anInput({
          eventType: 'concept_explained',
          signalClass: 'ai_judged',
          occurredAt: new Date(Date.parse(AT) + i * 1000).toISOString(),
          payload: { quality: 1 },
        }),
      );
    }
    for (let i = 0; i < 2; i += 1) {
      await recordLearningEvent(
        handle.db,
        anInput({
          eventType: 'review_performed',
          source: 'journal',
          signalClass: 'self_reported',
          occurredAt: new Date(Date.parse(AT) + (10 + i) * 1000).toISOString(),
          payload: { correct: true },
        }),
      );
    }

    const decision = await evaluateConceptAdvance(
      handle.db,
      fixture.approvedConceptId,
      new Date(AT),
    );

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('mastered_without_objective_anchors');
    expect(decision.objectiveAnchorsPossible).toBe(false);
    expect(decision.objectiveAnchors).toBe(0);
    expect(decision.substituteAnchors).toBe(2);
    // Ohne objektive Signale bleibt die Konfidenz niedrig - genau die
    // sichtbare Folge, die Scope-Delta 2 verlangt.
    expect(decision.confidence).toBeLessThan(0.3);
  });

  it('meldet fuer ein Konzept ohne jedes Ereignis "no_evidence"', async () => {
    const decision = await evaluateConceptAdvance(handle.db, fixture.draftConceptId, new Date(AT));

    expect(decision).toMatchObject({
      allowed: false,
      reason: 'no_evidence',
      score: 0,
      confidence: 0,
      daysSinceLastCheck: null,
    });
  });

  it('funktioniert auf einem draft-Konzept genauso (Scope-Delta 3)', async () => {
    for (let i = 0; i < 4; i += 1) {
      await recordLearningEvent(
        handle.db,
        anInput({
          conceptId: fixture.draftConceptId,
          occurredAt: new Date(Date.parse(AT) + i * 1000).toISOString(),
        }),
      );
    }

    const decision = await evaluateConceptAdvance(handle.db, fixture.draftConceptId, new Date(AT));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('mastered_without_objective_anchors');
  });

  /* --- Schwellen aus learner_state -------------------------------------- */

  it('nimmt die Schwellen aus learner_state und reagiert auf eine Aenderung', async () => {
    await attachApprovedChart(handle.db, fixture.approvedConceptId);
    for (let i = 0; i < 3; i += 1) {
      await recordLearningEvent(
        handle.db,
        anInput({ occurredAt: new Date(Date.parse(AT) + i * 1000).toISOString() }),
      );
    }

    // Score 0,75 - genau auf dem Default.
    const mitDefault = await evaluateConceptAdvance(
      handle.db,
      fixture.approvedConceptId,
      new Date(AT),
    );
    expect(mitDefault.threshold).toBe(0.75);
    expect(mitDefault.allowed).toBe(true);

    await updateLearningThresholds(handle.db, { masteryThreshold: 0.9 });
    const strenger = await evaluateConceptAdvance(
      handle.db,
      fixture.approvedConceptId,
      new Date(AT),
    );
    expect(strenger.threshold).toBe(0.9);
    expect(strenger.allowed).toBe(false);
    expect(strenger.blockers).toEqual(['score_below_threshold']);

    await updateLearningThresholds(handle.db, { minObjectiveAnchors: 5, masteryThreshold: 0.75 });
    const mehrAnker = await evaluateConceptAdvance(
      handle.db,
      fixture.approvedConceptId,
      new Date(AT),
    );
    expect(mehrAnker.requiredObjectiveAnchors).toBe(5);
    expect(mehrAnker.reason).toBe('insufficient_objective_anchors');
  });

  it('liefert nach dem Seed die Defaults aus dem Vertrag', async () => {
    expect(await readLearningThresholds(handle.db)).toEqual({
      masteryThreshold: LEARNING_THRESHOLD_RANGES.masteryThreshold.default,
      minObjectiveAnchors: LEARNING_THRESHOLD_RANGES.minObjectiveAnchors.default,
    });
  });

  it('lehnt Schwellen ausserhalb der erlaubten Bereiche ab', async () => {
    await expect(
      updateLearningThresholds(handle.db, { masteryThreshold: 0.2 }),
    ).rejects.toBeInstanceOf(LearningEventValidationError);
    await expect(updateLearningThresholds(handle.db, { minObjectiveAnchors: 99 })).rejects.toThrow(
      /ganze Zahl zwischen 0 und 10/,
    );

    // Nichts davon ist angekommen - abgelehnt heisst nicht geschrieben.
    expect(await readLearningThresholds(handle.db)).toEqual({
      masteryThreshold: 0.75,
      minObjectiveAnchors: 2,
    });
  });
});
