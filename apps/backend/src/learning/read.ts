import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { CONCEPT_TOPIC_AREAS, conceptTopicAreaLabel } from '@gto/shared';
import type {
  ChapterProgress,
  ConceptLearningDetail,
  ConceptTopicArea,
  DashboardReport,
  LearnerLevel,
  LearningDashboard,
  LevelHistoryPoint,
  MasteryHistoryPoint,
  QueuePreview,
  RatingsOverview,
  ReviewContext,
  SkillRatingHistory,
} from '@gto/shared';
import type { Database } from '../db/client.js';
import {
  bookAsset,
  bookChapter,
  concept,
  conceptChart,
  conceptMastery,
  conceptPrerequisite,
  errorLog,
  learningEvent,
  rangeChart,
  reviewQueue,
} from '../db/schema.js';
import { applyCorrections, inEventOrder } from './derive.js';
import type { StoredLearningEvent } from './derive.js';
import { MASTERED_CONFIDENCE, MASTERED_SCORE, calibrateLevel } from './level.js';
import { computeMasteryState } from './mastery.js';
import type { MasterySignal } from './mastery.js';
import { startOfUtcDay } from './rating.js';
import { readLatestReport } from './report.js';
import { overdueDays } from './review.js';
import {
  dueReviews,
  evaluateConceptAdvance,
  objectiveAnchorsPossible,
  readLearnerLevel,
  readRatingHistory,
  readSkillRatings,
  upcomingReviews,
} from './service.js';

/**
 * Die **einzige Lesestelle** des Lernstands (AP4.T4.7).
 *
 * Vier Abrufe, gegen die AP6 baut: Dashboard-Aggregat, Konzeptdetail,
 * Queue-Vorschau und Ratings-Verlauf.
 *
 * ## Zwei Regeln, die hier zaehlen
 *
 * 1. **Lesend heisst lesend.** Kein Abruf erzeugt ein Ereignis, verschiebt eine
 *    Faelligkeit oder aktualisiert ein Rating. Ein Dashboard-Aufruf fasst den
 *    Lernstand nicht an.
 * 2. **Durchreichen, nicht neu rechnen.** Die Ergebnisse aus T4.3 bis T4.5
 *    werden weitergegeben, nicht umgedeutet. Eine zweite Berechnungslogik an
 *    dieser Stelle waere der Anfang von Parallelbuchhaltung - zwei Zahlen fuer
 *    dasselbe, und niemand weiss, welche stimmt.
 *
 * Wo doch gerechnet wird - Mastery- und Level-Verlauf -, geschieht das mit
 * **denselben reinen Funktionen**, die auch die Ableitung benutzt. Es gibt
 * keine zweite Formel, nur eine zweite Auswertung derselben.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------
 * 1. Dashboard-Aggregat
 * ---------------------------------------------------------------------- */

/**
 * Alles, was die Startseite zeigt - in **einem** Abruf.
 *
 * ## Warum das ohne N+1 laufen muss
 *
 * Bei 168 Konzepten waere eine Abfrage je Konzept spuerbar - und das Dashboard
 * wird bei jedem Start geladen. Der Kapitelfortschritt kommt deshalb aus
 * **einer** gruppierten Abfrage, nicht aus einer Schleife. Die Zahl der
 * Abfragen ist konstant: Sie haengt nicht davon ab, wie viele Kapitel,
 * Konzepte oder Ereignisse es gibt.
 *
 * ## Erststart
 *
 * Bei voellig leerem Lernstand kommt eine vollstaendige Antwort, keine
 * Fehlermeldung und keine Luecken: alle Kapitel mit `untouched`, alle zwoelf
 * Rating-Achsen auf 0, Level `einsteiger`, `empty: true`. Das ist der Zustand,
 * in dem die Seite zum ersten Mal geoeffnet wird - und der haeufigste Grund
 * fuer einen Absturz beim ersten Start.
 */
