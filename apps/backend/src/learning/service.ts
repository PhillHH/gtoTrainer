import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  CONCEPT_TOPIC_AREAS,
  LEARNING_THRESHOLD_RANGES,
  isGlobalLearningEventType,
  isLearningEventSource,
  isLearningEventType,
  isLearningSignalClass,
  validateLearningEventPayload,
} from '@gto/shared';
import type {
  AdvanceDecision,
  ConceptTopicArea,
  LearnerLevel,
  LevelCalibration,
  LevelSetPayload,
  LevelSignals,
  SkillRatingHistory,
  SkillRatingView,
  DueReviewsQuery,
  DueReviewsResponse,
  ReviewQueueOrigin,
  UpcomingReviewsQuery,
  UpcomingReviewsResponse,
  LearningEventType,
  LearningThresholdUpdate,
  LearningThresholds,
  RecordLearningEventInput,
  RecordLearningEventResponse,
} from '@gto/shared';
import type { Database, Transaction } from '../db/client.js';
import {
  concept,
  conceptChart,
  conceptMastery,
  conceptPrerequisite,
  errorLog,
  learnerState,
  learningEvent,
  rangeChart,
  reviewQueue,
  skillRating,
  skillRatingSnapshot,
} from '../db/schema.js';
import { evaluateAdvance } from './mastery.js';
import { overdueDays, prioritizeReviews } from './review.js';
import type { ReviewCandidate } from './review.js';
import {
  applyCorrections,
  foldConceptMastery,
  foldErrorLog,
  foldReviewQueue,
  foldSkillRating,
  foldSkillRatingSnapshots,
  inEventOrder,
} from './derive.js';
import { snapshotId, startOfUtcDay } from './rating.js';
import { MASTERED_CONFIDENCE, MASTERED_SCORE, calibrateLevel } from './level.js';
import type { StoredLearningEvent } from './derive.js';

/**
 * `recordLearningEvent` - **die einzige Schreibstelle des Lernstands**
 * (AP4.T4.2).
 *
 * Jede Quelle geht hier durch: Theorie-Session (AP5), Drill (AP7),
 * Hand-Analyse, Turnier, Journal (AP8), Materialtrigger (AP9). Der HTTP-
 * Endpunkt in `routes.ts` ist nur eine zweite Tuer zu **derselben** Funktion,
 * keine zweite Implementierung.
 *
 * Vier Schritte, in dieser Reihenfolge:
 *
 * 1. **Validierung** - Typ, Nutzdaten, Konzept, Korrekturbezug. Fehler werden
 *    feldweise abgelehnt; es wird nichts geschrieben.
 * 2. **Persistenz** - das Ereignis geht unveraenderlich nach `learning_event`.
 * 3. **Ableitung** - Mastery, Queue, Fehlerlog und Rating werden aus dem
 *    Ereignisstrom neu berechnet.
 * 4. **Transaktionalitaet** - 2 und 3 laufen in *einer* Transaktion. Ein halb
 *    verarbeitetes Ereignis wuerde den Zustand dauerhaft vom Strom
 *    entkoppeln; der Replay verglichte dann zwei verschiedene Dinge.
 *
 * Warum die Ableitung den ganzen Strom des Konzepts neu rechnet statt ein
 * Delta zu addieren: Nur so ist zugesichert, dass der inkrementelle Weg und
 * der Replay dasselbe Ergebnis liefern - der Kern der AP4-Definition-of-Done.
 * Siehe ADR-0040.
 */

/* -------------------------------------------------------------------------
 * Ablehnung
 * ---------------------------------------------------------------------- */

export interface EventFieldError {
  readonly field: string;
  readonly message: string;
}

/** Ein Ereignis wurde abgelehnt. Es wurde **nichts** geschrieben. */
export class LearningEventValidationError extends Error {
  readonly fields: readonly EventFieldError[];

  constructor(fields: readonly EventFieldError[]) {
    super(fields.map((entry) => `${entry.field}: ${entry.message}`).join('; '));
    this.name = 'LearningEventValidationError';
    this.fields = fields;
  }
}

/* -------------------------------------------------------------------------
 * Schritt 1 - Validierung
 * ---------------------------------------------------------------------- */

