import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import {
  PATTERN_REPORT_JOB,
  PATTERN_REPORT_MINIMUM,
  PATTERN_REPORT_PERIOD_DAYS,
  conceptTopicAreaLabel,
} from '@gto/shared';
import type {
  ConceptTopicArea,
  ErrorAggregate,
  ErrorPattern,
  LearningErrorSeverity,
  LearningEventSource,
  PatternReportView,
  StoredPattern,
} from '@gto/shared';
import type { Database, Transaction } from '../db/client.js';
import {
  concept,
  conceptMastery,
  errorLog,
  errorPatternTag,
  jobQueue,
  learningEvent,
  patternReport,
} from '../db/schema.js';
import { enqueueJob } from '../jobs/queue.js';
import { aggregateDigest, aggregateErrors, patternTag } from './patterns.js';
import type { ErrorRow, SuccessRow } from './patterns.js';

/**
 * Muster-Report: Daten holen, Ergebnis speichern, Muster zurueckschreiben
 * (AP4.T4.6).
 *
 * Der KI-Aufruf selbst liegt im Job-Typ (`jobs/handlers/pattern-report.ts`) -
 * hier steht alles, was ohne Provider auskommt. Die Trennung ist Absicht: Der
 * groesste Teil dieses Tasks ist deterministisch und laesst sich ohne einen
 * einzigen Aufruf pruefen.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------
 * Daten holen
 * ---------------------------------------------------------------------- */

/** Der Zeitraum, ueber den ein Report laeuft. */
export interface ReportPeriod {
  readonly start: Date;
  readonly end: Date;
}

/** Zeitraum aus einem Bezugszeitpunkt und einer Tageszahl. */
export function reportPeriod(asOf: Date, days = PATTERN_REPORT_PERIOD_DAYS): ReportPeriod {
  return { start: new Date(asOf.getTime() - days * DAY_MS), end: asOf };
}

/**
 * Laedt die Fehlerlage eines Zeitraums und verdichtet sie.
 *
 * Die Erfolge kommen aus dem Ereignisstrom, nicht aus dem Fehlerprotokoll: Fuer
 * die Frage "sass es zwischendurch schon einmal?" braucht es genau die
 * Ereignisse, die **keinen** Fehlereintrag erzeugt haben.
 */
export async function collectErrorAggregate(
  db: Database | Transaction,
  period: ReportPeriod,
): Promise<ErrorAggregate> {
  const errorRows = await db
    .select({
      eventId: errorLog.eventId,
      conceptId: errorLog.conceptId,
      conceptTitle: concept.title,
      topicArea: concept.topicArea,
      occurredAt: errorLog.occurredAt,
      contextKind: errorLog.contextKind,
      severity: errorLog.severity,
    })
    .from(errorLog)
    .innerJoin(concept, eq(concept.id, errorLog.conceptId))
    .where(and(gte(errorLog.occurredAt, period.start), lte(errorLog.occurredAt, period.end)));

  const errors: ErrorRow[] = errorRows.map((row) => ({
    eventId: row.eventId,
    conceptId: row.conceptId,
    conceptTitle: row.conceptTitle,
    topicArea: row.topicArea as ConceptTopicArea,
    occurredAt: row.occurredAt,
    contextKind: row.contextKind as LearningEventSource,
    severity: row.severity as LearningErrorSeverity,
  }));

  // Gelungene Ereignisse der betroffenen Konzepte - alles ausserhalb des
  // Fehlerprotokolls. Bewusst ohne Zeitgrenze nach unten: Ein Erfolg vor dem
  // Zeitraum zaehlt genauso, wenn danach wieder ein Fehler kam.
  const conceptIds = [...new Set(errors.map((row) => row.conceptId))];
  const successes: SuccessRow[] =
    conceptIds.length === 0
      ? []
      : (
          await db
            .select({ conceptId: learningEvent.conceptId, occurredAt: learningEvent.occurredAt })
            .from(learningEvent)
            .leftJoin(errorLog, eq(errorLog.eventId, learningEvent.id))
            .where(
              and(
                inArray(learningEvent.conceptId, conceptIds),
                lte(learningEvent.occurredAt, period.end),
              ),
            )
        )
          .filter((row) => row.conceptId !== null)
          .map((row) => ({ conceptId: row.conceptId as string, occurredAt: row.occurredAt }));

  // Fehler-Ereignisse aus der Erfolgsliste entfernen: Der Left-Join liefert
  // beide, unterscheiden laesst sie nur die Ereignis-ID.
  const errorEventIds = new Set(errors.map((row) => row.eventId));
  const cleanSuccesses = successes.filter(
    (row, index, all) =>
      all.findIndex(
        (other) =>
          other.conceptId === row.conceptId &&
          other.occurredAt.getTime() === row.occurredAt.getTime(),
      ) === index,
  );

  return aggregateErrors({
    errors,
    successes: cleanSuccesses.filter((row) => !hasErrorAt(errors, row)),
    periodStart: period.start,
    periodEnd: period.end,
  });

  function hasErrorAt(rows: readonly ErrorRow[], success: SuccessRow): boolean {
    return rows.some(
      (row) =>
        row.conceptId === success.conceptId &&
        row.occurredAt.getTime() === success.occurredAt.getTime() &&
        errorEventIds.has(row.eventId),
    );
  }
}