export async function readDashboard(
  db: Database,
  asOf: Date = new Date(),
): Promise<LearningDashboard> {
  // Eine gruppierte Abfrage je Kapitel - keine Schleife ueber Konzepte.
  const chapterRows = await db
    .select({
      chapterNumber: bookChapter.chapterNumber,
      title: bookChapter.title,
      concepts: sql<number>`count(${concept.id})::int`,
      mastered: sql<number>`count(*) filter (
        where ${conceptMastery.score} >= ${MASTERED_SCORE}
          and ${conceptMastery.confidence} >= ${MASTERED_CONFIDENCE})::int`,
      withEvidence: sql<number>`count(${conceptMastery.conceptId})::int`,
      averageScore: sql<number | null>`avg(${conceptMastery.score})`,
    })
    .from(bookChapter)
    .leftJoin(concept, eq(concept.chapterId, bookChapter.id))
    .leftJoin(conceptMastery, eq(conceptMastery.conceptId, concept.id))
    .groupBy(bookChapter.chapterNumber, bookChapter.title)
    .orderBy(asc(bookChapter.chapterNumber));

  const chapters: ChapterProgress[] = chapterRows.map((row) => ({
    chapterNumber: row.chapterNumber,
    title: row.title,
    concepts: row.concepts,
    mastered: row.mastered,
    inProgress: row.withEvidence - row.mastered,
    untouched: row.concepts - row.withEvidence,
    averageScore: round(Number(row.averageScore ?? 0)),
  }));

  // Fuenf Zaehlstaende in **einer** Rundreise statt in fuenf. Jede einzelne
  // waere trivial, aber sie summieren sich - und das Dashboard laedt bei
  // jedem Start.
  const counts = await db.execute<{
    concepts: string;
    with_evidence: string;
    mastered: string;
    events: string;
    open_errors: string;
    current_chapter: string | null;
  }>(sql`
    select (select count(*) from concept)                          as concepts,
           (select count(*) from concept_mastery)                  as with_evidence,
           (select count(*) from concept_mastery
             where score >= ${MASTERED_SCORE}
               and confidence >= ${MASTERED_CONFIDENCE})           as mastered,
           (select count(*) from learning_event)                   as events,
           (select count(*) from error_log)                        as open_errors,
           (select current_chapter from learner_state limit 1)     as current_chapter`);
  const totals = counts.rows[0];

  const [level, ratings, due, upcoming, report] = await Promise.all([
    readLearnerLevel(db, asOf),
    readSkillRatings(db),
    // Die Vorschau bleibt bewusst kurz: Das Dashboard zeigt die dringendsten,
    // die volle Liste holt die Queue-Ansicht.
    dueReviews(db, { context: 'session', limit: 5, asOf }),
    upcomingReviews(db, { asOf, withinDays: 7, limit: 0 }),
    readLatestReport(db),
  ]);

  const events = Number(totals?.events ?? 0);

  return {
    asOf: asOf.toISOString(),
    empty: events === 0,
    level: level.level,
    levelSource: level.source,
    automaticLevel: level.automaticLevel,
    chapters,
    currentChapter: Number(totals?.current_chapter ?? 1),
    ratings,
    dueCount: due.dueTotal,
    duePreview: due.items,
    upcomingCount: upcoming.total,
    totals: {
      concepts: Number(totals?.concepts ?? 0),
      withEvidence: Number(totals?.with_evidence ?? 0),
      mastered: Number(totals?.mastered ?? 0),
      events,
      openErrors: Number(totals?.open_errors ?? 0),
    },
    report: report === null ? null : toDashboardReport(report),
  };
}

function toDashboardReport(report: Awaited<ReturnType<typeof readLatestReport>>): DashboardReport {
  const value = report as NonNullable<typeof report>;
  return {
    id: value.id,
    status: value.status,
    generatedAt: value.generatedAt,
    // Nur die Titel - der volle Text gehoert in die Fehleransicht, nicht auf
    // die Startseite.
    patterns: value.patterns.map((pattern) => ({
      titel: pattern.titel,
      tag: pattern.tag,
      vertrauen: pattern.vertrauen,
      anzahl: pattern.anzahl,
    })),
    note: value.note,
  };
}