interface ValidatedEvent {
  readonly id: string;
  readonly eventType: LearningEventType;
  readonly source: string;
  readonly signalClass: string;
  /** `null` bei globalen Ereignissen wie `level_set`. */
  readonly conceptId: string | null;
  /** `null`, wenn das Ereignis kein Konzept betrifft. */
  readonly topicArea: ConceptTopicArea | null;
  readonly occurredAt: Date;
  readonly chartId: string | null;
  readonly correctsEventId: string | null;
  readonly payload: Record<string, unknown>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Prueft alles, was sich vor dem Schreiben pruefen laesst.
 *
 * Bewusst vollstaendig statt beim ersten Fehler abzubrechen: Der Aufrufer soll
 * alle Einwaende auf einmal sehen - dasselbe Muster wie die Konzept-Review aus
 * T3.2 und die Einstellungen aus T2.6.
 */
async function validate(
  db: Database | Transaction,
  input: RecordLearningEventInput,
): Promise<ValidatedEvent> {
  const fields: EventFieldError[] = [];

  if (typeof input?.id !== 'string' || !UUID_PATTERN.test(input.id)) {
    fields.push({
      field: 'id',
      message: 'Die Ereignis-ID muss eine UUID sein. Sie vergibt der Aufrufer (Idempotenz).',
    });
  }

  if (!isLearningEventType(input?.eventType)) {
    fields.push({
      field: 'eventType',
      message: `Unbekannter Ereignistyp "${String(input?.eventType)}".`,
    });
  }
  if (!isLearningEventSource(input?.source)) {
    fields.push({ field: 'source', message: `Unbekannte Quelle "${String(input?.source)}".` });
  }
  if (!isLearningSignalClass(input?.signalClass)) {
    fields.push({
      field: 'signalClass',
      message: `Unbekannte Signalklasse "${String(input?.signalClass)}". Sie ist Pflicht - ohne sie ist der Replay nicht rekonstruierbar.`,
    });
  }

  // Der Zeitstempel wird **hier** festgelegt, nicht in der Ableitung. Ab jetzt
  // ist er Teil des Ereignisses und damit reproduzierbar.
  const occurredAt = input?.occurredAt === undefined ? new Date() : new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    fields.push({ field: 'occurredAt', message: 'Kein gültiger ISO-Zeitstempel.' });
  }

  if (isLearningEventType(input?.eventType)) {
    fields.push(...validateLearningEventPayload(input.eventType, input.payload));
  }

  const correctsEventId = input?.correctsEventId ?? null;
  if (isLearningEventType(input?.eventType)) {
    if (input.eventType === 'manual_correction' && correctsEventId === null) {
      fields.push({
        field: 'correctsEventId',
        message: 'Eine Korrektur muss auf das zu korrigierende Ereignis zeigen.',
      });
    }
    if (input.eventType !== 'manual_correction' && correctsEventId !== null) {
      fields.push({
        field: 'correctsEventId',
        message: 'Nur ein Ereignis vom Typ "manual_correction" darf auf ein anderes zeigen.',
      });
    }
  }

  // Ein Ereignis ist entweder ein Lernereignis an einem Konzept oder ein
  // globales Ereignis am Lernenden (`level_set`). Dieselbe Bedingung erzwingt
  // der CHECK `learning_event_scope_check` in der Datenbank.
  const global =
    isLearningEventType(input?.eventType) && isGlobalLearningEventType(input.eventType);
  let topicArea: ConceptTopicArea | null = null;
  let conceptId: string | null = null;

  if (global) {
    if (input?.conceptId !== undefined && input.conceptId !== null) {
      fields.push({
        field: 'conceptId',
        message: `Ein Ereignis vom Typ "${input.eventType}" bezieht sich auf kein Konzept.`,
      });
    }
  } else if (typeof input?.conceptId === 'string' && UUID_PATTERN.test(input.conceptId)) {
    const [row] = await db
      .select({ topicArea: concept.topicArea })
      .from(concept)
      .where(eq(concept.id, input.conceptId));
    if (!row) {
      fields.push({ field: 'conceptId', message: `Konzept "${input.conceptId}" existiert nicht.` });
    } else {
      topicArea = row.topicArea as ConceptTopicArea;
      conceptId = input.conceptId;
    }
  } else {
    fields.push({ field: 'conceptId', message: 'Die Konzept-ID muss eine UUID sein.' });
  }

  // Eine Korrektur muss auf ein vorhandenes Ereignis **desselben Konzepts**
  // zeigen. Ohne diese Bedingung koennte eine Korrektur die Ableitung eines
  // anderen Konzepts veraendern, ohne dass dessen Strom neu gerechnet wird.
  if (correctsEventId !== null) {
    if (!UUID_PATTERN.test(correctsEventId)) {
      fields.push({ field: 'correctsEventId', message: 'Muss eine UUID sein.' });
    } else {
      const [target] = await db
        .select({ conceptId: learningEvent.conceptId, eventType: learningEvent.eventType })
        .from(learningEvent)
        .where(eq(learningEvent.id, correctsEventId));
      if (!target) {
        fields.push({
          field: 'correctsEventId',
          message: `Ereignis "${correctsEventId}" existiert nicht.`,
        });
      } else if (target.conceptId !== input.conceptId) {
        fields.push({
          field: 'correctsEventId',
          message: 'Eine Korrektur muss zum selben Konzept gehören wie das korrigierte Ereignis.',
        });
      } else if (target.eventType === 'manual_correction') {
        fields.push({
          field: 'correctsEventId',
          message: 'Eine Korrektur korrigiert ein Lernereignis, keine andere Korrektur.',
        });
      }
    }
  }

  if (fields.length > 0) throw new LearningEventValidationError(fields);

  return {
    id: input.id,
    eventType: input.eventType,
    source: input.source,
    signalClass: input.signalClass,
    conceptId,
    topicArea,
    occurredAt,
    chartId: input.chartId ?? null,
    correctsEventId,
    payload: input.payload as unknown as Record<string, unknown>,
  };
}

