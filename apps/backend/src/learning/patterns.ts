import { createHash } from 'node:crypto';
import { conceptTopicAreaLabel } from '@gto/shared';
import type {
  ConceptErrorStat,
  ConceptTopicArea,
  ErrorAggregate,
  ErrorTrend,
  ErrorTrendPoint,
  LearningErrorSeverity,
  LearningEventSource,
} from '@gto/shared';

/**
 * Aggregation der Fehlerlage (AP4.T4.6) - **reine Funktionen**.
 *
 * Das hier ist der deterministische Kern vor dem einzigen KI-Aufruf in AP4.
 * Die Auswertung bekommt **ausschliesslich** das Ergebnis dieser Funktionen zu
 * sehen - nie ein Rohprotokoll, nie einen Antworttext.
 *
 * Zwei Gruende dafuer, und beide zaehlen:
 *
 * 1. **Kontextdisziplin.** Ein Jahr Fehlerprotokoll waeren Tausende Zeilen. Die
 *    Aggregation macht daraus wenige Kilobyte.
 * 2. **Sie zwingt zur Musterrede.** Wer nur Zaehlstaende sieht, kann keine
 *    Einzelfaelle nacherzaehlen. Genau das ist der Zweck des Reports: nicht
 *    "am Dienstag lief das schief", sondern "du verteidigst systematisch zu
 *    weit aus dem Small Blind".
 *
 * Die Determinismus-Regel aus T4.2 gilt: kein `Date.now()`, kein Zufall. Der
 * Zeitraum kommt als Argument herein.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------
 * Eingabe
 * ---------------------------------------------------------------------- */

/** Ein Fehlereintrag, wie ihn die Aggregation sieht. */
export interface ErrorRow {
  readonly eventId: string;
  readonly conceptId: string;
  readonly conceptTitle: string;
  readonly topicArea: ConceptTopicArea;
  readonly occurredAt: Date;
  readonly contextKind: LearningEventSource;
  readonly severity: LearningErrorSeverity;
}

/**
 * Ein gelungenes Ereignis - gebraucht fuer die Frage, ob ein Konzept
 * zwischenzeitlich einmal sass.
 */
export interface SuccessRow {
  readonly conceptId: string;
  readonly occurredAt: Date;
}

export interface AggregateInput {
  readonly errors: readonly ErrorRow[];
  readonly successes: readonly SuccessRow[];
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

/* -------------------------------------------------------------------------
 * Aggregation
 * ---------------------------------------------------------------------- */

/**
 * Verdichtet die Fehlerlage eines Zeitraums zu Kennzahlen.
 *
 * Alle Listen sind **stabil sortiert** - erst nach Haeufigkeit, dann nach
 * Kennung. Ohne den zweiten Schluessel haengt die Reihenfolge bei Gleichstand
 * an der Zeilenfolge der Datenbank, und dieselbe Datenlage ergaebe zwei
 * verschiedene Pruefsummen.
 */
export function aggregateErrors(input: AggregateInput): ErrorAggregate {
  const { errors, successes, periodStart, periodEnd } = input;

  const byConcept = aggregateByConcept(errors, successes);
  const byTopicArea = aggregateByTopicArea(byConcept);
  const byContext = aggregateByContext(errors);
  const trend = aggregateTrend(errors, periodStart, periodEnd);

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    totalErrors: errors.length,
    totalConcepts: byConcept.length,
    bySeverity: {
      high: errors.filter((row) => row.severity === 'high').length,
      medium: errors.filter((row) => row.severity === 'medium').length,
      low: errors.filter((row) => row.severity === 'low').length,
    },
    byConcept,
    byTopicArea,
    byContext,
    trend,
    trendDirection: trendDirection(trend),
    // Bewusst noch einmal getrennt herausgestellt: Das ist das Signal, auf das
    // die Auswertung als Erstes schauen soll.
    repeatedAfterReview: byConcept
      .filter((stat) => stat.repeatedAfterReview > 0)
      .sort(
        (a, b) =>
          b.repeatedAfterReview - a.repeatedAfterReview || a.conceptId.localeCompare(b.conceptId),
      ),
  };
}