/* -------------------------------------------------------------------------
 * Mindestdatenmenge
 * ---------------------------------------------------------------------- */

/** Warum ein Report nicht erzeugt wurde. */
export interface ReportSkip {
  readonly reason: 'insufficient_data' | 'unchanged';
  readonly note: string;
}

/**
 * Reicht die Datenlage fuer einen Report?
 *
 * Unterhalb der Marke wird **kein Aufruf abgesetzt**. Ein Muster aus drei
 * Datenpunkten waere Kaffeesatzleserei - und es verbrennt Kontingent, das sich
 * der Report ohnehin mit dem Chart-Massenlauf aus AP3 teilt.
 */
export function checkMinimum(aggregate: ErrorAggregate): ReportSkip | null {
  if (aggregate.totalErrors < PATTERN_REPORT_MINIMUM.errors) {
    return {
      reason: 'insufficient_data',
      note:
        `Zu wenige Fehler im Zeitraum: ${aggregate.totalErrors} von mindestens ` +
        `${PATTERN_REPORT_MINIMUM.errors}. Aus so wenigen Beobachtungen lässt sich kein ` +
        `Muster ableiten — es wurde deshalb keine Auswertung angefordert.`,
    };
  }
  if (aggregate.totalConcepts < PATTERN_REPORT_MINIMUM.concepts) {
    return {
      reason: 'insufficient_data',
      note:
        `Die Fehler verteilen sich auf nur ${aggregate.totalConcepts} Konzepte ` +
        `(mindestens ${PATTERN_REPORT_MINIMUM.concepts} nötig). Ein Muster über ein einzelnes ` +
        `Konzept ist kein Muster, sondern eine Wissenslücke — die steht schon in der ` +
        `Wiederholungs-Queue.`,
    };
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Speichern
 * ---------------------------------------------------------------------- */

export interface StoreReportInput {
  readonly period: ReportPeriod;
  readonly aggregate: ErrorAggregate;
  readonly generatedAt: Date;
  readonly patterns?: readonly ErrorPattern[];
  readonly note?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly durationMs?: number | undefined;
}

/**
 * Speichert einen Report und schreibt die Muster-Tags zurueck.
 *
 * Die Zuordnung laeuft ueber `error_pattern_tag`, nicht direkt in
 * `error_log.pattern_tag`: Das Fehlerprotokoll ist eine Projektion und wird bei
 * jedem neuen Ereignis des Konzepts neu aufgebaut - ein direkt
 * hineingeschriebener Tag waere beim naechsten Schreibvorgang weg. Die
 * Projektion holt ihn stattdessen von hier (ADR-0046).
 */
export async function storeReport(
  db: Database,
  input: StoreReportInput,
): Promise<PatternReportView> {
  const digest = aggregateDigest(input.aggregate);
  const patterns = input.patterns ?? [];

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(patternReport)
      .values({
        status: patterns.length > 0 ? 'complete' : 'insufficient_data',
        generatedAt: input.generatedAt,
        periodStart: input.period.start,
        periodEnd: input.period.end,
        model: input.model ?? null,
        provider: input.provider ?? null,
        errorCount: input.aggregate.totalErrors,
        conceptCount: input.aggregate.totalConcepts,
        patterns: [],
        aggregate: input.aggregate as unknown as Record<string, unknown>,
        note: input.note ?? null,
        inputDigest: digest,
        durationMs: input.durationMs ?? null,
      })
      .returning({ id: patternReport.id });

    const reportId = (row as { id: string }).id;
    const stored = await tagErrors(tx, reportId, patterns, input.period);

    await tx
      .update(patternReport)
      .set({ patterns: stored as unknown as Record<string, unknown>[] })
      .where(eq(patternReport.id, reportId));

    return readReportRow({
      id: reportId,
      status: patterns.length > 0 ? 'complete' : 'insufficient_data',
      generatedAt: input.generatedAt,
      periodStart: input.period.start,
      periodEnd: input.period.end,
      model: input.model ?? null,
      provider: input.provider ?? null,
      errorCount: input.aggregate.totalErrors,
      conceptCount: input.aggregate.totalConcepts,
      patterns: stored,
      note: input.note ?? null,
      durationMs: input.durationMs ?? null,
    });
  });
}