/* -------------------------------------------------------------------------
 * Schritte 2 bis 4 - schreiben und ableiten
 * ---------------------------------------------------------------------- */

/**
 * Zeichnet ein Ereignis auf und zieht die Ableitungen.
 *
 * **Idempotent:** Dieselbe Ereignis-ID ein zweites Mal aendert nichts und gilt
 * trotzdem als Erfolg (`status: 'duplicate'`). Ein Drill, der nach einem
 * Netzwerkabbruch erneut sendet, darf nicht doppelt zaehlen - und der Aufrufer
 * soll deswegen nicht in einen Fehlerpfad laufen.
 *
 * Die Absicherung ist **datenbankseitig**: `on conflict (id) do nothing`. Eine
 * Vorabpruefung im Code waere ein Wettlauf - zwei gleichzeitige Aufrufe
 * kaemen beide durch, weil beide vor dem jeweils anderen Schreibvorgang
 * nachsehen. Der Primaerschluessel entscheidet stattdessen, und der zweite
 * Aufruf wartet auf den ersten.
 */
export async function recordLearningEvent(
  db: Database,
  input: RecordLearningEventInput,
): Promise<RecordLearningEventResponse> {
  // Validierung bewusst VOR der Transaktion: Sie liest nur und soll bei einer
  // Ablehnung keine Transaktion offen gehalten haben.
  const event = await validate(db, input);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(learningEvent)
      .values({
        id: event.id,
        eventType: event.eventType,
        source: event.source,
        signalClass: event.signalClass,
        occurredAt: event.occurredAt,
        conceptId: event.conceptId,
        chartId: event.chartId,
        correctsEventId: event.correctsEventId,
        payload: event.payload,
      })
      .onConflictDoNothing({ target: learningEvent.id })
      .returning({ id: learningEvent.id });

    if (inserted.length === 0) {
      // Dieselbe ID gab es schon. Kein Fehler, keine zweite Wirkung.
      return { status: 'duplicate', eventId: event.id, conceptId: event.conceptId };
    }

    if (event.conceptId !== null && event.topicArea !== null) {
      await projectConcept(tx, event.conceptId);
      await projectTopicArea(tx, event.topicArea);
    }
    // Das Level haengt am Gesamtbild, nicht an einem Konzept - es wird nach
    // jedem Ereignis neu kalibriert. Bezugszeitpunkt ist der Zeitpunkt des
    // Ereignisses, nicht die Systemzeit (Determinismus-Regel).
    await projectLearnerLevel(tx, event.occurredAt);

    return { status: 'recorded', eventId: event.id, conceptId: event.conceptId };
  });
}

/** Laedt den Ereignisstrom eines Konzepts in der einzig gueltigen Reihenfolge. */
async function eventsOfConcept(
  tx: Transaction,
  conceptId: string,
): Promise<readonly StoredLearningEvent[]> {
  const rows = await tx
    .select()
    .from(learningEvent)
    .where(eq(learningEvent.conceptId, conceptId))
    .orderBy(asc(learningEvent.occurredAt), asc(learningEvent.id));
  return inEventOrder(rows as unknown as StoredLearningEvent[]);
}

/**
 * Rechnet Mastery, Queue und Fehlerlog eines Konzepts aus seinem Strom neu.
 *
 * Derselbe Code laeuft im inkrementellen Pfad und im Replay - das ist keine
 * Bequemlichkeit, sondern die Begruendung dafuer, dass beide dasselbe
 * Ergebnis liefern muessen.
 */
async function projectConcept(tx: Transaction, conceptId: string): Promise<void> {
  // Zeilensperre auf dem Mastery-Datensatz: Sie serialisiert zwei gleichzeitige
  // Ereignisse auf demselben Konzept. Ohne sie koennten beide denselben
  // Ausgangsstand lesen und der zweite den ersten ueberschreiben.
  await tx.insert(conceptMastery).values({ conceptId }).onConflictDoNothing();
  await tx.execute(sql`select 1 from concept_mastery where concept_id = ${conceptId} for update`);

  const effective = applyCorrections(await eventsOfConcept(tx, conceptId));

  const mastery = foldConceptMastery(effective);
  if (mastery === null) {
    await tx.delete(conceptMastery).where(eq(conceptMastery.conceptId, conceptId));
  } else {
    await tx
      .update(conceptMastery)
      .set({
        score: mastery.score,
        confidence: mastery.confidence,
        lastCheckedAt: mastery.lastCheckedAt,
        objectiveSignals: mastery.objectiveSignals,
        aiJudgedSignals: mastery.aiJudgedSignals,
        selfReportedSignals: mastery.selfReportedSignals,
        lastEventId: mastery.lastEventId,
        updatedAt: mastery.updatedAt,
      })
      .where(eq(conceptMastery.conceptId, conceptId));
  }

  const queue = foldReviewQueue(effective);
  await tx.delete(reviewQueue).where(eq(reviewQueue.conceptId, conceptId));
  if (queue !== null) {
    await tx.insert(reviewQueue).values({ conceptId, ...queue });
  }

  // Ersetzen statt fortschreiben: Eine Korrektur kann einen frueheren Eintrag
  // gegenstandslos machen. Die IDs stammen aus den Ereignissen, deshalb
  // entsteht dabei kein Rauschen.
  const errors = foldErrorLog(effective);
  await tx.delete(errorLog).where(eq(errorLog.conceptId, conceptId));
  if (errors.length > 0) {
    await tx.insert(errorLog).values(errors.map((entry) => ({ ...entry })));
  }
}