function aggregateByConcept(
  errors: readonly ErrorRow[],
  successes: readonly SuccessRow[],
): readonly ConceptErrorStat[] {
  const byConcept = new Map<string, ErrorRow[]>();
  for (const row of errors) {
    const list = byConcept.get(row.conceptId) ?? [];
    list.push(row);
    byConcept.set(row.conceptId, list);
  }

  const successesByConcept = new Map<string, Date[]>();
  for (const row of successes) {
    const list = successesByConcept.get(row.conceptId) ?? [];
    list.push(row.occurredAt);
    successesByConcept.set(row.conceptId, list);
  }

  const stats: ConceptErrorStat[] = [];
  for (const [conceptId, rows] of byConcept) {
    const ordered = [...rows].sort(
      (a, b) =>
        a.occurredAt.getTime() - b.occurredAt.getTime() || a.eventId.localeCompare(b.eventId),
    );
    const first = ordered[0] as ErrorRow;
    const last = ordered[ordered.length - 1] as ErrorRow;

    stats.push({
      conceptId,
      title: first.conceptTitle,
      topicArea: first.topicArea,
      errors: ordered.length,
      high: ordered.filter((row) => row.severity === 'high').length,
      medium: ordered.filter((row) => row.severity === 'medium').length,
      low: ordered.filter((row) => row.severity === 'low').length,
      firstAt: first.occurredAt.toISOString(),
      lastAt: last.occurredAt.toISOString(),
      repeatedAfterReview: countRepeatedAfterReview(
        ordered,
        successesByConcept.get(conceptId) ?? [],
      ),
    });
  }

  return stats.sort((a, b) => b.errors - a.errors || a.conceptId.localeCompare(b.conceptId));
}

/**
 * Zaehlt Fehler, die **nach** einer zwischenzeitlich gelungenen Wiederholung
 * auftraten - und diese wiederum nach einem frueheren Fehler.
 *
 * Das Muster `Fehler → Erfolg → Fehler` ist etwas anderes als drei Fehler
 * hintereinander. Drei Fehler am Stueck heissen "noch nicht gelernt". Ein
 * Fehler nach einem Erfolg heisst: **Es sass schon einmal und ist wieder
 * gekippt** - ein festsitzender Denkfehler, keine Wissensluecke. Das ist die
 * Unterscheidung, die einen Report nuetzlich macht.
 */
export function countRepeatedAfterReview(
  errors: readonly ErrorRow[],
  successes: readonly Date[],
): number {
  if (errors.length === 0 || successes.length === 0) return 0;

  const ordered = [...successes].sort((a, b) => a.getTime() - b.getTime());
  const firstError = (errors[0] as ErrorRow).occurredAt.getTime();

  let count = 0;
  for (const error of errors) {
    const at = error.occurredAt.getTime();
    // Gab es zwischen dem ersten Fehler und diesem hier einen Erfolg?
    const hasSuccessBetween = ordered.some(
      (success) => success.getTime() > firstError && success.getTime() < at,
    );
    if (hasSuccessBetween) count += 1;
  }
  return count;
}

function aggregateByTopicArea(
  byConcept: readonly ConceptErrorStat[],
): readonly { topicArea: ConceptTopicArea; label: string; errors: number; concepts: number }[] {
  const byArea = new Map<ConceptTopicArea, { errors: number; concepts: number }>();
  for (const stat of byConcept) {
    const entry = byArea.get(stat.topicArea) ?? { errors: 0, concepts: 0 };
    entry.errors += stat.errors;
    entry.concepts += 1;
    byArea.set(stat.topicArea, entry);
  }

  return [...byArea.entries()]
    .map(([topicArea, entry]) => ({
      topicArea,
      label: conceptTopicAreaLabel(topicArea),
      errors: entry.errors,
      concepts: entry.concepts,
    }))
    .sort((a, b) => b.errors - a.errors || a.topicArea.localeCompare(b.topicArea));
}

