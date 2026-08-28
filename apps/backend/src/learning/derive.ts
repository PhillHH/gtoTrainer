import { DEFAULT_DIFFICULTY } from '@gto/shared';
import type {
  ConceptExplainedPayload,
  DrillCompletedPayload,
  LearningErrorSeverity,
  LearningEventSource,
  LearningEventType,
  LearningSignalClass,
  ManualCorrectionPayload,
  ReviewQueueOrigin,
} from '@gto/shared';
import { computeMasteryState } from './mastery.js';
import type { MasterySignal } from './mastery.js';

/**
 * Die Ableitungen des Lernstands (AP4.T4.2) - **reine Funktionen**.
 *
 * INTERN. Dieses Modul wird ausserhalb von `src/learning/` nicht importiert;
 * eine ESLint-Regel (`no-restricted-imports` in `eslint.config.js`) weist einen
 * solchen Import ab. Der einzige Weg in den Lernstand ist
 * `recordLearningEvent` - siehe INTERFACES.md 18.
 *
 * ## Die Determinismus-Regel (bindend fuer T4.3 bis T4.5)
 *
 * Eine Ableitung darf **ausschliesslich** vom Ereignisstrom abhaengen:
 *
 * - kein `Date.now()`, kein `new Date()` ohne Argument - jeder Zeitbezug
 *   stammt aus `occurredAt` des Ereignisses,
 * - kein `Math.random()`,
 * - kein Datenbank- oder Netzzugriff.
 *
 * Grund: Der Replay rechnet denselben Strom ein zweites Mal durch und muss
 * denselben Zustand erzeugen. Eine einzige Systemzeit-Abfrage in einer Formel
 * machte diesen Vergleich unmoeglich - und damit die Definition-of-Done von
 * AP4 unerreichbar.
 *
 * ## Was hier bewusst schlicht ist
 *
 * Die Formeln sind Platzhalter. T4.3 ersetzt die Mastery-Berechnung, T4.4 die
 * Wiederholungssteuerung, T4.5 die Ratings. Der Zuschnitt ist so gewaehlt,
 * dass dabei nur der Rumpf der jeweiligen `fold*`-Funktion getauscht wird -
 * die Verdrahtung im Service bleibt unberuehrt.
 */

/* -------------------------------------------------------------------------
 * Eingabe: ein Ereignis, so wie es in der Datenbank steht
 * ---------------------------------------------------------------------- */

export interface StoredLearningEvent {
  readonly id: string;
  readonly eventType: LearningEventType;
  readonly source: LearningEventSource;
  readonly signalClass: LearningSignalClass;
  readonly occurredAt: Date;
  readonly conceptId: string;
  readonly chartId: string | null;
  readonly correctsEventId: string | null;
  readonly payload: Record<string, unknown>;
}

/**
 * Sortiert den Strom in die **einzig gueltige** Reihenfolge: nach fachlichem
 * Zeitpunkt, bei Gleichstand nach Ereignis-ID.
 *
 * Der zweite Schluessel ist kein Detail: Ohne ihn haengt das Ergebnis bei
 * zeitgleichen Ereignissen an der Reihenfolge, in der die Datenbank die Zeilen
 * liefert - und die ist nicht zugesichert. Der Replay koennte dann von der
 * inkrementellen Rechnung abweichen, ohne dass sich etwas geaendert hat.
 */
