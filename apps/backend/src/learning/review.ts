import type { LearningEventSource, LearningSignalClass, ReviewQueueOrigin } from '@gto/shared';
import { SCORE_WEIGHTS, FAILURE_THRESHOLD } from './mastery.js';

/**
 * Wiederholungssteuerung: Intervalle, Ease und Priorisierung (AP4.T4.4).
 *
 * Ausschliesslich **reine Funktionen** - die Determinismus-Regel aus T4.2 gilt
 * unveraendert. Faelligkeiten werden aus dem Zeitstempel des Ereignisses
 * gerechnet, nie aus der Systemzeit. Der Bezugszeitpunkt fuer "was ist jetzt
 * faellig?" kommt als ausdruecklicher `asOf`-Parameter herein: Das ist eine
 * Frage der Abfrage, nicht der Ableitung.
 *
 * Wie `mastery.ts` ist dieses Modul **oeffentlich** - AP5, AP7 und AP9 rufen
 * die Priorisierung auf. Es schreibt nichts und kann deshalb nichts umgehen.
 */

/* -------------------------------------------------------------------------
 * Konstanten - begruendet in ADR-0043
 * ---------------------------------------------------------------------- */

/**
 * Grenzen des Ease-Faktors.
 *
 * 1,3 ist SM-2s eigene Untergrenze: Darunter waechst das Intervall praktisch
 * nicht mehr, das Konzept kaeme in immer kuerzeren Abstaenden und verstopfte
 * die Queue. 3,0 deckelt nach oben, damit ein Rechenfehler oder eine lange
 * Erfolgsserie keine Intervalle von Jahren erzeugt.
 *
 * Dieselben Werte stehen als CHECK-Constraint `review_queue_ease_check` in der
 * Datenbank (T4.1) - die Grenze ist nicht nur eine Zusage im Code.
 */
export const EASE_MIN = 1.3;
export const EASE_MAX = 3.0;
export const EASE_START = 2.5;

/** Erstes und zweites Intervall der Lernphase, in Tagen (SM-2-Original). */
export const FIRST_INTERVAL_DAYS = 1;
export const SECOND_INTERVAL_DAYS = 6;

/**
 * Obergrenze eines Intervalls in Tagen.
 *
 * Ein Jahr. Jenseits davon ist "wiederholen" in einem Trainingswerkzeug keine
 * sinnvolle Aussage mehr - und die Konfidenz aus T4.3 ist bis dahin ohnehin
 * fast auf null abgeklungen.
 */
export const MAX_INTERVAL_DAYS = 365;

/**
 * Wie schnell ein **echter Rueckfall** wiedervorgelegt wird.
 *
 * Eine Stunde, nicht ein Tag: Wer ein sicher geglaubtes Konzept falsch
 * beantwortet, soll es in derselben Sitzung noch einmal sehen. Wartet man
 * Tage, verfestigt sich der Fehler - genau das, was Spaced Repetition
 * verhindern soll.
 */
export const LAPSE_DELAY_MINUTES = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/* -------------------------------------------------------------------------
 * Uebersetzung der Bewertung in den Ease-Faktor
 * ---------------------------------------------------------------------- */

/**
 * Die Ease-Aenderung fuer ein Ergebnis von 0 bis 1.
 *
 * Das ist **SM-2s eigene Formel**, nur umparametrisiert. Im Original:
 *
 * ```
 *   EF' = EF + (0,1 − (5−q)·(0,08 + (5−q)·0,02))     mit q ∈ [0, 5]
 * ```
 *
 * Hier gibt es kein `q` von 0 bis 5 - es gibt ein Ergebnis von 0 bis 1. Mit
 * `x = 1 − outcome` (also `5x = 5 − q`) wird daraus:
 *
 * ```
 *   Δ = 0,1 − 0,4·x − 0,5·x²
 * ```
 *
 * Das ist **keine willkuerliche Umrechnung**, sondern dieselbe Parabel auf
 * einer anderen Achse. Die Stuetzstellen stimmen exakt mit SM-2 ueberein:
 * outcome 1,0 (q=5) → +0,10; 0,8 (q=4) → 0,00; 0,6 (q=3) → −0,14;
 * 0,0 (q=0) → −0,80.
 *
 * Der Vorteil gegenueber einer eigenen Kurve: Das Verhalten ist seit
 * Jahrzehnten erprobt, und niemand muss die Zahlen verteidigen, die dahinter
 * stehen - nur die Achsentransformation, und die ist nachrechenbar.
 */