/** Rechnet die Rating-Achse eines Themenbereichs aus allen ihren Ereignissen neu. */
async function projectTopicArea(tx: Transaction, topicArea: ConceptTopicArea): Promise<void> {
  await tx.insert(skillRating).values({ topicArea }).onConflictDoNothing();
  await tx.execute(sql`select 1 from skill_rating where topic_area = ${topicArea} for update`);

  const rows = await tx
    .select({
      id: learningEvent.id,
      eventType: learningEvent.eventType,
      source: learningEvent.source,
      signalClass: learningEvent.signalClass,
      occurredAt: learningEvent.occurredAt,
      conceptId: learningEvent.conceptId,
      chartId: learningEvent.chartId,
      correctsEventId: learningEvent.correctsEventId,
      payload: learningEvent.payload,
    })
    .from(learningEvent)
    .innerJoin(concept, eq(learningEvent.conceptId, concept.id))
    .where(eq(concept.topicArea, topicArea))
    .orderBy(asc(learningEvent.occurredAt), asc(learningEvent.id));

  const effective = applyCorrections(inEventOrder(rows as unknown as StoredLearningEvent[]));
  const rating = foldSkillRating(effective);

  // Der Verlauf wird bei jedem Lauf ersetzt statt fortgeschrieben: Eine
  // Korrektur kann einen alten Punkt gegenstandslos machen. Die IDs sind aus
  // Themenbereich und Tag abgeleitet, deshalb entsteht dabei kein Rauschen.
  await tx.delete(skillRatingSnapshot).where(eq(skillRatingSnapshot.topicArea, topicArea));
  const snapshots = foldSkillRatingSnapshots(effective);
  if (snapshots.length > 0) {
    await tx.insert(skillRatingSnapshot).values(
      snapshots.map((point) => ({
        id: snapshotId(topicArea, point.capturedAt),
        topicArea,
        rating: point.rating,
        capturedAt: point.capturedAt,
      })),
    );
  }

  if (rating === null) {
    // Kein Ereignis im Bereich: Startwerte, aber `updated_at` bleibt stehen -
    // sonst unterschiede sich ein replayter Bestand von einem geseedeten.
    await tx
      .update(skillRating)
      .set({ rating: 0, eventCount: 0 })
      .where(eq(skillRating.topicArea, topicArea));
    return;
  }

  await tx
    .update(skillRating)
    .set({ rating: rating.rating, eventCount: rating.eventCount, updatedAt: rating.updatedAt })
    .where(eq(skillRating.topicArea, topicArea));
}

/* -------------------------------------------------------------------------
 * Replay
 * ---------------------------------------------------------------------- */

export interface ReplayResult {
  readonly events: number;
  readonly concepts: number;
  readonly topicAreas: number;
}

/**
 * Rechnet **den gesamten** abgeleiteten Zustand aus dem Ereignisstrom neu.
 *
 * Das Werkzeug fuer Korrekturen an den Formeln: Stellt sich in T4.3 bis T4.5
 * heraus, dass eine Gewichtung falsch war, wird sie geaendert und der Zustand
 * neu berechnet. Die Ereignisse bleiben unangetastet - die Historie wird nie
 * umgeschrieben, nur neu ausgewertet.
 *
 * Laeuft in einer Transaktion: Waehrend des Replays gibt es keinen Moment, in
 * dem ein Leser einen halb geleerten Lernstand sieht.
 */
export async function replayLearningState(db: Database): Promise<ReplayResult> {
  return db.transaction(async (tx) => {
    // Abgeleitetes verwerfen. Die Ereignisse selbst werden nicht angefasst -
    // auf ihnen liegt der Append-only-Trigger aus T4.1.
    await tx.delete(errorLog);
    await tx.delete(reviewQueue);
    await tx.delete(conceptMastery);
    await tx.delete(skillRatingSnapshot);
    await tx.execute(sql`update skill_rating set rating = 0, event_count = 0`);

    const conceptRows = await tx
      .selectDistinct({ conceptId: learningEvent.conceptId, topicArea: concept.topicArea })
      .from(learningEvent)
      .innerJoin(concept, eq(learningEvent.conceptId, concept.id));

    for (const row of conceptRows) {
      // `level_set`-Ereignisse haben kein Konzept; der Join haelt sie ohnehin
      // heraus, die Pruefung macht es fuer den Compiler sichtbar.
      if (row.conceptId !== null) await projectConcept(tx, row.conceptId);
    }

    const areas = [...new Set(conceptRows.map((row) => row.topicArea as ConceptTopicArea))];
    for (const area of areas) {
      await projectTopicArea(tx, area);
    }

    const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(learningEvent);

    return {
      events: counted?.n ?? 0,
      concepts: conceptRows.length,
      topicAreas: areas.length,
    };
  });
}