/* -------------------------------------------------------------------------
 * 2. Konzeptdetail
 * ---------------------------------------------------------------------- */

/** Fehlt das Konzept, ist das kein Serverfehler, sondern eine leere Antwort. */
export async function readConceptDetail(
  db: Database,
  conceptId: string,
  asOf: Date = new Date(),
): Promise<ConceptLearningDetail | null> {
  const [row] = await db
    .select({
      id: concept.id,
      title: concept.title,
      summary: concept.summary,
      topicArea: concept.topicArea,
      state: concept.state,
      minLevel: concept.minLevel,
      chapterNumber: bookChapter.chapterNumber,
      chapterTitle: bookChapter.title,
    })
    .from(concept)
    .innerJoin(bookChapter, eq(bookChapter.id, concept.chapterId))
    .where(eq(concept.id, conceptId));

  if (!row) return null;

  const prerequisiteRows = await db
    .select({ id: concept.id, title: concept.title })
    .from(conceptPrerequisite)
    .innerJoin(concept, eq(concept.id, conceptPrerequisite.prerequisiteId))
    .where(eq(conceptPrerequisite.conceptId, conceptId))
    .orderBy(asc(concept.title));

  // Die Gegenrichtung: Was baut auf diesem Konzept auf? AP6 zeigt beides, weil
  // "was haengt daran?" die Frage ist, die ueber die Dringlichkeit entscheidet.
  const dependentRows = await db
    .select({ id: concept.id, title: concept.title })
    .from(conceptPrerequisite)
    .innerJoin(concept, eq(concept.id, conceptPrerequisite.conceptId))
    .where(eq(conceptPrerequisite.prerequisiteId, conceptId))
    .orderBy(asc(concept.title));

  const [masteryRow] = await db
    .select()
    .from(conceptMastery)
    .where(eq(conceptMastery.conceptId, conceptId));

  const [queueRow] = await db
    .select()
    .from(reviewQueue)
    .where(eq(reviewQueue.conceptId, conceptId));

  const chartRows = await db
    .select({
      chartId: rangeChart.id,
      assetId: bookAsset.id,
      caption: bookAsset.captionRaw,
    })
    .from(conceptChart)
    .innerJoin(rangeChart, eq(rangeChart.assetId, conceptChart.assetId))
    .innerJoin(bookAsset, eq(bookAsset.id, conceptChart.assetId))
    .where(and(eq(conceptChart.conceptId, conceptId), eq(rangeChart.state, 'approved')));

  const errorRows = await db
    .select({
      occurredAt: errorLog.occurredAt,
      severity: errorLog.severity,
      description: errorLog.description,
      contextKind: errorLog.contextKind,
      patternTag: errorLog.patternTag,
    })
    .from(errorLog)
    .where(eq(errorLog.conceptId, conceptId))
    .orderBy(desc(errorLog.occurredAt))
    .limit(10);

  const [advance, history, anchorsPossible] = await Promise.all([
    // **Unveraendert durchgereicht** - die Entscheidung samt
    // Begruendungsbausteinen kommt aus T4.3, nicht von hier.
    evaluateConceptAdvance(db, conceptId, asOf),
    readMasteryHistory(db, conceptId),
    objectiveAnchorsPossible(db, conceptId),
  ]);

  return {
    conceptId: row.id,
    title: row.title,
    summary: row.summary,
    chapterNumber: row.chapterNumber,
    chapterTitle: row.chapterTitle,
    topicArea: row.topicArea as ConceptTopicArea,
    topicAreaLabel: conceptTopicAreaLabel(row.topicArea),
    state: row.state,
    minLevel: row.minLevel as LearnerLevel,
    prerequisites: prerequisiteRows,
    dependents: dependentRows,
    mastery: masteryRow
      ? {
          score: masteryRow.score,
          confidence: masteryRow.confidence,
          lastCheckedAt: masteryRow.lastCheckedAt?.toISOString() ?? null,
          signalCounts: {
            objective: masteryRow.objectiveSignals,
            aiJudged: masteryRow.aiJudgedSignals,
            selfReported: masteryRow.selfReportedSignals,
          },
        }
      : null,
    advance,
    history,
    queue: queueRow
      ? {
          dueAt: queueRow.dueAt.toISOString(),
          overdueDays: overdueDays({ dueAt: queueRow.dueAt }, asOf),
          intervalDays: queueRow.intervalDays,
          easeFactor: queueRow.easeFactor,
          repetitions: queueRow.repetitions,
          lapses: queueRow.lapses,
          origin: queueRow.origin as NonNullable<ConceptLearningDetail['queue']>['origin'],
        }
      : null,
    charts: chartRows,
    objectiveAnchorsPossible: anchorsPossible,
    recentErrors: errorRows.map((entry) => ({
      occurredAt: entry.occurredAt.toISOString(),
      severity: entry.severity as ConceptLearningDetail['recentErrors'][number]['severity'],
      description: entry.description,
      contextKind:
        entry.contextKind as ConceptLearningDetail['recentErrors'][number]['contextKind'],
      patternTag: entry.patternTag,
    })),
  };
}