function aggregateByContext(
  errors: readonly ErrorRow[],
): readonly { contextKind: LearningEventSource; errors: number }[] {
  const byContext = new Map<LearningEventSource, number>();
  for (const row of errors) {
    byContext.set(row.contextKind, (byContext.get(row.contextKind) ?? 0) + 1);
  }

  return [...byContext.entries()]
    .map(([contextKind, count]) => ({ contextKind, errors: count }))
    .sort((a, b) => b.errors - a.errors || a.contextKind.localeCompare(b.contextKind));
}

/** Montag der Woche, in der ein Zeitpunkt liegt - UTC. */
export function startOfUtcWeek(moment: Date): Date {
  const day = new Date(
    Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate()),
  );
  // `getUTCDay()` liefert 0 fuer Sonntag; wir wollen Montag als Wochenanfang.
  const shift = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - shift * DAY_MS);
}

/**
 * Fehler je Woche - **inklusive der Wochen ohne Fehler**, aber erst ab der
 * ersten Woche mit Fehlern.
 *
 * Luecken **innerhalb** der Reihe bleiben stehen: Sie sind eine Auskunft ("in
 * dieser Woche lief nichts schief" oder "in dieser Woche wurde nicht geuebt").
 * Sie zu ueberspringen liesse die Kurve besser aussehen, als sie ist.
 *
 * Leere Wochen **vor** dem ersten Fehler fallen dagegen weg. Sie bedeuten
 * nicht "damals lief es besser", sondern "damals war noch nichts". Sie
 * mitzuzaehlen verschiebt den Vergleich der ersten gegen die zweite Haelfte
 * systematisch nach "verschlechtert" - ein Fehler, den der Live-Lauf in T4.6
 * aufgedeckt hat: Die Reihe 0-3-2-3-1 wurde als `worsening` gemeldet, obwohl
 * die letzte Woche die beste war.
 */
function aggregateTrend(
  errors: readonly ErrorRow[],
  periodStart: Date,
  periodEnd: Date,
): readonly ErrorTrendPoint[] {
  const counts = new Map<number, number>();
  for (const row of errors) {
    const week = startOfUtcWeek(row.occurredAt).getTime();
    counts.set(week, (counts.get(week) ?? 0) + 1);
  }

  const firstErrorWeek = counts.size === 0 ? undefined : Math.min(...counts.keys());
  const from =
    firstErrorWeek === undefined
      ? startOfUtcWeek(periodStart)
      : new Date(Math.max(startOfUtcWeek(periodStart).getTime(), firstErrorWeek));

  const points: ErrorTrendPoint[] = [];
  for (
    let week = from;
    week.getTime() <= periodEnd.getTime();
    week = new Date(week.getTime() + 7 * DAY_MS)
  ) {
    points.push({
      weekStart: week.toISOString().slice(0, 10),
      errors: counts.get(week.getTime()) ?? 0,
    });
  }
  return points;
}

/**
 * Wohin die Entwicklung zeigt: erste gegen zweite Haelfte des Zeitraums.
 *
 * Bewusst grob. Eine Regression ueber vier Wochenpunkte waere
 * Scheingenauigkeit; die Auswertung soll die Richtung sehen, nicht eine
 * Steigung interpretieren. Unter zwei Wochen gibt es keine Richtung.
 */
export function trendDirection(points: readonly ErrorTrendPoint[]): ErrorTrend {
  if (points.length < 2) return 'unknown';

  const half = Math.floor(points.length / 2);
  const early = points.slice(0, half);
  const late = points.slice(points.length - half);

  const earlyAvg = early.reduce((sum, point) => sum + point.errors, 0) / early.length;
  const lateAvg = late.reduce((sum, point) => sum + point.errors, 0) / late.length;

  // Zehn Prozent Unterschied, mindestens aber ein halber Fehler je Woche -
  // sonst zeigt jede Zufallsschwankung eine "Entwicklung" an.
  const delta = lateAvg - earlyAvg;
  const threshold = Math.max(0.5, earlyAvg * 0.1);
  if (delta <= -threshold) return 'improving';
  if (delta >= threshold) return 'worsening';
  return 'stable';
}

/* -------------------------------------------------------------------------
 * Pruefsumme und Kurzkennung
 * ---------------------------------------------------------------------- */