/* -------------------------------------------------------------------------
 * Weiterschalt-Entscheidung und Schwellen (AP4.T4.3)
 * ---------------------------------------------------------------------- */

/**
 * Sind chart-verifizierbare Anker fuer dieses Konzept ueberhaupt moeglich?
 *
 * Ermittelt, nicht geraten und nicht fest verdrahtet: ueber die Zuordnung
 * `concept_chart` aus AP3.T3.2 auf `range_chart` - und dort **nur**
 * freigegebene Charts. Ein Chart im Zustand `raw`, `validated`, `failed` oder
 * `unusable` taugt nicht als objektiver Anker; seine Zahlen sind nicht geprueft.
 *
 * Stand bei Abschluss von AP3: 16 der 168 Konzepte haben ein freigegebenes
 * Chart. Fuer alle anderen greift der Uebergangszustand aus Scope-Delta 2 -
 * siehe `evaluateAdvance`.
 */
export async function objectiveAnchorsPossible(
  db: Database | Transaction,
  conceptId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(conceptChart)
    .innerJoin(rangeChart, eq(rangeChart.assetId, conceptChart.assetId))
    .where(and(eq(conceptChart.conceptId, conceptId), eq(rangeChart.state, 'approved')));
  return (row?.n ?? 0) > 0;
}

/** Die lernbezogenen Schwellen aus `learner_state`. */
export async function readLearningThresholds(
  db: Database | Transaction,
): Promise<LearningThresholds> {
  const [row] = await db
    .select({
      masteryThreshold: learnerState.masteryThreshold,
      minObjectiveAnchors: learnerState.minObjectiveAnchors,
    })
    .from(learnerState);

  // Fehlt der Datensatz (noch kein Seed), gelten die Defaults aus dem Vertrag -
  // aber die Entscheidung faellt trotzdem, statt mit einem Fehler abzubrechen.
  return {
    masteryThreshold: row?.masteryThreshold ?? LEARNING_THRESHOLD_RANGES.masteryThreshold.default,
    minObjectiveAnchors:
      row?.minObjectiveAnchors ?? LEARNING_THRESHOLD_RANGES.minObjectiveAnchors.default,
  };
}

/**
 * „Darf ich bei diesem Konzept weitergehen?" - die Frage, die AP5 stellt.
 *
 * Holt den gespeicherten Mastery-Stand, die Schwellen und die Anker-Moeglichkeit
 * und uebergibt alles an die **reine** Entscheidungsfunktion. Die Logik selbst
 * steht in `mastery.ts` und ist ohne Datenbank testbar; hier passiert nur das
 * Einsammeln.
 *
 * `asOf` ist ein ausdrueckliches Argument und hat einen Default: Der Aufrufer
 * entscheidet, gegen welchen Zeitpunkt die Konfidenz-Veralterung gerechnet
 * wird. In der Ableitung waere „jetzt" verboten - hier ist es genau richtig,
 * weil nichts gespeichert wird.
 */
export async function evaluateConceptAdvance(
  db: Database,
  conceptId: string,
  asOf: Date = new Date(),
): Promise<AdvanceDecision> {
  const [row] = await db
    .select()
    .from(conceptMastery)
    .where(eq(conceptMastery.conceptId, conceptId));

  const [thresholds, anchorsPossible] = await Promise.all([
    readLearningThresholds(db),
    objectiveAnchorsPossible(db, conceptId),
  ]);

  return evaluateAdvance({
    mastery: row
      ? {
          score: row.score,
          confidence: row.confidence,
          objectiveSignals: row.objectiveSignals,
          aiJudgedSignals: row.aiJudgedSignals,
          selfReportedSignals: row.selfReportedSignals,
          lastCheckedAt: row.lastCheckedAt,
        }
      : null,
    thresholds,
    objectiveAnchorsPossible: anchorsPossible,
    asOf,
  });
}

/**
 * Aendert die Schwellen in `learner_state` - **serverseitig geprueft**.
 *
 * Die Grenzen stehen in `LEARNING_THRESHOLD_RANGES` und werden hier
 * durchgesetzt, nicht nur angezeigt. Ein Wert ausserhalb wird abgelehnt und
 * nicht auf den Default umgebogen: Sonst zeigte die Oberflaeche spaeter eine
 * Einstellung, die niemand benutzt (dasselbe Prinzip wie ADR-0029).
 */