export function easeDelta(outcome: number): number {
  const x = 1 - clampRatio(outcome);
  return 0.1 - 0.4 * x - 0.5 * x * x;
}

/**
 * Wie stark eine Signalklasse auf die Wiederholungssteuerung durchschlaegt.
 *
 * Bewusst **dieselben Gewichte wie beim Mastery-Score** (T4.3): Was dort als
 * schwaches Signal gilt, darf hier kein starkes Wiederholungssignal sein.
 * Sonst koennte man sich mit Selbsteinschaetzungen aus der Queue
 * herausschreiben - genau die Hintertuer, die Risiko R3 meint.
 */
function classWeight(signalClass: LearningSignalClass): number {
  return SCORE_WEIGHTS[signalClass];
}

/* -------------------------------------------------------------------------
 * Der Zustand und ein Schritt darauf
 * ---------------------------------------------------------------------- */

/** Der SM-2-Zustand eines Konzepts - genau die Spalten von `review_queue`. */
export interface ReviewState {
  readonly intervalDays: number;
  readonly easeFactor: number;
  readonly repetitions: number;
  readonly lapses: number;
  /** `null`, solange noch keine Wiederholung stattgefunden hat. */
  readonly dueAt: Date | null;
  readonly lastReviewedAt: Date | null;
}

/** Ein bewertetes Ereignis, wie die Wiederholungssteuerung es sieht. */
export interface ReviewOutcome {
  /** Ergebnis 0 bis 1 - dieselbe Groesse wie beim Mastery-Score. */
  readonly outcome: number;
  readonly signalClass: LearningSignalClass;
  /** Fachlicher Zeitpunkt. Aus ihm entsteht die neue Faelligkeit. */
  readonly occurredAt: Date;
}

/** Ausgangszustand, bevor ein Konzept je wiederholt wurde. */
export const INITIAL_REVIEW_STATE: ReviewState = {
  intervalDays: 0,
  easeFactor: EASE_START,
  repetitions: 0,
  lapses: 0,
  dueAt: null,
  lastReviewedAt: null,
};

/**
 * Ein Schritt der Wiederholungssteuerung - **reine Funktion**.
 *
 * Gelungen (`outcome >= 0.5`, dieselbe Schwelle wie im Fehlerprotokoll und in
 * der Mastery-Logik):
 *
 * | bisherige Wiederholungen | neues Intervall                   |
 * | ------------------------ | --------------------------------- |
 * | 0                        | 1 Tag                             |
 * | 1                        | 6 Tage                            |
 * | ≥ 2                      | `round(Intervall · Wachstum)`     |
 *
 * `Wachstum = 1 + (Ease − 1) · Signalgewicht`. Bei einem objektiven Treffer
 * ist das der volle Ease-Faktor wie im Original; eine Selbsteinschaetzung
 * (Gewicht 0,2) streckt das Intervall dagegen nur um ein Fuenftel davon.
 *
 * Misslungen (`outcome < 0.5`): Der Ease-Faktor faellt, die Wiederholungszahl
 * beginnt von vorn, der Rueckfallzaehler steigt. Fuer die naechste Faelligkeit
 * werden **zwei Faelle unterschieden**:
 *
 * - **Echter Rueckfall** - das Konzept sass schon einmal (`repetitions >= 1`):
 *   Intervall auf 0, wieder faellig in einer Stunde. Ein sicher geglaubtes
 *   Konzept, das kippt, muss sofort zurueck.
 * - **Fehlschlag in der Lernphase** (`repetitions === 0`): der normale erste
 *   Lernschritt von einem Tag. Es waere unsinnig, jemanden im Stundentakt mit
 *   etwas zu behelligen, das er noch gar nicht gelernt hat.
 */
