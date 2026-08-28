import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  LEARNING_THRESHOLD_RANGES,
  isLearningEventSource,
  isLearningEventType,
  isLearningSignalClass,
  validateLearningEventPayload,
} from '@gto/shared';
import type {
  AdvanceDecision,
  ConceptTopicArea,
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
  inEventOrder,
} from './derive.js';
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
  readonly conceptId: string;
  readonly topicArea: ConceptTopicArea;
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

  // Das Konzept muss existieren - und wir brauchen ohnehin seinen
  // Themenbereich fuer die Rating-Achse.
  let topicArea: ConceptTopicArea | undefined;
  if (typeof input?.conceptId === 'string' && UUID_PATTERN.test(input.conceptId)) {
    const [row] = await db
      .select({ topicArea: concept.topicArea })
      .from(concept)
      .where(eq(concept.id, input.conceptId));
    if (!row) {
      fields.push({ field: 'conceptId', message: `Konzept "${input.conceptId}" existiert nicht.` });
    } else {
      topicArea = row.topicArea as ConceptTopicArea;
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
    conceptId: input.conceptId,
    topicArea: topicArea as ConceptTopicArea,
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

    await projectConcept(tx, event.conceptId);
    await projectTopicArea(tx, event.topicArea);

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
    await tx.execute(sql`delete from skill_rating_snapshot`);
    await tx.execute(sql`update skill_rating set rating = 0, event_count = 0`);

    const conceptRows = await tx
      .selectDistinct({ conceptId: learningEvent.conceptId, topicArea: concept.topicArea })
      .from(learningEvent)
      .innerJoin(concept, eq(learningEvent.conceptId, concept.id));

    for (const row of conceptRows) {
      await projectConcept(tx, row.conceptId);
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