export async function updateLearningThresholds(
  db: Database,
  patch: LearningThresholdUpdate,
): Promise<LearningThresholds> {
  const fields: EventFieldError[] = [];
  const values: Record<string, number> = {};

  const mt = patch.masteryThreshold;
  if (mt !== undefined) {
    const range = LEARNING_THRESHOLD_RANGES.masteryThreshold;
    if (typeof mt !== 'number' || !Number.isFinite(mt) || mt < range.min || mt > range.max) {
      fields.push({
        field: 'masteryThreshold',
        message: `Die Mastery-Schwelle muss zwischen ${range.min} und ${range.max} liegen.`,
      });
    } else {
      values['masteryThreshold'] = mt;
    }
  }

  const anchors = patch.minObjectiveAnchors;
  if (anchors !== undefined) {
    const range = LEARNING_THRESHOLD_RANGES.minObjectiveAnchors;
    if (!Number.isInteger(anchors) || anchors < range.min || anchors > range.max) {
      fields.push({
        field: 'minObjectiveAnchors',
        message: `Die Mindestzahl objektiver Anker muss eine ganze Zahl zwischen ${range.min} und ${range.max} sein.`,
      });
    } else {
      values['minObjectiveAnchors'] = anchors;
    }
  }

  if (fields.length > 0) throw new LearningEventValidationError(fields);

  if (Object.keys(values).length > 0) {
    await db.update(learnerState).set({ ...values, updatedAt: new Date() });
  }

  return readLearningThresholds(db);
}

/* -------------------------------------------------------------------------
 * Abruf der Wiederholungs-Queue (AP4.T4.4)
 * ---------------------------------------------------------------------- */

/**
 * „Gib mir N faellige Eintraege fuer Kontext X."
 *
 * Der Abruf, ueber den AP5 (Lern-Session), AP7 (Drill) und AP9
 * (Materialtrigger) ihre Wiederholungen holen.
 *
 * **Es wird nicht kuenstlich aufgefuellt.** Sind weniger als `limit` Eintraege
 * faellig, kommen weniger - und `dueTotal` sagt, wie viele es tatsaechlich
 * waren. Ob mit neuem Stoff ergaenzt wird, entscheidet der Aufrufer; die Queue
 * erfindet nichts, nur um eine Zahl zu erreichen.
 *
 * `asOf` ist **Pflicht** und kommt von aussen. Ohne diesen Parameter waere der
 * Abruf nicht pruefbar - und die Versuchung gross, doch `Date.now()` zu
 * nehmen.
 */
export async function dueReviews(
  db: Database,
  query: DueReviewsQuery,
): Promise<DueReviewsResponse> {
  const rows = await selectQueueRows(db, lte(reviewQueue.dueAt, query.asOf), query.topicAreas);

  const candidates: ReviewCandidate[] = rows.map((row) => ({
    conceptId: row.conceptId,
    dueAt: row.dueAt,
    origin: row.origin as ReviewQueueOrigin,
    intervalDays: row.intervalDays,
    easeFactor: row.easeFactor,
    repetitions: row.repetitions,
    lapses: row.lapses,
    masteryScore: row.masteryScore ?? 0,
    prerequisiteIds: [],
  }));

  // Voraussetzungen nur fuer die faelligen Konzepte nachladen - die Regel
  // greift ohnehin ausschliesslich zwischen Eintraegen derselben Ausgabe.
  const withPrerequisites = await attachPrerequisites(db, candidates);
  const ordered = prioritizeReviews(withPrerequisites, query.asOf);
  const limited = ordered.slice(0, Math.max(0, query.limit));

  const byId = new Map(rows.map((row) => [row.conceptId, row]));

  return {
    context: query.context,
    limit: query.limit,
    asOf: query.asOf.toISOString(),
    items: limited.map((candidate) => {
      const row = byId.get(candidate.conceptId);
      return {
        conceptId: candidate.conceptId,
        conceptTitle: row?.title ?? '',
        topicArea: (row?.topicArea ?? 'grundlagen-mathematik') as ConceptTopicArea,
        conceptState: row?.state ?? 'draft',
        dueAt: candidate.dueAt.toISOString(),
        overdueDays: overdueDays(candidate, query.asOf),
        origin: candidate.origin,
        intervalDays: candidate.intervalDays,
        easeFactor: candidate.easeFactor,
        repetitions: candidate.repetitions,
        lapses: candidate.lapses,
        masteryScore: candidate.masteryScore,
      };
    }),
    // Die ehrliche Zahl: wie viele faellig waren, nicht wie viele passten.
    dueTotal: ordered.length,
    returned: limited.length,
  };
}