export function scheduleReview(state: ReviewState, review: ReviewOutcome): ReviewState {
  const weight = classWeight(review.signalClass);
  const rawDelta = easeDelta(review.outcome);
  // Nur der **Gewinn** wird nach Signalklasse gedaempft. Ein Fehlschlag zaehlt
  // voll, egal woher er kommt: Niemand meldet faelschlich, dass er etwas nicht
  // konnte - eine Selbsteinschaetzung "falsch" ist glaubwuerdig.
  const delta = rawDelta > 0 ? rawDelta * weight : rawDelta;
  const easeFactor = round(clamp(state.easeFactor + delta, EASE_MIN, EASE_MAX), 4);

  if (review.outcome >= FAILURE_THRESHOLD) {
    const intervalDays = nextInterval(state, easeFactor, weight);
    return {
      intervalDays,
      easeFactor,
      repetitions: state.repetitions + 1,
      lapses: state.lapses,
      dueAt: new Date(review.occurredAt.getTime() + intervalDays * DAY_MS),
      lastReviewedAt: review.occurredAt,
    };
  }

  const trueLapse = state.repetitions >= 1;
  const intervalDays = trueLapse ? 0 : FIRST_INTERVAL_DAYS;
  const delayMs = trueLapse ? LAPSE_DELAY_MINUTES * MINUTE_MS : FIRST_INTERVAL_DAYS * DAY_MS;

  return {
    intervalDays,
    easeFactor,
    repetitions: 0,
    lapses: state.lapses + 1,
    dueAt: new Date(review.occurredAt.getTime() + delayMs),
    lastReviewedAt: review.occurredAt,
  };
}

function nextInterval(state: ReviewState, easeFactor: number, weight: number): number {
  if (state.repetitions === 0) return FIRST_INTERVAL_DAYS;
  if (state.repetitions === 1) return SECOND_INTERVAL_DAYS;
  const growth = 1 + (easeFactor - 1) * weight;
  return Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(state.intervalDays * growth)));
}

/**
 * Woher der Eintrag stammt. Entscheidet ueber die Dringlichkeit beim Abruf.
 *
 * - **`error`** - es gab einen Fehlschlag. Der juengste zaehlt, weil er den
 *   aktuellen Grund beschreibt.
 * - **`practice_finding`** - der juengste Fehlschlag kam aus einer
 *   Hand-Analyse oder einem Turnier (AP8). Ein Fehler am echten Tisch, nicht
 *   in einer Uebung.
 * - **`knowledge_gap`** - kein Fehlschlag, aber **kein einziges objektives
 *   Signal**: Der Stand beruht allein auf Modellurteilen und
 *   Selbsteinschaetzung. Genau der Fall, den T4.3 als
 *   `mastered_without_objective_anchors` durchlaesst - die Queue holt ihn
 *   zurueck und macht die Weiterschaltung damit ehrlich.
 *
 * `null` = kein Anlass, das Konzept wiedervorzulegen.
 */
export function reviewOrigin(
  signals: readonly {
    outcome: number;
    signalClass: LearningSignalClass;
    source: LearningEventSource;
  }[],
): ReviewQueueOrigin | null {
  const failures = signals.filter((signal) => signal.outcome < FAILURE_THRESHOLD);
  const lastFailure = failures[failures.length - 1];

  if (lastFailure) {
    return lastFailure.source === 'hand_analysis' || lastFailure.source === 'tournament'
      ? 'practice_finding'
      : 'error';
  }

  if (signals.length > 0 && !signals.some((signal) => signal.signalClass === 'objective')) {
    return 'knowledge_gap';
  }

  return null;
}

/* -------------------------------------------------------------------------
 * Priorisierung
 * ---------------------------------------------------------------------- */

/** Ein Queue-Eintrag, angereichert um alles, was die Reihenfolge braucht. */
export interface ReviewCandidate {
  readonly conceptId: string;
  readonly dueAt: Date;
  readonly origin: ReviewQueueOrigin;
  readonly intervalDays: number;
  readonly easeFactor: number;
  readonly repetitions: number;
  readonly lapses: number;
  /** Mastery-Score des Konzepts; 0, wenn noch keiner vorliegt. */
  readonly masteryScore: number;
  /** Voraussetzungen aus dem Konzept-Graphen (AP3). */
  readonly prerequisiteIds: readonly string[];
}

/**
 * Rang des Ursprungs: kleiner ist dringender.
 *
 * Ein Fehler in der Uebung und ein Fehler am Tisch sind beide belegte Fehler;
 * der Praxisbefund steht knapp dahinter, weil eine einzelne Hand mehr Rauschen
 * enthaelt als eine gestellte Frage. Die Luecke kommt zuletzt: Dort ist noch
 * nichts schiefgegangen, es fehlt nur der Beleg.
 */
const ORIGIN_RANK: Readonly<Record<ReviewQueueOrigin, number>> = {
  error: 0,
  practice_finding: 1,
  knowledge_gap: 2,
};