/**
 * Die Mastery-Historie eines Konzepts - **neu gerechnet, nicht gespeichert**.
 *
 * Anders als beim Rating gibt es keine Mastery-Snapshots. Statt eine zweite
 * Tabelle einzufuehren, wird der Verlauf hier aus dem Ereignisstrom
 * rekonstruiert - mit **derselben** reinen Funktion, die auch die Ableitung
 * benutzt (`computeMasteryState`). Es gibt damit keine zweite Formel, nur eine
 * zweite Auswertung derselben.
 *
 * Das ist bezahlbar, weil es um **ein** Konzept geht: ein paar Dutzend bis
 * wenige Hundert Ereignisse, und der Abruf passiert beim Oeffnen einer
 * Detailansicht, nicht bei jedem Seitenaufbau.
 *
 * Ein Punkt je Kalendertag mit Ereignissen - dieselbe Verdichtung wie beim
 * Rating-Verlauf (T4.5).
 */
export async function readMasteryHistory(
  db: Database,
  conceptId: string,
): Promise<readonly MasteryHistoryPoint[]> {
  const rows = await db
    .select()
    .from(learningEvent)
    .where(eq(learningEvent.conceptId, conceptId))
    .orderBy(asc(learningEvent.occurredAt), asc(learningEvent.id));

  const effective = applyCorrections(inEventOrder(rows as unknown as StoredLearningEvent[]));
  const signals: MasterySignal[] = [];
  const byDay = new Map<string, MasteryHistoryPoint>();

  for (const entry of effective) {
    if (entry.outcome === null) continue;
    signals.push({
      signalClass: entry.event.signalClass,
      outcome: entry.outcome,
      difficulty: readDifficulty(entry.event),
      occurredAt: entry.event.occurredAt,
    });

    const state = computeMasteryState(signals);
    if (state === null) continue;
    const day = startOfUtcDay(entry.event.occurredAt).toISOString().slice(0, 10);
    // Der Stand **am Ende** des Tages - spaetere Ereignisse ueberschreiben.
    byDay.set(day, { day, score: state.score, confidence: state.confidence });
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Schwierigkeit aus den Nutzdaten; fehlt sie, gilt mittlere Schwierigkeit. */
function readDifficulty(event: StoredLearningEvent): number {
  const value = event.payload['difficulty'];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0.5;
}

/* -------------------------------------------------------------------------
 * 3. Queue-Vorschau
 * ---------------------------------------------------------------------- */

export interface QueuePreviewQuery {
  readonly context?: ReviewContext;
  readonly limit?: number;
  readonly withinDays?: number;
  readonly asOf?: Date;
}

/**
 * Was jetzt faellig ist und was demnaechst kommt.
 *
 * Reicht `dueReviews` und `upcomingReviews` aus T4.4 durch - inklusive
 * `dueTotal`, damit AP5 und AP9 sehen, wie viele es **tatsaechlich** waren.
 * Der Bezugszeitpunkt ist ein Parameter; die HTTP-Grenze belegt ihn mit der
 * aktuellen Zeit vor.
 */
export async function readQueuePreview(
  db: Database,
  query: QueuePreviewQuery = {},
): Promise<QueuePreview> {
  const asOf = query.asOf ?? new Date();
  const context = query.context ?? 'session';

  const [due, upcoming] = await Promise.all([
    dueReviews(db, { context, limit: query.limit ?? 20, asOf }),
    upcomingReviews(db, { asOf, withinDays: query.withinDays ?? 14, limit: query.limit ?? 20 }),
  ]);

  return { asOf: asOf.toISOString(), context, due, upcoming };
}

/* -------------------------------------------------------------------------
 * 4. Ratings- und Level-Verlauf
 * ---------------------------------------------------------------------- */

export interface RatingsQuery {
  readonly days?: number;
  readonly asOf?: Date;
}

/** Ratings mit Verlauf plus Level-Verlauf - die Entwicklungsansicht in AP6. */
export async function readRatingsOverview(
  db: Database,
  query: RatingsQuery = {},
): Promise<RatingsOverview> {
  const asOf = query.asOf ?? new Date();
  const days = query.days ?? 90;
  const from = new Date(asOf.getTime() - days * DAY_MS);

  const current = await readSkillRatings(db);

  const history: SkillRatingHistory[] = [];
  for (const area of CONCEPT_TOPIC_AREAS) {
    const full = await readRatingHistory(db, area.id);
    const points = full.points.filter((point) => point.day >= from.toISOString().slice(0, 10));
    // Achsen ohne Verlauf im Zeitraum bleiben drin, aber leer: Eine fehlende
    // Achse waere in der Anzeige nicht von einer flachen zu unterscheiden.
    history.push({ topicArea: area.id, points });
  }

  const [level, levelHistory] = await Promise.all([
    readLearnerLevel(db, asOf),
    readLevelHistory(db, from, asOf),
  ]);

  return {
    asOf: asOf.toISOString(),
    days,
    current,
    history,
    level: level.level,
    levelHistory,
  };
}

/**
 * Wann und **warum** sich das Niveau geaendert hat.
 *
 * Auch dieser Verlauf ist neu gerechnet, nicht gespeichert: Es gibt keine
 * Level-Historie in der Datenbank, und eine einzufuehren haette den Replay
 * verkompliziert (er kalibriert einmal am Ende, nicht je Ereignis). Stattdessen
 * wird der Ereignisstrom Tag fuer Tag durchgerechnet - mit denselben reinen
 * Funktionen aus T4.3 und T4.5, die auch die Ableitung benutzt.
 *
 * Ausgegeben werden nur die Tage, an denen sich das Level **geaendert** hat,
 * samt der Kennzahlen, die den Wechsel getragen haben. Das ist die Antwort auf
 * "warum bin ich aufgestiegen?" - eine Liste unveraenderter Tage waere es
 * nicht.
 *
 * Gerechnet wird ueber die Tage **mit Ereignissen**, nicht ueber alle
 * Kalendertage: An einem Tag ohne Ereignis kann sich nichts geaendert haben.
 */
export async function readLevelHistory(
  db: Database,
  from: Date,
  to: Date,
): Promise<readonly LevelHistoryPoint[]> {
  const rows = await db
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
      topicArea: concept.topicArea,
    })
    .from(learningEvent)
    .leftJoin(concept, eq(concept.id, learningEvent.conceptId))
    .where(lte(learningEvent.occurredAt, to))
    .orderBy(asc(learningEvent.occurredAt), asc(learningEvent.id));

  if (rows.length === 0) return [];

  const byConcept = new Map<string, StoredLearningEvent[]>();
  const topicAreaOf = new Map<string, ConceptTopicArea>();
  for (const row of rows) {
    if (row.conceptId === null) continue;
    topicAreaOf.set(row.conceptId, row.topicArea as ConceptTopicArea);
    const list = byConcept.get(row.conceptId) ?? [];
    list.push(row as unknown as StoredLearningEvent);
    byConcept.set(row.conceptId, list);
  }

  const days = [...new Set(rows.map((row) => startOfUtcDay(row.occurredAt).getTime()))].sort(
    (a, b) => a - b,
  );

  const points: LevelHistoryPoint[] = [];
  let level: LearnerLevel = 'einsteiger';

  for (const day of days) {
    const until = day + DAY_MS - 1;
    const signals = levelSignalsAt(byConcept, topicAreaOf, until);

    // Eine manuelle Setzung wirkt ab ihrem Zeitpunkt - dieselbe Frist wie in
    // der laufenden Kalibrierung.
    const manual = latestManualAt(rows, until);
    const asOfDay = new Date(until);
    const calibration = calibrateLevel({ current: level, signals, manual, asOf: asOfDay });

    if (calibration.level !== level) {
      const isoDay = new Date(day).toISOString().slice(0, 10);
      if (day >= startOfUtcDay(from).getTime()) {
        points.push({
          day: isoDay,
          level: calibration.level,
          previousLevel: level,
          source: calibration.source,
          signals,
        });
      }
      level = calibration.level;
    }
  }

  return points;
}