/** „Was wird demnaechst faellig?" - die Vorschau fuer das Dashboard in T4.7. */
export async function upcomingReviews(
  db: Database,
  query: UpcomingReviewsQuery,
): Promise<UpcomingReviewsResponse> {
  const until = new Date(query.asOf.getTime() + query.withinDays * 24 * 60 * 60 * 1000);
  const rows = await selectQueueRows(
    db,
    and(gt(reviewQueue.dueAt, query.asOf), lte(reviewQueue.dueAt, until)),
  );

  const sorted = [...rows].sort(
    (a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.conceptId.localeCompare(b.conceptId),
  );

  return {
    asOf: query.asOf.toISOString(),
    withinDays: query.withinDays,
    items: sorted.slice(0, Math.max(0, query.limit)).map((row) => ({
      conceptId: row.conceptId,
      conceptTitle: row.title,
      topicArea: row.topicArea as ConceptTopicArea,
      dueAt: row.dueAt.toISOString(),
      inDays: Math.ceil((row.dueAt.getTime() - query.asOf.getTime()) / (24 * 60 * 60 * 1000)),
      origin: row.origin as ReviewQueueOrigin,
    })),
    total: sorted.length,
  };
}

/** Queue-Zeilen samt Konzeptangaben und Mastery-Score. */
async function selectQueueRows(
  db: Database,
  where: SQL | undefined,
  topicAreas?: readonly ConceptTopicArea[],
): Promise<
  {
    conceptId: string;
    title: string;
    topicArea: string;
    state: string;
    dueAt: Date;
    origin: string;
    intervalDays: number;
    easeFactor: number;
    repetitions: number;
    lapses: number;
    masteryScore: number | null;
  }[]
> {
  const filters = [where];
  if (topicAreas && topicAreas.length > 0) {
    filters.push(inArray(concept.topicArea, [...topicAreas]));
  }

  return db
    .select({
      conceptId: reviewQueue.conceptId,
      title: concept.title,
      topicArea: concept.topicArea,
      state: concept.state,
      dueAt: reviewQueue.dueAt,
      origin: reviewQueue.origin,
      intervalDays: reviewQueue.intervalDays,
      easeFactor: reviewQueue.easeFactor,
      repetitions: reviewQueue.repetitions,
      lapses: reviewQueue.lapses,
      masteryScore: conceptMastery.score,
    })
    .from(reviewQueue)
    .innerJoin(concept, eq(concept.id, reviewQueue.conceptId))
    .leftJoin(conceptMastery, eq(conceptMastery.conceptId, reviewQueue.conceptId))
    .where(and(...filters.filter((filter): filter is SQL => filter !== undefined)));
}

/** Laedt die Voraussetzungskanten, die zwischen den faelligen Konzepten liegen. */
async function attachPrerequisites(
  db: Database,
  candidates: readonly ReviewCandidate[],
): Promise<ReviewCandidate[]> {
  if (candidates.length === 0) return [];

  const ids = candidates.map((candidate) => candidate.conceptId);
  const edges = await db
    .select({
      conceptId: conceptPrerequisite.conceptId,
      prerequisiteId: conceptPrerequisite.prerequisiteId,
    })
    .from(conceptPrerequisite)
    .where(inArray(conceptPrerequisite.conceptId, ids));

  const byConcept = new Map<string, string[]>();
  for (const edge of edges) {
    const list = byConcept.get(edge.conceptId) ?? [];
    list.push(edge.prerequisiteId);
    byConcept.set(edge.conceptId, list);
  }

  return candidates.map((candidate) => ({
    ...candidate,
    prerequisiteIds: byConcept.get(candidate.conceptId) ?? [],
  }));
}

/* -------------------------------------------------------------------------
 * Skill-Ratings und Level (AP4.T4.5)
 * ---------------------------------------------------------------------- */

/**
 * Sammelt die Kennzahlen, aus denen sich das Level ergibt.
 *
 * Drei unabhaengige Groessen: Wie gut laeuft es im Schnitt, wie viele Konzepte
 * sitzen belastbar, und wie viel davon ist objektiv belegt. Jede fuer sich
 * waere zu leicht zu erreichen - der Durchschnitt aus zwei guten Bereichen,
 * die Konzeptzahl aus lauter Modellurteilen.
 */
async function collectLevelSignals(tx: Transaction): Promise<LevelSignals> {
  const [ratings] = await tx
    .select({
      average: sql<
        number | null
      >`avg(${skillRating.rating}) filter (where ${skillRating.eventCount} > 0)`,
      covered: sql<number>`count(*) filter (where ${skillRating.eventCount} > 0)::int`,
    })
    .from(skillRating);

  const [mastery] = await tx
    .select({
      mastered: sql<number>`count(*) filter (where ${conceptMastery.score} >= ${MASTERED_SCORE}
        and ${conceptMastery.confidence} >= ${MASTERED_CONFIDENCE})::int`,
      objective: sql<number>`coalesce(sum(${conceptMastery.objectiveSignals}), 0)::int`,
      total: sql<number>`coalesce(sum(${conceptMastery.objectiveSignals}
        + ${conceptMastery.aiJudgedSignals} + ${conceptMastery.selfReportedSignals}), 0)::int`,
    })
    .from(conceptMastery);

  const totalSignals = mastery?.total ?? 0;

  return {
    averageRating: Number(ratings?.average ?? 0),
    coveredTopicAreas: ratings?.covered ?? 0,
    masteredConcepts: mastery?.mastered ?? 0,
    objectiveShare: totalSignals === 0 ? 0 : (mastery?.objective ?? 0) / totalSignals,
    totalSignals,
  };
}

/** Die juengste manuelle Level-Setzung aus dem Ereignisstrom, falls es eine gibt. */
async function latestManualLevel(
  tx: Transaction,
): Promise<{ level: LearnerLevel; setAt: Date } | undefined> {
  const [row] = await tx
    .select({ payload: learningEvent.payload, occurredAt: learningEvent.occurredAt })
    .from(learningEvent)
    .where(eq(learningEvent.eventType, 'level_set'))
    .orderBy(desc(learningEvent.occurredAt), desc(learningEvent.id))
    .limit(1);

  if (!row) return undefined;
  const payload = row.payload as unknown as LevelSetPayload;
  return { level: payload.level, setAt: row.occurredAt };
}

/**
 * Schreibt das kalibrierte Level nach `learner_state`.
 *
 * Laeuft nach jedem Ereignis und am Ende jedes Replays. Der Bezugszeitpunkt
 * `asOf` kommt von aussen - beim Aufzeichnen ist es der Ereigniszeitpunkt,
 * beim Replay der des juengsten Ereignisses. Nie die Systemzeit: Sonst haenge
 * das Ergebnis eines Replays davon ab, wann man ihn faehrt.
 *
 * Wiederholt, bis sich nichts mehr aendert (hoechstens so oft, wie es Stufen
 * gibt). Damit landet der Replay bei derselben Stufe wie der inkrementelle
 * Weg, auch wenn dieser sich in mehreren Schritten dorthin bewegt hat.
 */
async function projectLearnerLevel(tx: Transaction, asOf: Date): Promise<LevelCalibration> {
  const [signals, manual] = await Promise.all([collectLevelSignals(tx), latestManualLevel(tx)]);

  const [state] = await tx.select({ level: learnerState.level }).from(learnerState);
  const current = (state?.level ?? 'einsteiger') as LearnerLevel;

  // Ein Aufruf genuegt: `calibrateLevel` ist ein Fixpunkt (siehe dort). Ein
  // zweiter Durchgang aenderte nichts - und genau das laesst den Replay
  // dieselbe Stufe liefern wie den inkrementellen Weg.
  const calibration = calibrateLevel({ current, signals, manual, asOf });

  if (calibration.level !== current) {
    await tx.update(learnerState).set({ level: calibration.level, updatedAt: asOf });
  }

  return calibration;
}

/**
 * Das aktuelle Level samt Begruendungsbausteinen - die Frage, die AP5 stellt.
 *
 * Rechnet nicht neu und schreibt nichts: Es liest den gespeicherten Stand und
 * legt die Kennzahlen daneben. `asOf` entscheidet nur darueber, ob eine
 * manuelle Setzung noch gilt.
 */
export async function readLearnerLevel(
  db: Database,
  asOf: Date = new Date(),
): Promise<LevelCalibration> {
  const [signals, manual] = await Promise.all([
    collectLevelSignals(db as unknown as Transaction),
    latestManualLevel(db as unknown as Transaction),
  ]);
  const [state] = await db.select({ level: learnerState.level }).from(learnerState);

  return calibrateLevel({
    current: (state?.level ?? 'einsteiger') as LearnerLevel,
    signals,
    manual,
    asOf,
  });
}

/**
 * Setzt das Level von Hand - **als Ereignis**, nicht als Schreibzugriff.
 *
 * Damit gilt auch hier das Umgehungsverbot aus T4.2: Der Replay kennt die
 * Korrektur, weil sie im Protokoll steht. Sie wird
 * `MANUAL_LEVEL_GRACE_DAYS` Tage respektiert; danach greift die Automatik
 * wieder (ADR-0045).
 */
export async function setLearnerLevel(
  db: Database,
  input: { readonly eventId: string; readonly level: LearnerLevel; readonly reason?: string },
): Promise<RecordLearningEventResponse> {
  return recordLearningEvent(db, {
    id: input.eventId,
    eventType: 'level_set',
    source: 'manual',
    // Eine Selbsteinschaetzung ist genau das - die schwaechste Signalklasse.
    signalClass: 'self_reported',
    payload: {
      level: input.level,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
  });
}

/** Alle Rating-Achsen mit ihrem aktuellen Stand - die Grundlage des Radars in AP6. */
export async function readSkillRatings(db: Database): Promise<readonly SkillRatingView[]> {
  const rows = await db
    .select({
      topicArea: skillRating.topicArea,
      rating: skillRating.rating,
      eventCount: skillRating.eventCount,
      updatedAt: skillRating.updatedAt,
    })
    .from(skillRating);

  const byArea = new Map(rows.map((row) => [row.topicArea, row]));

  // Immer alle zwoelf Achsen, in der Reihenfolge der Liste aus T3.2 - auch die
  // ohne Datenlage. Eine fehlende Achse waere in der Anzeige nicht von einer
  // schlechten zu unterscheiden.
  return CONCEPT_TOPIC_AREAS.map((area) => {
    const row = byArea.get(area.id);
    return {
      topicArea: area.id,
      label: area.label,
      rating: row?.rating ?? 0,
      eventCount: row?.eventCount ?? 0,
      updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
    };
  });
}

/** Der Verlauf einer Achse - ein Punkt je Kalendertag. */
export async function readRatingHistory(
  db: Database,
  topicArea: ConceptTopicArea,
): Promise<SkillRatingHistory> {
  const rows = await db
    .select({ capturedAt: skillRatingSnapshot.capturedAt, rating: skillRatingSnapshot.rating })
    .from(skillRatingSnapshot)
    .where(eq(skillRatingSnapshot.topicArea, topicArea))
    .orderBy(asc(skillRatingSnapshot.capturedAt));

  return {
    topicArea,
    points: rows.map((row) => ({
      day: startOfUtcDay(row.capturedAt).toISOString().slice(0, 10),
      rating: row.rating,
    })),
  };
}