/**
 * Ordnet die erkannten Muster den Fehlereintraegen zu.
 *
 * Ein Muster nennt Konzepte **mit Titel**, weil die Auswertung keine IDs sieht.
 * Die Aufloesung auf Ereignisse ist deterministischer Code: Alle Fehler der
 * genannten Konzepte im Zeitraum bekommen den Tag. Trifft ein Titel auf kein
 * Konzept, wird er stillschweigend uebergangen - erfundene Namen duerfen keine
 * Wirkung haben.
 */
async function tagErrors(
  tx: Transaction,
  reportId: string,
  patterns: readonly ErrorPattern[],
  period: ReportPeriod,
): Promise<StoredPattern[]> {
  const rows = await tx
    .select({ eventId: errorLog.eventId, title: concept.title })
    .from(errorLog)
    .innerJoin(concept, eq(concept.id, errorLog.conceptId))
    .where(and(gte(errorLog.occurredAt, period.start), lte(errorLog.occurredAt, period.end)));

  const byTitle = new Map<string, string[]>();
  for (const row of rows) {
    const list = byTitle.get(row.title) ?? [];
    list.push(row.eventId);
    byTitle.set(row.title, list);
  }

  const stored = new Map<number, StoredPattern>();
  const claimed = new Set<string>();

  // Reihenfolge der Zuteilung: **das spezifischste Muster zuerst**, also das
  // mit den wenigsten genannten Konzepten.
  //
  // Ein Ereignis gehoert zu hoechstens einem Muster - sonst muesste die Anzeige
  // entscheiden, welches "gilt". Wer zuerst kommt, mahlt also; und wer zuerst
  // kommt, sollte der aussagekraeftigere sein. Ein Muster ueber zwei Konzepte
  // ("wiederkehrende Fehler bei X und Y") ist als Etikett brauchbarer als eines
  // ueber alle drei ("durchgaengig hoher Schweregrad"). Ohne diese Sortierung
  // entschiede die Reihenfolge, in der das Modell die Muster aufgezaehlt hat.
  const order = patterns
    .map((pattern, index) => ({ pattern, index }))
    .sort((a, b) => a.pattern.konzepte.length - b.pattern.konzepte.length || a.index - b.index);

  for (const { pattern, index } of order) {
    const tag = patternTag(pattern.titel);
    const eventIds = pattern.konzepte
      .flatMap((title) => byTitle.get(title) ?? [])
      // Ein Ereignis gehoert zu hoechstens einem Muster - das erste gewinnt.
      // Sonst muesste die Anzeige entscheiden, welches Muster "gilt".
      .filter((eventId) => !claimed.has(eventId));

    for (const eventId of eventIds) claimed.add(eventId);

    if (eventIds.length > 0) {
      await tx
        .insert(errorPatternTag)
        .values(eventIds.map((eventId) => ({ eventId, reportId, tag })))
        .onConflictDoUpdate({
          target: errorPatternTag.eventId,
          set: { reportId, tag },
        });
    }

    stored.set(index, { ...pattern, tag, taggedErrors: eventIds.length });
  }

  // Die Projektion holt die Tags von hier - fuer die betroffenen Konzepte
  // einmal nachziehen, damit `error_log.pattern_tag` sofort stimmt.
  await refreshPatternTags(tx);

  // Gespeichert wird in der Reihenfolge, in der das Modell die Muster
  // aufgezaehlt hat - es hat sie nach Tragweite sortiert, nicht nach Breite.
  return patterns.map((_, index) => stored.get(index) as StoredPattern);
}