/** Wie viele **ganze** Tage ein Eintrag ueberfaellig ist; 0 = heute faellig. */
export function overdueDays(candidate: { dueAt: Date }, asOf: Date): number {
  return Math.max(0, Math.floor((asOf.getTime() - candidate.dueAt.getTime()) / DAY_MS));
}

/**
 * Bringt die faelligen Eintraege in die Reihenfolge, in der sie vorgelegt
 * werden sollen - **reine Funktion**.
 *
 * Vier Stufen, in dieser Reihenfolge:
 *
 * 1. **Ueberfaelligkeit in ganzen Tagen**, absteigend. Bewusst gerundet: Auf
 *    die Minute genau zu sortieren waere Scheingenauigkeit - zwei Eintraege
 *    vom selben Tag sind gleich dringend, und dann soll der Ursprung
 *    entscheiden, nicht der Zufall der Uhrzeit.
 * 2. **Ursprung**: Fehler vor Praxisbefund vor Luecke.
 * 3. **Mastery aufsteigend**: Was schlechter sitzt, kommt zuerst.
 * 4. **Konzept-ID**: nur damit die Reihenfolge reproduzierbar ist.
 *
 * Danach greift die Voraussetzungsregel (siehe {@link respectPrerequisites}).
 */
export function prioritizeReviews(
  candidates: readonly ReviewCandidate[],
  asOf: Date,
): readonly ReviewCandidate[] {
  const byUrgency = [...candidates].sort((a, b) => {
    const overdue = overdueDays(b, asOf) - overdueDays(a, asOf);
    if (overdue !== 0) return overdue;

    const origin = ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin];
    if (origin !== 0) return origin;

    const mastery = a.masteryScore - b.masteryScore;
    if (mastery !== 0) return mastery;

    return a.conceptId.localeCompare(b.conceptId);
  });

  return respectPrerequisites(byUrgency);
}

/**
 * Zieht Voraussetzungen vor die Konzepte, die auf ihnen aufbauen.
 *
 * Die Regel ist bewusst **eng gefasst**: Sie greift nur zwischen Eintraegen,
 * die ohnehin beide faellig sind. Ein Konzept wird nicht deshalb
 * zurueckgestellt, weil irgendeine Voraussetzung irgendwo schwach ist - nur
 * dann, wenn diese Voraussetzung in derselben Ausgabe steht.
 *
 * Begruendung fuer diesen Zuschnitt: Alles Weitergehende - "wie wackelig darf
 * eine Voraussetzung sein" - braeuchte eine Schwelle, und Schwellen sind
 * Konfiguration. Die Queue soll ohne Konfiguration reproduzierbar bleiben. Der
 * enge Fall deckt das ab, was in der Praxis stoert: erst das Fundament
 * wiederholen, dann das Darauf-Gebaute, in derselben Sitzung.
 *
 * Das Verfahren ist eine stabile topologische Auswahl: Genommen wird immer der
 * hoechstpriorisierte Eintrag, dessen faellige Voraussetzungen schon ausgegeben
 * sind. Es terminiert, weil der Prerequisite-Graph zyklenfrei ist (Invariante 5
 * aus AP3); die Notbremse deckt den Fall ab, dass er es einmal nicht waere.
 */
function respectPrerequisites(ordered: readonly ReviewCandidate[]): readonly ReviewCandidate[] {
  const pending = [...ordered];
  const dueIds = new Set(ordered.map((candidate) => candidate.conceptId));
  const emitted = new Set<string>();
  const result: ReviewCandidate[] = [];

  while (pending.length > 0) {
    const index = pending.findIndex((candidate) =>
      candidate.prerequisiteIds.filter((id) => dueIds.has(id)).every((id) => emitted.has(id)),
    );

    // Notbremse: Gaebe es doch einen Zyklus, bliebe die Schleife sonst stehen.
    // Dann gilt die reine Prioritaetsreihenfolge - schlechter als ideal, aber
    // besser als ein haengender Abruf.
    const take = index === -1 ? 0 : index;
    const [candidate] = pending.splice(take, 1);
    if (!candidate) break;
    emitted.add(candidate.conceptId);
    result.push(candidate);
  }

  return result;
}

/* -------------------------------------------------------------------------
 * Kleinkram
 * ---------------------------------------------------------------------- */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampRatio(value: number): number {
  return clamp(value, 0, 1);
}

/** Wie in `mastery.ts`: Rundung haelt die Werte reihenfolgeunabhaengig. */
function round(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}