export function inEventOrder(
  events: readonly StoredLearningEvent[],
): readonly StoredLearningEvent[] {
  return [...events].sort((a, b) => {
    const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}

/* -------------------------------------------------------------------------
 * Schritt 1: Korrekturen anwenden
 * ---------------------------------------------------------------------- */

/** Ein Ereignis mit dem Ergebnis, das nach allen Korrekturen tatsaechlich gilt. */
export interface EffectiveEvent {
  readonly event: StoredLearningEvent;
  /** 0 bis 1. `null` = traegt nichts bei (aufgehoben oder Meta-Ereignis). */
  readonly outcome: number | null;
  /** Wurde das Ergebnis durch eine Korrektur veraendert? */
  readonly corrected: boolean;
}

/**
 * Das rohe Ergebnis eines Ereignisses aus seinen Nutzdaten - 0 bis 1.
 *
 * `manual_correction` liefert `null`: Eine Korrektur ist ein Meta-Ereignis.
 * Sie veraendert die Wirkung eines anderen Ereignisses und zaehlt selbst
 * weder als Signal noch als Ergebnis - sonst wuerde jede Richtigstellung den
 * Lernstand zusaetzlich bewegen.
 */
function rawOutcome(event: StoredLearningEvent): number | null {
  switch (event.eventType) {
    case 'question_answered':
    case 'hand_analyzed':
    case 'review_performed':
      return event.payload['correct'] === true ? 1 : 0;
    case 'concept_explained':
      return (event.payload as unknown as ConceptExplainedPayload).quality;
    case 'drill_completed': {
      const { correct, total } = event.payload as unknown as DrillCompletedPayload;
      return total > 0 ? correct / total : 0;
    }
    case 'manual_correction':
      return null;
  }
}

/**
 * Wendet die Korrekturen auf den Strom an.
 *
 * Mehrere Korrekturen auf dasselbe Ereignis sind erlaubt; die **letzte** in
 * der Ereignisreihenfolge gilt. Das ist die einzige Auflösung, die sich beim
 * Replay wiederholen laesst.
 */
export function applyCorrections(
  ordered: readonly StoredLearningEvent[],
): readonly EffectiveEvent[] {
  const corrections = new Map<string, ManualCorrectionPayload>();
  for (const event of ordered) {
    if (event.eventType === 'manual_correction' && event.correctsEventId) {
      corrections.set(event.correctsEventId, event.payload as unknown as ManualCorrectionPayload);
    }
  }

  return ordered.map((event) => {
    const correction = corrections.get(event.id);
    if (!correction) return { event, outcome: rawOutcome(event), corrected: false };

    // Ohne Ersatzwert ist das Ereignis aufgehoben - als haette es nie
    // stattgefunden. Mit Ersatzwert gilt dieser statt des urspruenglichen.
    const replacement = correction.replacementOutcome;
    return {
      event,
      outcome: replacement === undefined || replacement === null ? null : replacement,
      corrected: true,
    };
  });
}

/** Nur die Ereignisse, die tatsaechlich etwas beitragen. */
function contributing(effective: readonly EffectiveEvent[]): readonly EffectiveEvent[] {
  return effective.filter((entry) => entry.outcome !== null);
}

/* -------------------------------------------------------------------------
 * Schritt 2a: Mastery je Konzept
 * ---------------------------------------------------------------------- */

export interface MasteryProjection {
  readonly score: number;
  readonly confidence: number;
  readonly lastCheckedAt: Date;
  readonly objectiveSignals: number;
  readonly aiJudgedSignals: number;
  readonly selfReportedSignals: number;
  readonly lastEventId: string;
  readonly updatedAt: Date;
}

/**
 * Mastery je Konzept - die Formel steht seit T4.3 in `mastery.ts`.
 *
 * Diese Funktion ist nur noch die **Verdrahtung**: Sie uebersetzt den
 * Ereignisstrom in Signale und reicht sie an die reine Berechnung weiter. Genau
 * so war der Zuschnitt in T4.2 gedacht - T4.3 hat die Formel ersetzt, ohne den
 * Service anzufassen.
 *
 * Die Schwierigkeit kommt aus dem Ereignis (`payload.difficulty`) und wird
 * nicht geraten; fehlt sie, gilt mittlere Schwierigkeit.
 *
 * `null` = es gibt nichts abzuleiten (kein Ereignis oder alle aufgehoben).
 */
export function foldConceptMastery(effective: readonly EffectiveEvent[]): MasteryProjection | null {
  const relevant = contributing(effective);
  if (relevant.length === 0) return null;

  const signals: MasterySignal[] = relevant.map((entry) => ({
    signalClass: entry.event.signalClass,
    outcome: entry.outcome as number,
    difficulty: readDifficulty(entry.event),
    occurredAt: entry.event.occurredAt,
  }));

  const state = computeMasteryState(signals);
  if (state === null) return null;

  const last = relevant[relevant.length - 1] as EffectiveEvent;

  return {
    score: state.score,
    confidence: state.confidence,
    lastCheckedAt: state.lastCheckedAt,
    objectiveSignals: state.objectiveSignals,
    aiJudgedSignals: state.aiJudgedSignals,
    selfReportedSignals: state.selfReportedSignals,
    lastEventId: last.event.id,
    // Aus dem Ereignis, nicht aus der Systemzeit - siehe Determinismus-Regel.
    updatedAt: last.event.occurredAt,
  };
}

/** Schwierigkeit aus den Nutzdaten; fehlt sie, gilt mittlere Schwierigkeit. */
function readDifficulty(event: StoredLearningEvent): number {
  const value = event.payload['difficulty'];
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DIFFICULTY;
}

/** Haelt Rundungsreste sicher innerhalb der CHECK-Constraints aus T4.1. */
function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* -------------------------------------------------------------------------
 * Schritt 2b: Wiederholungs-Queue
 * ---------------------------------------------------------------------- */

export interface QueueProjection {
  readonly dueAt: Date;
  readonly intervalDays: number;
  readonly easeFactor: number;
  readonly repetitions: number;
  readonly lapses: number;
  readonly origin: ReviewQueueOrigin;
  readonly lastReviewedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Ab hier gilt ein Ergebnis als misslungen. */
const FAILURE_THRESHOLD = 0.5;

/** Ein Tag in Millisekunden - fuer die Faelligkeit aus dem Ereigniszeitpunkt. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Woher der Eintrag stammt, abgeleitet aus der Quelle des **ersten**
 * misslungenen Ereignisses. Deterministisch, weil der Strom geordnet ist.
 */
function queueOrigin(source: LearningEventSource): ReviewQueueOrigin {
  switch (source) {
    case 'hand_analysis':
    case 'tournament':
      return 'practice_finding';
    case 'theory_session':
    case 'journal':
      return 'knowledge_gap';
    case 'drill':
    case 'manual':
      return 'error';
  }
}

/**
 * PLATZHALTER - T4.4 ersetzt die Formel durch SM-2.
 *
 * Regel hier: Ein Konzept steht in der Queue, sobald es mindestens ein
 * misslungenes Ergebnis gab. Faelligkeit ist ein Tag nach dem letzten
 * Ereignis, das Intervall bleibt bei 1, der Ease-Faktor beim Startwert.
 * Gezaehlt werden aber schon `repetitions` (gelungen) und `lapses`
 * (misslungen) - T4.4 rechnet damit, ohne den Strom neu lesen zu muessen.
 *
 * `null` = das Konzept gehoert nicht in die Queue.
 */
export function foldReviewQueue(effective: readonly EffectiveEvent[]): QueueProjection | null {
  const relevant = contributing(effective);
  if (relevant.length === 0) return null;

  let repetitions = 0;
  let lapses = 0;
  let firstFailure: EffectiveEvent | undefined;

  for (const entry of relevant) {
    if ((entry.outcome as number) < FAILURE_THRESHOLD) {
      lapses += 1;
      firstFailure ??= entry;
    } else {
      repetitions += 1;
    }
  }

  if (!firstFailure) return null;

  const last = relevant[relevant.length - 1] as EffectiveEvent;
  const intervalDays = 1;

  return {
    dueAt: new Date(last.event.occurredAt.getTime() + intervalDays * DAY_MS),
    intervalDays,
    // Startwert aus dem Vertrag; T4.4 bewegt ihn.
    easeFactor: 2.5,
    repetitions,
    lapses,
    origin: queueOrigin(firstFailure.event.source),
    lastReviewedAt: last.event.occurredAt,
    createdAt: firstFailure.event.occurredAt,
    updatedAt: last.event.occurredAt,
  };
}

/* -------------------------------------------------------------------------
 * Schritt 2c: Fehlerprotokoll
 * ---------------------------------------------------------------------- */

export interface ErrorProjection {
  /** **Die Ereignis-ID.** Ein Ereignis erzeugt hoechstens einen Eintrag. */
  readonly id: string;
  readonly eventId: string;
  readonly conceptId: string;
  readonly occurredAt: Date;
  readonly contextKind: LearningEventSource;
  readonly contextRef: string | null;
  readonly description: string;
  readonly severity: LearningErrorSeverity;
  readonly createdAt: Date;
}

/** Kennung der Session, des Drills oder der Hand, soweit die Nutzdaten sie tragen. */
function contextRef(event: StoredLearningEvent): string | null {
  for (const key of ['drillId', 'handRef', 'questionId']) {
    const value = event.payload[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Klartext, der in der Nachschau ohne die Nutzdaten verstaendlich ist. */
function describe(entry: EffectiveEvent): string {
  const { event, outcome } = entry;
  const suffix = entry.corrected ? ' (nach Korrektur)' : '';
  switch (event.eventType) {
    case 'question_answered':
      return `Frage falsch beantwortet${suffix}.`;
    case 'concept_explained':
      return `Erklärung unzureichend (${(outcome as number).toFixed(2)})${suffix}.`;
    case 'drill_completed':
      return `Drill überwiegend falsch (${(outcome as number).toFixed(2)})${suffix}.`;
    case 'hand_analyzed': {
      const mistake = event.payload['mistake'];
      return typeof mistake === 'string' && mistake !== ''
        ? `Fehler in der Hand-Analyse: ${mistake}${suffix}.`
        : `Fehler in der Hand-Analyse${suffix}.`;
    }
    case 'review_performed':
      return `Wiederholung nicht bestanden${suffix}.`;
    case 'manual_correction':
      return `Korrektur${suffix}.`;
  }
}

/**
 * PLATZHALTER der Schweregrad-Einstufung - T4.6 wertet die Eintraege aus.
 *
 * Ein Eintrag entsteht fuer jedes misslungene Ergebnis. **Kein zweiter
 * Schreibweg:** Was nicht im Ereignisstrom steht, kann nicht im Fehlerlog
 * stehen. Ein aufgehobenes Ereignis erzeugt keinen Eintrag mehr - genau das
 * ist der Zweck der Korrektur.
 */
export function foldErrorLog(effective: readonly EffectiveEvent[]): readonly ErrorProjection[] {
  return contributing(effective)
    .filter((entry) => (entry.outcome as number) < FAILURE_THRESHOLD)
    .map((entry) => ({
      id: entry.event.id,
      eventId: entry.event.id,
      conceptId: entry.event.conceptId,
      occurredAt: entry.event.occurredAt,
      contextKind: entry.event.source,
      contextRef: contextRef(entry.event),
      description: describe(entry),
      severity: (entry.outcome as number) === 0 ? 'high' : 'medium',
      createdAt: entry.event.occurredAt,
    }));
}

/* -------------------------------------------------------------------------
 * Schritt 2d: Skill-Rating je Themenbereich
 * ---------------------------------------------------------------------- */

export interface RatingProjection {
  readonly rating: number;
  readonly eventCount: number;
  readonly updatedAt: Date;
}

/**
 * PLATZHALTER - T4.5 ersetzt die Formel durch eine EWMA mit
 * Schwierigkeitsgewicht und ergaenzt die Level-Kalibrierung.
 *
 * Hier: das arithmetische Mittel aller Ergebnisse des Themenbereichs.
 *
 * `null` = im Themenbereich gab es nichts; die Achse bleibt auf ihrem
 * Startwert und wird **nicht angefasst**. Wuerde sie mit einem Zeitstempel
 * ueberschrieben, unterschiede sich ein frisch geseedeter Bestand von einem
 * replayten - ohne dass ein Ereignis dahinterstuende.
 */
export function foldSkillRating(effective: readonly EffectiveEvent[]): RatingProjection | null {
  const relevant = contributing(effective);
  if (relevant.length === 0) return null;

  const sum = relevant.reduce((acc, entry) => acc + (entry.outcome as number), 0);
  const last = relevant[relevant.length - 1] as EffectiveEvent;

  return {
    rating: clampRatio(sum / relevant.length),
    eventCount: relevant.length,
    updatedAt: last.event.occurredAt,
  };
}
