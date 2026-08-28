/**
 * Verträge des Lernstands (AP4.T4.1).
 *
 * Der Lernstand ist **ereignisbasiert**: `learning_event` ist das Protokoll,
 * alle übrigen Tabellen sind daraus abgeleitet. Deshalb liegen die
 * geschlossenen Mengen hier und nirgendwo sonst — Backend, Frontend und der
 * Replay in T4.2 müssen sich über exakt dieselben Werte einig sein.
 *
 * Dieser Vertrag beschreibt **Struktur, keine Verhaltenslogik**. Gewichtung
 * (T4.3), SM-2 (T4.4), Rating-Fortschreibung (T4.5) und der Muster-Report
 * (T4.6) gehören nicht hierher.
 */

import { CONCEPT_LEVELS } from './concept.js';
import type { ConceptLevel, ConceptTopicArea } from './concept.js';

/* -------------------------------------------------------------------------
 * Geschlossene Mengen am Ereignis
 * ---------------------------------------------------------------------- */

/**
 * Signalklasse — **wie belastbar** ist die Beobachtung?
 *
 * Die Klassifizierung hängt am Ereignis, nicht an der späteren Berechnung.
 * Grund: Ein Replay (T4.2) rekonstruiert den Zustand allein aus dem
 * Ereignisstrom. Läge die Einstufung in der Mastery-Logik, wäre sie beim
 * Replay nicht mehr herleitbar — dieselbe Antwort könnte je nach Codestand
 * einmal als objektiver Treffer und einmal als Selbsteinschätzung gelten.
 *
 * Die Rangfolge `objective` > `ai_judged` > `self_reported` ist die fachliche
 * Vorgabe aus dem Gesamtscope; **gewichtet** wird sie erst in T4.3.
 *
 * - `objective` — deterministisch prüfbar, typischerweise gegen ein
 *   freigegebenes Chart (Zellabruf aus T3.5) oder eine eindeutig richtige
 *   Antwort. Der einzige Anker, der nicht von einem Modellurteil abhängt.
 * - `ai_judged` — ein Modell hat eine freie Antwort bewertet.
 * - `self_reported` — der Lernende hat sich selbst eingeschätzt.
 */
export const LEARNING_SIGNAL_CLASSES = ['objective', 'ai_judged', 'self_reported'] as const;
export type LearningSignalClass = (typeof LEARNING_SIGNAL_CLASSES)[number];