/** Die Kennzahlen zu einem Stichtag - aus den Ereignissen bis dahin. */
function levelSignalsAt(
  byConcept: ReadonlyMap<string, readonly StoredLearningEvent[]>,
  topicAreaOf: ReadonlyMap<string, ConceptTopicArea>,
  until: number,
): LevelHistoryPoint['signals'] {
  let mastered = 0;
  let objective = 0;
  let total = 0;
  const ratingsByArea = new Map<ConceptTopicArea, number[]>();

  for (const [conceptId, events] of byConcept) {
    const upTo = events.filter((event) => event.occurredAt.getTime() <= until);
    if (upTo.length === 0) continue;

    const effective = applyCorrections(inEventOrder(upTo));
    const signals: MasterySignal[] = effective
      .filter((entry) => entry.outcome !== null)
      .map((entry) => ({
        signalClass: entry.event.signalClass,
        outcome: entry.outcome as number,
        difficulty: readDifficulty(entry.event),
        occurredAt: entry.event.occurredAt,
      }));

    const state = computeMasteryState(signals);
    if (state === null) continue;

    if (state.score >= MASTERED_SCORE && state.confidence >= MASTERED_CONFIDENCE) mastered += 1;
    objective += state.objectiveSignals;
    total += state.objectiveSignals + state.aiJudgedSignals + state.selfReportedSignals;

    const area = topicAreaOf.get(conceptId);
    if (area !== undefined) {
      // Das Rating einer Achse ist der EWMA ueber alle ihre Ereignisse; fuer
      // die Level-Kennzahl genuegt der Mittelwert der Konzept-Scores der
      // Achse - dieselbe Groessenordnung, ohne den Strom ein zweites Mal je
      // Achse zu falten.
      const list = ratingsByArea.get(area) ?? [];
      list.push(state.score);
      ratingsByArea.set(area, list);
    }
  }

  const areaAverages = [...ratingsByArea.values()].map(
    (scores) => scores.reduce((sum, value) => sum + value, 0) / scores.length,
  );

  return {
    averageRating:
      areaAverages.length === 0
        ? 0
        : round(areaAverages.reduce((sum, value) => sum + value, 0) / areaAverages.length),
    coveredTopicAreas: ratingsByArea.size,
    masteredConcepts: mastered,
    objectiveShare: total === 0 ? 0 : round(objective / total),
    totalSignals: total,
  };
}

/** Die juengste manuelle Level-Setzung bis zu einem Stichtag. */
function latestManualAt(
  rows: readonly { eventType: string; occurredAt: Date; payload: unknown }[],
  until: number,
): { level: LearnerLevel; setAt: Date } | undefined {
  const manual = rows
    .filter((row) => row.eventType === 'level_set' && row.occurredAt.getTime() <= until)
    .at(-1);
  if (!manual) return undefined;
  return {
    level: (manual.payload as { level: LearnerLevel }).level,
    setAt: manual.occurredAt,
  };
}

/* -------------------------------------------------------------------------
 * Kleinkram
 * ---------------------------------------------------------------------- */

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