/**
 * Schreibt die Tags aus `error_pattern_tag` in das Fehlerprotokoll.
 *
 * Wird nach jedem Report aufgerufen und - fuer ein einzelnes Konzept - bei
 * jeder Projektion. `error_log.pattern_tag` ist damit immer eine Spiegelung,
 * nie eine eigene Wahrheit.
 */
export async function refreshPatternTags(tx: Transaction, conceptId?: string): Promise<void> {
  const tags = await tx
    .select({ eventId: errorPatternTag.eventId, tag: errorPatternTag.tag })
    .from(errorPatternTag);

  for (const entry of tags) {
    await tx
      .update(errorLog)
      .set({ patternTag: entry.tag })
      .where(
        conceptId === undefined
          ? eq(errorLog.id, entry.eventId)
          : and(eq(errorLog.id, entry.eventId), eq(errorLog.conceptId, conceptId)),
      );
  }
}

/* -------------------------------------------------------------------------
 * Woechentliche Wiedervorlage
 * ---------------------------------------------------------------------- */

/** Abstand zweier turnusmaessiger Reports. */
export const REPORT_INTERVAL_DAYS = 7;

/**
 * Legt den naechsten turnusmaessigen Report in die Queue - **ohne eigenen
 * Scheduler**.
 *
 * Der Mechanismus ist bewusst schlicht: Jeder Lauf plant seinen Nachfolger mit
 * `availableAt = jetzt + 7 Tage` ein. Die Job-Queue aus AP2 kann verzoegern,
 * wiederholen und protokollieren - ein zusaetzlicher Dienst dafuer waere ein
 * zweites Stueck Infrastruktur fuer eine Aufgabe, die einmal pro Woche
 * anfaellt.
 *
 * Doppelte Ketten sind ausgeschlossen: Steht schon ein Report in der Queue,
 * passiert nichts. Sonst legte jeder manuelle Anstoss eine weitere Kette an.
 *
 * Faellt der Worker laenger aus, laeuft der Report spaeter - nicht mehrfach.
 * Das ist die richtige Richtung: Ein nachgeholter Wochenreport ist nuetzlich,
 * fuenf nachgeholte sind Kontingentverschwendung.
 */