export function isLearningSignalClass(value: unknown): value is LearningSignalClass {
  return (
    typeof value === 'string' && (LEARNING_SIGNAL_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * Ereignistyp — **was** ist passiert.
 *
 * Bewusst am Lerngeschehen orientiert, nicht am Modus: Ob eine Frage in einer
 * Theorie-Session oder in einem Turnier beantwortet wurde, sagt `source`.
 *
 * - `question_answered` — eine gestellte Frage wurde beantwortet.
 * - `concept_explained` — der Lernende hat ein Konzept in eigenen Worten erklärt.
 * - `drill_completed` — ein Drill-Durchlauf ist abgeschlossen (AP7).
 * - `hand_analyzed` — eine Hand wurde analysiert (AP8).
 * - `review_performed` — eine fällige Wiederholung wurde durchgeführt (T4.4).
 * - `manual_correction` — nachträgliche Korrektur eines früheren Ereignisses.
 */
export const LEARNING_EVENT_TYPES = [
  'question_answered',
  'concept_explained',
  'drill_completed',
  'hand_analyzed',
  'review_performed',
  'manual_correction',
] as const;
export type LearningEventType = (typeof LEARNING_EVENT_TYPES)[number];

export function isLearningEventType(value: unknown): value is LearningEventType {
  return typeof value === 'string' && (LEARNING_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Quelle — **woher** das Ereignis kommt. Ein Modus je Wert.
 *
 * `manual` ist die Quelle jeder Korrektur von Hand; sie ist damit im
 * Ereignisstrom von echtem Lerngeschehen unterscheidbar.
 */
export const LEARNING_EVENT_SOURCES = [
  'theory_session',
  'drill',
  'hand_analysis',
  'tournament',
  'journal',
  'manual',
] as const;
export type LearningEventSource = (typeof LEARNING_EVENT_SOURCES)[number];

export function isLearningEventSource(value: unknown): value is LearningEventSource {
  return typeof value === 'string' && (LEARNING_EVENT_SOURCES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------
 * Geschlossene Mengen der abgeleiteten Tabellen
 * ---------------------------------------------------------------------- */

/**
 * Woher ein Eintrag der Wiederholungs-Queue stammt. Die Priorisierung in T4.4
 * braucht den Ursprung, weil ein nachgewiesener Fehler dringender ist als eine
 * vermutete Lücke.
 */
export const REVIEW_QUEUE_ORIGINS = ['error', 'knowledge_gap', 'practice_finding'] as const;
export type ReviewQueueOrigin = (typeof REVIEW_QUEUE_ORIGINS)[number];

export function isReviewQueueOrigin(value: unknown): value is ReviewQueueOrigin {
  return typeof value === 'string' && (REVIEW_QUEUE_ORIGINS as readonly string[]).includes(value);
}

/** Schweregrad eines protokollierten Fehlers. */
export const LEARNING_ERROR_SEVERITIES = ['low', 'medium', 'high'] as const;
export type LearningErrorSeverity = (typeof LEARNING_ERROR_SEVERITIES)[number];

export function isLearningErrorSeverity(value: unknown): value is LearningErrorSeverity {
  return (
    typeof value === 'string' && (LEARNING_ERROR_SEVERITIES as readonly string[]).includes(value)
  );
}

/**
 * Niveau, auf dem unterrichtet wird.
 *
 * **Bewusst dieselbe Liste wie `concept.min_level`** (`CONCEPT_LEVELS` aus
 * T3.2) und keine zweite: Das Level des Lernenden wird gegen `min_level` der
 * Konzepte gehalten. Zwei getrennte Listen müssten aufeinander abgebildet
 * werden — eine Abbildung, die niemand braucht und die auseinanderlaufen kann.
 * „Anfänger" heißt in dieser Liste `einsteiger`.
 */
export const LEARNER_LEVELS = CONCEPT_LEVELS;
export type LearnerLevel = ConceptLevel;

/* -------------------------------------------------------------------------
 * Startwerte der Ersteinrichtung
 * ---------------------------------------------------------------------- */

/**
 * Defaults des `learner_state`. Sie stehen hier und nicht nur im Seed, damit
 * die Oberfläche ab AP6 dieselben Werte als „unverändert" erkennen kann.
 */
export const LEARNER_STATE_DEFAULTS = {
  /** Wer neu anfängt, bekommt Einsteigerstoff. */
  level: 'einsteiger',
  /** Kapitel 1 des Buches. */
  currentChapter: 1,
  /** Ab diesem Mastery-Score gilt ein Konzept als sitzend (T4.3 entscheidet damit). */
  masteryThreshold: 0.8,
  /** So viele objektive Anker müssen mindestens vorliegen (T4.3 wertet sie aus). */
  minObjectiveAnchors: 2,
} as const;

/** Startwert eines Skill-Ratings: keine Datenlage. */
export const SKILL_RATING_START = 0;

/** Erlaubter Bereich des SM-2-Ease-Faktors (T4.4 rechnet darin). */
export const REVIEW_EASE_RANGE = { min: 1.3, max: 3.0, default: 2.5 } as const;

/* -------------------------------------------------------------------------
 * Zeilenverträge der sechs Tabellen
 * ---------------------------------------------------------------------- */

/**
 * Ein Ereignis des Lernstands — **unveränderlich**.
 *
 * Ab T4.2 wird ausschließlich über `recordLearningEvent` geschrieben; die
 * Tabelle nimmt weder UPDATE noch DELETE an (Trigger `learning_event_no_update`
 * / `learning_event_no_delete`). Eine Korrektur ist ein **neues** Ereignis vom
 * Typ `manual_correction` mit gesetztem `correctsEventId`.
 */
export interface LearningEvent {
  /** Vom Aufrufer vergeben — Träger der Idempotenz in T4.2. */
  readonly id: string;
  readonly eventType: LearningEventType;
  readonly source: LearningEventSource;
  readonly signalClass: LearningSignalClass;
  /** Fachlicher Zeitpunkt des Geschehens (nicht der Zeitpunkt der Aufzeichnung). */
  readonly occurredAt: string;
  readonly conceptId: string;
  /** Chart, gegen das geprüft wurde — nur bei objektiven Signalen üblich. */
  readonly chartId: string | null;
  /** Nur bei `manual_correction` gesetzt: das korrigierte Ereignis. */
  readonly correctsEventId: string | null;
  /** Nutzdaten je Ereignistyp. Bewusst offen — die Modi ab AP5 füllen sie. */
  readonly payload: Record<string, unknown>;
  /** Zeitpunkt der Aufzeichnung. */
  readonly createdAt: string;
}

/**
 * Abgeleiteter Lernstand je Konzept.
 *
 * `score` und `confidence` sind **getrennt**: Der Score sagt „wie gut", die
 * Konfidenz „wie belastbar ist diese Aussage". Ein Score von 0,9 aus lauter
 * KI-Bewertungen ist etwas anderes als derselbe Score aus objektiven Treffern —
 * ohne die Trennung wäre dieser Unterschied unsichtbar.
 */
export interface ConceptMastery {
  readonly conceptId: string;
  /** 0 bis 1. */
  readonly score: number;
  /** 0 bis 1, unabhängig vom Score geführt. */
  readonly confidence: number;
  readonly lastCheckedAt: string | null;
  /** Zähler je Signalklasse — die objektiven Anker aus T4.3 stehen hier. */
  readonly objectiveSignals: number;
  readonly aiJudgedSignals: number;
  readonly selfReportedSignals: number;
  /** Letztes Ereignis, das diesen Stand fortgeschrieben hat. */
  readonly lastEventId: string | null;
  readonly updatedAt: string;
}

/** Ein Konzept in der Wiederholungssteuerung. Genau eine Zeile je Konzept. */
export interface ReviewQueueEntry {
  readonly conceptId: string;
  readonly dueAt: string;
  /** Aktuelles SM-2-Intervall in Tagen. */
  readonly intervalDays: number;
  /** SM-2-Ease, siehe {@link REVIEW_EASE_RANGE}. */
  readonly easeFactor: number;
  readonly repetitions: number;
  /** Rückfälle — ein Lapse verkürzt in T4.4 das Intervall. */
  readonly lapses: number;
  readonly origin: ReviewQueueOrigin;
  readonly lastReviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Ein protokollierter Fehler, immer an sein auslösendes Ereignis gebunden. */
export interface LearningErrorEntry {
  readonly id: string;
  /** Das auslösende Ereignis — Protokoll und Ereignisstrom laufen nie auseinander. */
  readonly eventId: string;
  readonly conceptId: string;
  readonly occurredAt: string;
  /** In welchem Modus der Fehler entstand. */
  readonly contextKind: LearningEventSource;
  /** Kennung der Session, des Drills oder der Hand; von AP5/AP7/AP8 vergeben. */
  readonly contextRef: string | null;
  readonly description: string;
  readonly severity: LearningErrorSeverity;
  /** Wird erst in T4.6 vom Muster-Report gesetzt. */
  readonly patternTag: string | null;
  readonly createdAt: string;
}

/** Aktueller Stand einer Themenbereichs-Achse. Genau eine Zeile je Themenbereich. */
export interface SkillRating {
  readonly topicArea: ConceptTopicArea;
  /** 0 bis 1. */
  readonly rating: number;
  /** Wie viele Ereignisse in diesen Wert eingeflossen sind. */
  readonly eventCount: number;
  readonly updatedAt: string;
}

/** Ein Verlaufspunkt einer Achse — die Grundlage der Zeitreihe in AP6. */
export interface SkillRatingSnapshot {
  readonly id: string;
  readonly topicArea: ConceptTopicArea;
  readonly rating: number;
  readonly capturedAt: string;
}

/**
 * Globaler Lernzustand. **Genau ein Datensatz** (Single-User).
 *
 * Abgrenzung: Hier steht nur, was den **Lernstand** betrifft. Technische
 * Konfiguration (Provider, Modell, Timeouts) bleibt in der `config`-Tabelle
 * aus AP1 — siehe INTERFACES.md, Abschnitt 17.
 */
export interface LearnerState {
  readonly id: string;
  readonly level: LearnerLevel;
  readonly currentChapter: number;
  /** Zuletzt bearbeitetes Konzept; leer beim Erststart. */
  readonly currentConceptId: string | null;
  /** 0 bis 1. */
  readonly masteryThreshold: number;
  readonly minObjectiveAnchors: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