/**
 * Pruefsumme ueber die Eingabe der Auswertung.
 *
 * Damit erkennt der Job, dass sich seit dem letzten Report nichts geaendert
 * hat - und setzt keinen zweiten Aufruf ab, der dasselbe Ergebnis kostet. Der
 * Zeitraum geht **nicht** ein: Ein Report am Folgetag mit unveraenderter
 * Fehlerlage soll als "nichts Neues" erkannt werden, obwohl sich das
 * Zeitfenster verschoben hat.
 */
export function aggregateDigest(aggregate: ErrorAggregate): string {
  const relevant = {
    totalErrors: aggregate.totalErrors,
    bySeverity: aggregate.bySeverity,
    byConcept: aggregate.byConcept.map((stat) => [
      stat.conceptId,
      stat.errors,
      stat.repeatedAfterReview,
      stat.lastAt,
    ]),
    byContext: aggregate.byContext.map((entry) => [entry.contextKind, entry.errors]),
  };
  return createHash('sha256').update(JSON.stringify(relevant), 'utf8').digest('hex');
}

/**
 * Kurzkennung eines Musters aus seinem Titel.
 *
 * Sie landet im Fehlerprotokoll, damit AP6 danach filtern kann. Bewusst aus dem
 * Titel abgeleitet und nicht durchnummeriert: `sb-verteidigung-zu-weit` ist in
 * einer Datenbankabfrage lesbar, `muster-3` nicht.
 */
export function patternTag(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug === '' ? 'muster' : slug;
}

/* -------------------------------------------------------------------------
 * Darstellung fuer den Prompt
 * ---------------------------------------------------------------------- */

/**
 * Die Kennzahlen als Prompt-Block.
 *
 * Tabellenform statt JSON: Sie ist kuerzer und fuer ein Sprachmodell genauso
 * eindeutig. Was hier nicht steht, sieht die Auswertung nicht - insbesondere
 * **keine** Beschreibungstexte aus dem Fehlerprotokoll und **keine**
 * Antworttexte des Lernenden.
 */
export function renderAggregate(aggregate: ErrorAggregate): string {
  const lines: string[] = [];

  lines.push(
    `Zeitraum: ${aggregate.periodStart.slice(0, 10)} bis ${aggregate.periodEnd.slice(0, 10)}`,
    `Fehler gesamt: ${aggregate.totalErrors} über ${aggregate.totalConcepts} Konzepte`,
    `Schweregrad: ${aggregate.bySeverity.high} schwer, ${aggregate.bySeverity.medium} mittel, ${aggregate.bySeverity.low} leicht`,
    '',
    'Fehler je Konzept (Konzept | Themenbereich | Fehler | davon schwer | Wiederholungsfehler | letzter Fehler):',
  );
  for (const stat of aggregate.byConcept) {
    lines.push(
      `- ${stat.title} | ${conceptTopicAreaLabel(stat.topicArea)} | ${stat.errors} | ${stat.high} | ` +
        `${stat.repeatedAfterReview} | ${stat.lastAt.slice(0, 10)}`,
    );
  }

  lines.push('', 'Fehler je Themenbereich (Bereich | Fehler | betroffene Konzepte):');
  for (const area of aggregate.byTopicArea) {
    lines.push(`- ${area.label} | ${area.errors} | ${area.concepts}`);
  }

  lines.push('', 'Fehler je Kontext (Kontext | Fehler):');
  for (const context of aggregate.byContext) {
    lines.push(`- ${context.contextKind} | ${context.errors}`);
  }

  lines.push('', `Fehler je Woche (Entwicklung: ${aggregate.trendDirection}):`);
  for (const point of aggregate.trend) {
    lines.push(`- ${point.weekStart} | ${point.errors}`);
  }

  lines.push(
    '',
    'Wiederholte Fehler trotz zwischenzeitlich gelungener Wiederholung:',
    aggregate.repeatedAfterReview.length === 0
      ? '- (keine)'
      : aggregate.repeatedAfterReview
          .map((stat) => `- ${stat.title} | ${stat.repeatedAfterReview} von ${stat.errors} Fehlern`)
          .join('\n'),
  );

  return lines.join('\n');
}