export async function ensureWeeklyReport(db: Database, asOf: Date): Promise<boolean> {
  const [pending] = await db
    .select({ id: jobQueue.id })
    .from(jobQueue)
    .where(
      and(
        eq(jobQueue.jobType, PATTERN_REPORT_JOB),
        inArray(jobQueue.status, ['queued', 'running']),
      ),
    )
    .limit(1);
  if (pending) return false;

  await enqueueJob(db, {
    jobType: PATTERN_REPORT_JOB,
    payload: { periodDays: PATTERN_REPORT_PERIOD_DAYS, force: false },
    availableAt: new Date(asOf.getTime() + REPORT_INTERVAL_DAYS * DAY_MS),
  });
  return true;
}

/* -------------------------------------------------------------------------
 * Lesen
 * ---------------------------------------------------------------------- */

interface ReportRow {
  id: string;
  status: string;
  generatedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  model: string | null;
  provider: string | null;
  errorCount: number;
  conceptCount: number;
  patterns: unknown;
  note: string | null;
  durationMs: number | null;
}

function readReportRow(row: ReportRow): PatternReportView {
  return {
    id: row.id,
    status: row.status as PatternReportView['status'],
    generatedAt: row.generatedAt.toISOString(),
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    model: row.model,
    provider: row.provider,
    errorCount: row.errorCount,
    conceptCount: row.conceptCount,
    patterns: (row.patterns as StoredPattern[] | null) ?? [],
    note: row.note,
    durationMs: row.durationMs,
  };
}

const REPORT_COLUMNS = {
  id: patternReport.id,
  status: patternReport.status,
  generatedAt: patternReport.generatedAt,
  periodStart: patternReport.periodStart,
  periodEnd: patternReport.periodEnd,
  model: patternReport.model,
  provider: patternReport.provider,
  errorCount: patternReport.errorCount,
  conceptCount: patternReport.conceptCount,
  patterns: patternReport.patterns,
  note: patternReport.note,
  durationMs: patternReport.durationMs,
};

/** Der juengste Report - die Frage, die das Dashboard in T4.7 stellt. */
export async function readLatestReport(db: Database): Promise<PatternReportView | null> {
  const [row] = await db
    .select(REPORT_COLUMNS)
    .from(patternReport)
    .orderBy(desc(patternReport.generatedAt))
    .limit(1);
  return row ? readReportRow(row as ReportRow) : null;
}

/** Die Historie - damit sich die Entwicklung nachvollziehen laesst. */
export async function readReportHistory(
  db: Database,
  limit = 20,
): Promise<readonly PatternReportView[]> {
  const rows = await db
    .select(REPORT_COLUMNS)
    .from(patternReport)
    .orderBy(desc(patternReport.generatedAt))
    .limit(limit);
  return rows.map((row) => readReportRow(row as ReportRow));
}

/** Die Pruefsumme des juengsten Reports - Grundlage der Wiederholungsvermeidung. */
export async function lastReportDigest(db: Database | Transaction): Promise<string | null> {
  const [row] = await db
    .select({ digest: patternReport.inputDigest })
    .from(patternReport)
    .orderBy(desc(patternReport.generatedAt))
    .limit(1);
  return row?.digest ?? null;
}

/**
 * Gegenprobe fuer den Bericht: Zaehlstaende des Lernstands.
 *
 * Der Report **veraendert keinen Lernstand** - Mastery, Queue und Ratings
 * bleiben deterministisch berechnet (T4.3 bis T4.5). Diese Funktion belegt das,
 * statt es nur zu behaupten.
 */
export async function learningStateFingerprint(db: Database): Promise<Record<string, unknown>> {
  const mastery = await db
    .select({ conceptId: conceptMastery.conceptId, score: conceptMastery.score })
    .from(conceptMastery)
    .orderBy(conceptMastery.conceptId);
  return {
    mastery: mastery.map((row) => [row.conceptId, row.score]),
  };
}

/** Beschriftung eines Themenbereichs - fuer die Anzeige in AP6. */
export { conceptTopicAreaLabel };
