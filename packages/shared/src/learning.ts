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
 * - `level_set` — der Lernende setzt sein Level selbst (T4.5). Das einzige
 *   Ereignis **ohne** Konzeptbezug.
 */
export const LEARNING_EVENT_TYPES = [
  'question_answered',
  'concept_explained',
  'drill_completed',
  'hand_analyzed',
  'review_performed',
  'manual_correction',
  'level_set',
] as const;
export type LearningEventType = (typeof LEARNING_EVENT_TYPES)[number];

/**
 * Ereignistypen **ohne** Konzeptbezug — globale Ereignisse am Lernenden.
 *
 * Für sie ist `conceptId` verboten, für alle anderen Pflicht. In der Datenbank
 * erzwingt das der CHECK `learning_event_scope_check` (Migration `0010`).
 */
export const GLOBAL_LEARNING_EVENT_TYPES: readonly LearningEventType[] = ['level_set'];

export function isGlobalLearningEventType(value: LearningEventType): boolean {
  return GLOBAL_LEARNING_EVENT_TYPES.includes(value);
}

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

export function isLearnerLevel(value: unknown): value is LearnerLevel {
  return typeof value === 'string' && (LEARNER_LEVELS as readonly string[]).includes(value);
}

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
  /**
   * Ab diesem Mastery-Score gilt ein Konzept als sitzend.
   *
   * Seit T4.3 **0,75** statt der 0,8 aus T4.1: Mit der gewichteten Formel
   * (Vorwissen-Prior, Zeitgewichtung, Fehler-Asymmetrie) erreicht 0,8 erst,
   * wer vier saubere objektive Treffer hinlegt — für eine Schwelle, die
   * zusätzlich objektive Anker verlangt, ist das doppelt gemoppelt.
   * Migration `0009`; Begründung in ADR-0042.
   */
  masteryThreshold: 0.75,
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

/* -------------------------------------------------------------------------
 * Nutzdaten je Ereignistyp (AP4.T4.2)
 *
 * Bewusst je Typ eigene Felder statt eines formlosen JSONB-Objekts: Ein
 * Drill-Ergebnis trägt andere Angaben als eine Feynman-Erklärung. Was hier
 * nicht steht, wird beim Eintritt abgewiesen — ein Tippfehler im Feldnamen
 * soll auffallen, nicht stillschweigend im `payload` verschwinden und beim
 * Replay als „kein Ergebnis" gelten.
 * ---------------------------------------------------------------------- */

/** Eine gestellte Frage wurde beantwortet (Theorie-Q&A, Turnier-Zwischenfrage). */
export interface QuestionAnsweredPayload {
  readonly correct: boolean;
  /** Schwierigkeit der Frage, 0 bis 1. Fehlt sie, gilt `DEFAULT_DIFFICULTY`. */
  readonly difficulty?: number;
  /** Kennung der Frage, soweit der Modus eine vergibt. */
  readonly questionId?: string;
  /** Antwort des Lernenden, für die Nachschau. */
  readonly given?: string;
  /** Richtige Antwort — bei `objective` die chart-verifizierte. */
  readonly expected?: string;
}

/** Der Lernende hat ein Konzept in eigenen Worten erklärt (Feynman). */
export interface ConceptExplainedPayload {
  /** Bewertung der Erklärung, 0 bis 1. */
  readonly quality: number;
  /** Schwierigkeit des Konzepts, 0 bis 1. Fehlt sie, gilt `DEFAULT_DIFFICULTY`. */
  readonly difficulty?: number;
  /** Begründung der Bewertung, für die transparente Anzeige (F02). */
  readonly rationale?: string;
}

/** Ein Drill-Durchlauf ist abgeschlossen (AP7). */
export interface DrillCompletedPayload {
  /** Richtige Antworten, 0 bis `total`. */
  readonly correct: number;
  /** Gestellte Aufgaben, mindestens 1. */
  readonly total: number;
  readonly drillId?: string;
  /** Schwierigkeit des Drills, 0 bis 1. Fehlt sie, gilt `DEFAULT_DIFFICULTY`. */
  readonly difficulty?: number;
}

/** Eine Hand wurde analysiert (AP8). */
export interface HandAnalyzedPayload {
  readonly correct: boolean;
  /** Kennung der Hand in der Historie. */
  readonly handRef?: string;
  /** Kurzbeschreibung des Fehlers, falls einer vorlag. */
  readonly mistake?: string;
  /** Schwierigkeit des Spots, 0 bis 1. Fehlt sie, gilt `DEFAULT_DIFFICULTY`. */
  readonly difficulty?: number;
}

/** Eine fällige Wiederholung wurde durchgeführt (T4.4). */
export interface ReviewPerformedPayload {
  readonly correct: boolean;
  /** Schwierigkeit der Wiederholung, 0 bis 1. Fehlt sie, gilt `DEFAULT_DIFFICULTY`. */
  readonly difficulty?: number;
}

/**
 * Nachträgliche Korrektur eines früheren Ereignisses.
 *
 * Ereignisse sind unveränderlich (T4.1). Eine Korrektur ist deshalb ein
 * **neues** Ereignis, das auf das ursprüngliche zeigt und dessen Wirkung
 * verändert — die Historie bleibt vollständig und ehrlich.
 *
 * - `replacementOutcome` fehlt oder ist `null` → die Wirkung des
 *   ursprünglichen Ereignisses wird **aufgehoben**, als hätte es nie
 *   stattgefunden.
 * - `replacementOutcome` ist eine Zahl (0 bis 1) → das ursprüngliche Ergebnis
 *   wird durch diesen Wert **ersetzt**.
 */
export interface ManualCorrectionPayload {
  /** Warum korrigiert wird — steht später in der Nachschau. */
  readonly reason: string;
  readonly replacementOutcome?: number | null;
}

/**
 * Der Lernende setzt sein Level selbst (T4.5).
 *
 * Wird für {@link MANUAL_LEVEL_GRACE_DAYS} Tage respektiert; danach greift die
 * Automatik wieder. Ohne diese Frist überschriebe der nächste Lauf die
 * Korrektur sofort.
 */
export interface LevelSetPayload {
  readonly level: LearnerLevel;
  /** Warum von Hand gesetzt — steht später in der Nachschau. */
  readonly reason?: string;
}

/** Zuordnung Ereignistyp → Nutzdaten. Der Vertrag für AP5 bis AP9. */
export interface LearningEventPayloadMap {
  readonly question_answered: QuestionAnsweredPayload;
  readonly concept_explained: ConceptExplainedPayload;
  readonly drill_completed: DrillCompletedPayload;
  readonly hand_analyzed: HandAnalyzedPayload;
  readonly review_performed: ReviewPerformedPayload;
  readonly manual_correction: ManualCorrectionPayload;
  readonly level_set: LevelSetPayload;
}

export type LearningEventPayload = LearningEventPayloadMap[LearningEventType];

/* -------------------------------------------------------------------------
 * Eingabe und Antwort von `recordLearningEvent` (AP4.T4.2)
 * ---------------------------------------------------------------------- */

/**
 * Was ein Aufrufer übergibt. **Die einzige Schreibform des Lernstands.**
 *
 * Generisch über den Ereignistyp, damit der Compiler die passenden Nutzdaten
 * erzwingt: `RecordLearningEventInput<'drill_completed'>` verlangt
 * `{ correct, total }` und nimmt kein `{ quality }` an.
 */
export interface RecordLearningEventInput<TType extends LearningEventType = LearningEventType> {
  /** Vom Aufrufer vergeben — trägt die Idempotenz. Ein UUID. */
  readonly id: string;
  readonly eventType: TType;
  readonly source: LearningEventSource;
  readonly signalClass: LearningSignalClass;
  /** Pflicht für alle Ereignisse außer `level_set`. */
  readonly conceptId?: string;
  /** ISO-Zeitstempel des Geschehens. Fehlt er, setzt der Service „jetzt". */
  readonly occurredAt?: string;
  /** Chart, gegen das geprüft wurde — Beleg eines objektiven Signals. */
  readonly chartId?: string | null;
  /** Pflicht bei `manual_correction`, sonst verboten. */
  readonly correctsEventId?: string | null;
  readonly payload: LearningEventPayloadMap[TType];
}

/**
 * `recorded` = das Ereignis wurde aufgezeichnet und die Ableitungen gezogen.
 * `duplicate` = die Ereignis-ID gab es schon; der Zustand blieb unverändert.
 * **Beides ist Erfolg** — ein Wiederholungsversuch nach Netzwerkabbruch darf
 * den Aufrufer nicht in einen Fehlerpfad zwingen.
 */
export const RECORD_EVENT_STATUSES = ['recorded', 'duplicate'] as const;
export type RecordEventStatus = (typeof RECORD_EVENT_STATUSES)[number];

export interface RecordLearningEventResponse {
  readonly status: RecordEventStatus;
  readonly eventId: string;
  /** `null` bei globalen Ereignissen wie `level_set`. */
  readonly conceptId: string | null;
}

/** Feldweise Ablehnung — dasselbe Muster wie Konzept-Review und Einstellungen. */
export interface LearningEventErrorResponse {
  readonly error: 'invalid_event';
  readonly message: string;
  readonly fields: readonly { field: string; message: string }[];
}

export function isLearningEventErrorResponse(value: unknown): value is LearningEventErrorResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { error?: unknown }).error === 'invalid_event' &&
    Array.isArray((value as { fields?: unknown }).fields)
  );
}

/* -------------------------------------------------------------------------
 * Validierung der Nutzdaten
 * ---------------------------------------------------------------------- */

interface FieldError {
  readonly field: string;
  readonly message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Zahl im geschlossenen Intervall, ohne NaN und Unendlich. */
function isRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function optionalString(payload: Record<string, unknown>, key: string, fields: FieldError[]): void {
  const value = payload[key];
  if (value !== undefined && typeof value !== 'string') {
    fields.push({ field: `payload.${key}`, message: `"${key}" muss eine Zeichenkette sein.` });
  }
}

/**
 * Prüft die Nutzdaten gegen den Vertrag des Ereignistyps.
 *
 * Liegt hier und nicht im Backend, weil dieselbe Prüfung dem Frontend zur
 * Verfügung stehen soll — der Vertrag steht genau einmal im Projekt.
 * Entschieden wird trotzdem serverseitig (dasselbe Prinzip wie ADR-0029).
 *
 * Unbekannte Felder werden **abgelehnt**, nicht ignoriert: Ein `{ korrekt: true }`
 * statt `{ correct: true }` würde sonst als „kein Ergebnis" durchrutschen und
 * den Lernstand still verfälschen.
 */
export function validateLearningEventPayload(
  eventType: LearningEventType,
  payload: unknown,
): readonly FieldError[] {
  const fields: FieldError[] = [];

  if (!isPlainObject(payload)) {
    return [{ field: 'payload', message: 'Die Nutzdaten müssen ein Objekt sein.' }];
  }

  const allowed: Record<LearningEventType, readonly string[]> = {
    question_answered: ['correct', 'questionId', 'given', 'expected', 'difficulty'],
    concept_explained: ['quality', 'rationale', 'difficulty'],
    drill_completed: ['correct', 'total', 'drillId', 'difficulty'],
    hand_analyzed: ['correct', 'handRef', 'mistake', 'difficulty'],
    review_performed: ['correct', 'difficulty'],
    manual_correction: ['reason', 'replacementOutcome'],
    level_set: ['level', 'reason'],
  };

  for (const key of Object.keys(payload)) {
    if (!allowed[eventType].includes(key)) {
      fields.push({
        field: `payload.${key}`,
        message: `Unbekanntes Feld "${key}" für "${eventType}". Erlaubt: ${allowed[eventType].join(', ')}.`,
      });
    }
  }

  if (eventType !== 'manual_correction' && eventType !== 'level_set') {
    const difficulty = payload['difficulty'];
    if (difficulty !== undefined && !isRatio(difficulty)) {
      fields.push({
        field: 'payload.difficulty',
        message: '"difficulty" muss eine Zahl zwischen 0 und 1 sein.',
      });
    }
  }

  switch (eventType) {
    case 'question_answered':
    case 'hand_analyzed':
    case 'review_performed': {
      if (typeof payload['correct'] !== 'boolean') {
        fields.push({ field: 'payload.correct', message: '"correct" muss true oder false sein.' });
      }
      optionalString(payload, 'questionId', fields);
      optionalString(payload, 'given', fields);
      optionalString(payload, 'expected', fields);
      optionalString(payload, 'handRef', fields);
      optionalString(payload, 'mistake', fields);
      break;
    }
    case 'concept_explained': {
      if (!isRatio(payload['quality'])) {
        fields.push({
          field: 'payload.quality',
          message: '"quality" muss eine Zahl zwischen 0 und 1 sein.',
        });
      }
      optionalString(payload, 'rationale', fields);
      break;
    }
    case 'drill_completed': {
      const total = payload['total'];
      const correct = payload['correct'];
      if (!Number.isInteger(total) || (total as number) < 1) {
        fields.push({
          field: 'payload.total',
          message: '"total" muss eine ganze Zahl ab 1 sein.',
        });
      }
      if (!Number.isInteger(correct) || (correct as number) < 0) {
        fields.push({
          field: 'payload.correct',
          message: '"correct" muss eine ganze Zahl ab 0 sein.',
        });
      } else if (Number.isInteger(total) && (correct as number) > (total as number)) {
        fields.push({
          field: 'payload.correct',
          message: '"correct" darf "total" nicht überschreiten.',
        });
      }
      optionalString(payload, 'drillId', fields);
      break;
    }
    case 'level_set': {
      if (!isLearnerLevel(payload['level'])) {
        fields.push({
          field: 'payload.level',
          message: `Unbekanntes Level. Erlaubt: ${LEARNER_LEVELS.join(', ')}.`,
        });
      }
      optionalString(payload, 'reason', fields);
      break;
    }
    case 'manual_correction': {
      const reason = payload['reason'];
      if (typeof reason !== 'string' || reason.trim() === '') {
        fields.push({
          field: 'payload.reason',
          message: 'Eine Korrektur braucht eine Begründung.',
        });
      }
      const replacement = payload['replacementOutcome'];
      if (replacement !== undefined && replacement !== null && !isRatio(replacement)) {
        fields.push({
          field: 'payload.replacementOutcome',
          message: '"replacementOutcome" muss null oder eine Zahl zwischen 0 und 1 sein.',
        });
      }
      break;
    }
  }

  return fields;
}

/* -------------------------------------------------------------------------
 * Weiterschalt-Entscheidung (AP4.T4.3)
 *
 * Der Vertrag für die **transparente Anzeige** (F02). AP5 fragt „darf ich
 * weiter?", AP6 zeigt an, warum beziehungsweise warum nicht.
 * ---------------------------------------------------------------------- */

/** Fehlt die Angabe am Ereignis, gilt mittlere Schwierigkeit. */
export const DEFAULT_DIFFICULTY = 0.5;

/**
 * Warum die Entscheidung so ausfiel. Genau ein Grund je Entscheidung.
 *
 * - `mastered` — Score über der Schwelle und genug objektive Anker.
 * - `mastered_without_objective_anchors` — weitergeschaltet, **obwohl** keine
 *   chart-verifizierbaren Anker möglich sind (Übergangszustand, Scope-Delta 2).
 *   Die Anzeige muss das kenntlich machen.
 * - `score_below_threshold` — der Score reicht nicht.
 * - `insufficient_objective_anchors` — der Score reicht, die objektiven Anker
 *   nicht. **Das ist kein Sonderfall, sondern die Regel gegen R3.**
 * - `insufficient_substitute_anchors` — im Übergangszustand: zu wenige
 *   Signale, die nicht von einem Modell stammen.
 * - `no_evidence` — zu diesem Konzept liegt noch nichts vor.
 */
export const ADVANCE_REASONS = [
  'mastered',
  'mastered_without_objective_anchors',
  'score_below_threshold',
  'insufficient_objective_anchors',
  'insufficient_substitute_anchors',
  'no_evidence',
] as const;
export type AdvanceReason = (typeof ADVANCE_REASONS)[number];

export function isAdvanceReason(value: unknown): value is AdvanceReason {
  return typeof value === 'string' && (ADVANCE_REASONS as readonly string[]).includes(value);
}

/** Die Gründe, die eine Weiterschaltung tatsächlich verhindern. */
export const ADVANCE_BLOCKERS = [
  'score_below_threshold',
  'insufficient_objective_anchors',
  'insufficient_substitute_anchors',
  'no_evidence',
] as const;
export type AdvanceBlocker = (typeof ADVANCE_BLOCKERS)[number];

/**
 * Das Ergebnisobjekt der Weiterschalt-Entscheidung.
 *
 * **Bausteine, keine Sätze.** Jede Zahl, die eine Begründung braucht, steht
 * hier einzeln — die Formulierung ist Sache des Frontends in AP6. Würde hier
 * fertiger Text stehen, verwüchsen Logik und Wortlaut, und jede
 * Textänderung ginge durch das Backend.
 */
export interface AdvanceDecision {
  readonly allowed: boolean;
  readonly reason: AdvanceReason;
  /** Alle verletzten Bedingungen, nicht nur die erste. Leer, wenn erlaubt. */
  readonly blockers: readonly AdvanceBlocker[];

  /** Mastery-Score, 0 bis 1. */
  readonly score: number;
  /** Geforderte Schwelle aus `learner_state`. */
  readonly threshold: number;

  /** Konfidenz zum Zeitpunkt der letzten Prüfung, wie gespeichert. */
  readonly storedConfidence: number;
  /** Konfidenz nach Abzug der Veralterung — der Wert für die Anzeige. */
  readonly confidence: number;
  /** Tage seit der letzten Prüfung. `null`, wenn es noch keine gab. */
  readonly daysSinceLastCheck: number | null;

  /** Wie viele objektive Anker vorliegen. */
  readonly objectiveAnchors: number;
  /** Wie viele gefordert sind (aus `learner_state`). */
  readonly requiredObjectiveAnchors: number;
  /**
   * Sind chart-verifizierbare Anker für dieses Konzept überhaupt möglich?
   * Ermittelt aus `concept_chart` × `range_chart.state = 'approved'`.
   */
  readonly objectiveAnchorsPossible: boolean;
  /**
   * Ersatzanker im Übergangszustand: Signale, die **nicht** von einem Modell
   * stammen (objektiv + selbst eingeschätzt). Nur relevant, wenn
   * `objectiveAnchorsPossible === false`.
   */
  readonly substituteAnchors: number;

  /** Zähler je Signalklasse — die Datenlage im Klartext. */
  readonly signalCounts: {
    readonly objective: number;
    readonly aiJudged: number;
    readonly selfReported: number;
  };
}

/* -------------------------------------------------------------------------
 * Schwellenwerte (AP4.T4.3)
 * ---------------------------------------------------------------------- */

/**
 * Die lernbezogenen Schwellen aus `learner_state`.
 *
 * Sie stehen dort und **nicht** in `config`: Es geht um Lernverhalten, nicht um
 * Technik (Abgrenzung siehe INTERFACES.md 17).
 */
export interface LearningThresholds {
  readonly masteryThreshold: number;
  readonly minObjectiveAnchors: number;
}

/** Teiländerung der Schwellen. */
export interface LearningThresholdUpdate {
  readonly masteryThreshold?: number;
  readonly minObjectiveAnchors?: number;
}

/**
 * Erlaubte Bereiche, serverseitig geprüft.
 *
 * Die Untergrenze der Mastery-Schwelle ist kein Formalismus: Unter 0,5 hieße
 * „weitergehen, obwohl mehr dagegen als dafür spricht". Und `minObjectiveAnchors`
 * darf zwar 0 sein — das ist dann aber eine **bewusste** Entscheidung des
 * Nutzers gegen die Absicherung aus Risiko R3, keine stille Voreinstellung.
 */
export const LEARNING_THRESHOLD_RANGES = {
  masteryThreshold: { min: 0.5, max: 0.95, default: 0.75 },
  minObjectiveAnchors: { min: 0, max: 10, default: 2 },
} as const;

/* -------------------------------------------------------------------------
 * Abruf der Wiederholungs-Queue (AP4.T4.4)
 *
 * Der Vertrag für **AP5** (Lern-Session), **AP7** (Drill) und **AP9**
 * (Materialtrigger). AP8 liefert später die turnierspezifische Auswahl.
 * ---------------------------------------------------------------------- */

/**
 * Wofür die Einträge geholt werden.
 *
 * - `session` — eine Theorie-Lerneinheit (AP5).
 * - `drill` — ein Übungsdurchlauf (AP7).
 * - `tournament` — Turniervorbereitung (AP8). Die formatabhängige Auswahl
 *   entsteht dort; hier ist nur der Platz dafür vorgesehen.
 */
export const REVIEW_CONTEXTS = ['session', 'drill', 'tournament'] as const;
export type ReviewContext = (typeof REVIEW_CONTEXTS)[number];

export function isReviewContext(value: unknown): value is ReviewContext {
  return typeof value === 'string' && (REVIEW_CONTEXTS as readonly string[]).includes(value);
}

/** „Gib mir N fällige Einträge für Kontext X." */
export interface DueReviewsQuery {
  readonly context: ReviewContext;
  /** Wie viele Einträge höchstens. */
  readonly limit: number;
  /**
   * Bezugszeitpunkt — **Pflichtparameter**, kein `Date.now()` im Inneren.
   * Nur so ist der Abruf prüfbar und der Replay reproduzierbar.
   */
  readonly asOf: Date;
  /**
   * Einschränkung auf Themenbereiche. Der Andockpunkt für AP8: Eine
   * Turniervorbereitung setzt hier die Bereiche, die zum Format passen.
   */
  readonly topicAreas?: readonly ConceptTopicArea[];
}

/** Ein fälliger Eintrag, angereichert um alles, was der Aufrufer anzeigen muss. */
export interface DueReviewItem {
  readonly conceptId: string;
  readonly conceptTitle: string;
  readonly topicArea: ConceptTopicArea;
  /** `draft` oder `approved` — AP5/AP6 weisen den Zustand aus (Scope-Delta 3). */
  readonly conceptState: string;
  readonly dueAt: string;
  /** Wie viele **ganze** Tage überfällig; 0 = heute fällig. */
  readonly overdueDays: number;
  readonly origin: ReviewQueueOrigin;
  readonly intervalDays: number;
  readonly easeFactor: number;
  readonly repetitions: number;
  readonly lapses: number;
  /** Mastery-Score des Konzepts; 0, wenn noch keiner vorliegt. */
  readonly masteryScore: number;
}

/**
 * Antwort des Abrufs.
 *
 * **Es wird nicht künstlich aufgefüllt.** Sind weniger als `limit` Einträge
 * fällig, kommen eben weniger — aber `dueTotal` sagt, wie viele es tatsächlich
 * waren. AP5 und AP9 entscheiden damit selbst, ob sie mit neuem Stoff
 * ergänzen; das ist ihre Aufgabe, nicht die der Queue.
 */
export interface DueReviewsResponse {
  readonly context: ReviewContext;
  readonly limit: number;
  readonly asOf: string;
  readonly items: readonly DueReviewItem[];
  /** Wie viele Einträge insgesamt fällig waren — **unabhängig von `limit`**. */
  readonly dueTotal: number;
  /** Wie viele tatsächlich geliefert wurden. */
  readonly returned: number;
}

/** „Was wird demnächst fällig?" — die Vorschau fürs Dashboard (T4.7). */
export interface UpcomingReviewsQuery {
  readonly asOf: Date;
  /** Vorausschau in Tagen. */
  readonly withinDays: number;
  readonly limit: number;
}

export interface UpcomingReviewItem {
  readonly conceptId: string;
  readonly conceptTitle: string;
  readonly topicArea: ConceptTopicArea;
  readonly dueAt: string;
  /** Wie viele Tage es noch hin ist (aufgerundet auf ganze Tage). */
  readonly inDays: number;
  readonly origin: ReviewQueueOrigin;
}

export interface UpcomingReviewsResponse {
  readonly asOf: string;
  readonly withinDays: number;
  readonly items: readonly UpcomingReviewItem[];
  /** Wie viele im Zeitfenster liegen — unabhängig von `limit`. */
  readonly total: number;
}

/* -------------------------------------------------------------------------
 * Skill-Ratings und Level (AP4.T4.5)
 *
 * Die zweite Dimension neben dem Kapitelfortschritt: **wo stehe ich fachlich**
 * (F09) und **auf welchem Niveau wird unterrichtet** (F07).
 * ---------------------------------------------------------------------- */

/**
 * Wie lange eine manuelle Level-Setzung Vorrang vor der Automatik hat.
 *
 * 30 Tage: lang genug, dass eine Serie von Sitzungen die Korrektur nicht
 * sofort wieder einkassiert; kurz genug, dass eine falsche Selbsteinschätzung
 * nicht dauerhaft bleibt. In dieser Zeit sammelt sich Beleglage an — wenn die
 * Frist abläuft, steht die Automatik auf festerem Grund als am Tag der
 * Korrektur.
 */
export const MANUAL_LEVEL_GRACE_DAYS = 30;

/** Woher das aktuelle Level stammt. */
export const LEVEL_SOURCES = ['automatic', 'manual'] as const;
export type LevelSource = (typeof LEVEL_SOURCES)[number];

/**
 * Die Kennzahlen, aus denen sich das Level ergibt.
 *
 * Bewusst drei unabhängige Größen statt einer: Ein hoher Durchschnitt allein
 * kann aus zwei gut gelaufenen Themenbereichen kommen, und eine hohe Zahl
 * beherrschter Konzepte allein sagt nichts über die Belastbarkeit der Belege.
 */
export interface LevelSignals {
  /** Mittel der Ratings über die Themenbereiche **mit Datenlage**. */
  readonly averageRating: number;
  /** Wie viele Themenbereiche überhaupt Daten haben (von zwölf). */
  readonly coveredTopicAreas: number;
  /** Konzepte mit belastbarer Mastery (Score und Konfidenz über der Marke). */
  readonly masteredConcepts: number;
  /** Anteil objektiver Signale an allen Signalen, 0 bis 1. */
  readonly objectiveShare: number;
  /** Alle bisher eingeflossenen Signale. */
  readonly totalSignals: number;
}

/**
 * Das Ergebnis der Level-Kalibrierung — **Bausteine, keine Sätze**, dasselbe
 * Prinzip wie bei `AdvanceDecision`.
 */
export interface LevelCalibration {
  readonly level: LearnerLevel;
  /** Das Level vor dieser Kalibrierung. */
  readonly previousLevel: LearnerLevel;
  readonly changed: boolean;
  readonly source: LevelSource;
  /**
   * Bis wann eine manuelle Setzung gilt. `null`, wenn keine wirkt.
   */
  readonly manualUntil: string | null;
  /**
   * Welches Level die Kennzahlen allein hergäben — auch während einer
   * manuellen Setzung sichtbar, damit AP6 den Unterschied anzeigen kann.
   */
  readonly automaticLevel: LearnerLevel;
  readonly signals: LevelSignals;
}

/** Ein Themenbereich mit seinem aktuellen Stand — die Achsen für AP6. */
export interface SkillRatingView {
  readonly topicArea: ConceptTopicArea;
  readonly label: string;
  readonly rating: number;
  readonly eventCount: number;
  readonly updatedAt: string;
}

/** Ein Punkt im Verlauf einer Achse. */
export interface SkillRatingHistoryPoint {
  /** Kalendertag in UTC, `YYYY-MM-DD`. */
  readonly day: string;
  readonly rating: number;
}

/** Der Verlauf einer Achse über die Zeit. */
export interface SkillRatingHistory {
  readonly topicArea: ConceptTopicArea;
  readonly points: readonly SkillRatingHistoryPoint[];
}

/* -------------------------------------------------------------------------
 * Muster-Report (AP4.T4.6)
 *
 * Aus Einzelfehlern werden erkennbare Muster. Die KI sieht dabei
 * **ausschließlich aggregierte Kennzahlen** — nie Rohprotokolle.
 * ---------------------------------------------------------------------- */

/** Job-Typ, über den ein Report angestoßen wird. */
export const PATTERN_REPORT_JOB = 'learning.pattern-report';

/** `complete` = Muster erkannt. `insufficient_data` = kein Aufruf abgesetzt. */
export const PATTERN_REPORT_STATUSES = ['complete', 'insufficient_data'] as const;
export type PatternReportStatus = (typeof PATTERN_REPORT_STATUSES)[number];

/**
 * Ab wann sich ein Report lohnt.
 *
 * Unterhalb dieser Marke wird **kein Aufruf abgesetzt**, sondern ein Hinweis
 * gespeichert. Ein Muster aus drei Datenpunkten wäre Kaffeesatzleserei — und
 * ein erfundenes Muster ist schlimmer als gar keins, weil es Lernzeit
 * fehlleitet.
 */
export const PATTERN_REPORT_MINIMUM = {
  /** So viele Fehler müssen im Zeitraum liegen. */
  errors: 8,
  /** Und sie müssen sich auf mindestens so viele Konzepte verteilen. */
  concepts: 3,
} as const;

/** Standard-Zeitraum eines Reports in Tagen. */
export const PATTERN_REPORT_PERIOD_DAYS = 28;

/* --- Die aggregierten Kennzahlen ---------------------------------------- */

/** Fehlerlage eines Konzepts im Zeitraum. */
export interface ConceptErrorStat {
  readonly conceptId: string;
  readonly title: string;
  readonly topicArea: ConceptTopicArea;
  readonly errors: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly firstAt: string;
  readonly lastAt: string;
  /**
   * Fehler, die **nach** einer zwischenzeitlich gelungenen Wiederholung
   * auftraten. Das stärkste Signal für einen echten, festsitzenden Denkfehler:
   * Es saß schon einmal und ist wieder gekippt.
   */
  readonly repeatedAfterReview: number;
}

/** Fehlerlage eines Themenbereichs im Zeitraum. */
export interface TopicAreaErrorStat {
  readonly topicArea: ConceptTopicArea;
  readonly label: string;
  readonly errors: number;
  readonly concepts: number;
}

/** Fehler je Woche — für die Frage „wird es besser oder schlechter?". */
export interface ErrorTrendPoint {
  /** Montag der Woche in UTC, `YYYY-MM-DD`. */
  readonly weekStart: string;
  readonly errors: number;
}

/** Wohin die Entwicklung zeigt. */
export const ERROR_TRENDS = ['improving', 'stable', 'worsening', 'unknown'] as const;
export type ErrorTrend = (typeof ERROR_TRENDS)[number];

/**
 * Alles, was die KI zu sehen bekommt — **und nichts darüber hinaus**.
 *
 * Zwei Gründe für die Verdichtung: Sie hält den Prompt klein
 * (Kontextdisziplin), und sie zwingt die Auswertung, über Muster zu sprechen
 * statt Einzelfälle nachzuerzählen.
 */
export interface ErrorAggregate {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly totalErrors: number;
  readonly totalConcepts: number;
  readonly bySeverity: { readonly high: number; readonly medium: number; readonly low: number };
  readonly byConcept: readonly ConceptErrorStat[];
  readonly byTopicArea: readonly TopicAreaErrorStat[];
  /** Fehler je Kontext: Theorie, Drill, Praxis. */
  readonly byContext: readonly {
    readonly contextKind: LearningEventSource;
    readonly errors: number;
  }[];
  readonly trend: readonly ErrorTrendPoint[];
  readonly trendDirection: ErrorTrend;
  /** Konzepte mit wiederholtem Fehler trotz zwischenzeitlicher Wiederholung. */
  readonly repeatedAfterReview: readonly ConceptErrorStat[];
}

/* --- Die Antwort der KI -------------------------------------------------- */

/** Wie belastbar ein Muster ist — die KI schätzt das selbst ein. */
export const PATTERN_CONFIDENCES = ['niedrig', 'mittel', 'hoch'] as const;
export type PatternConfidence = (typeof PATTERN_CONFIDENCES)[number];

/**
 * Ein erkanntes Muster.
 *
 * **Beobachtung und Deutung sind getrennte Felder.** Was in den Daten steht,
 * ist nachzählbar; was es bedeutet, ist eine Schlussfolgerung. Beides in einem
 * Satz zu vermischen wäre genau die Sorte Text, die sicher klingt und nichts
 * belegt.
 */
export interface ErrorPattern {
  readonly titel: string;
  /** Was in den Daten steht — nachzählbar. */
  readonly beobachtung: string;
  /** Was es bedeuten könnte — mit Begründung. */
  readonly deutung: string;
  /** Was der Lernende konkret tun sollte. */
  readonly empfehlung: string;
  /** Belege: betroffene Konzepte (Titel aus den übergebenen Daten). */
  readonly konzepte: readonly string[];
  readonly themenbereiche: readonly string[];
  /** Beleg: auf wie vielen Beobachtungen das Muster beruht. */
  readonly anzahl: number;
  /** Beleg: über welchen Zeitraum. */
  readonly zeitraum: string;
  readonly vertrauen: PatternConfidence;
}

/**
 * Schema, gegen das das Template `task/error-patterns` antwortet.
 *
 * `hinweis` ist Pflicht und darf leer sein: Findet die Auswertung kein
 * tragfähiges Muster, steht der Grund dort — statt dass etwas konstruiert
 * wird, um das Feld zu füllen.
 */
export const ERROR_PATTERN_SCHEMA = {
  type: 'object',
  properties: {
    muster: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titel: { type: 'string' },
          beobachtung: { type: 'string' },
          deutung: { type: 'string' },
          empfehlung: { type: 'string' },
          konzepte: { type: 'array', items: { type: 'string' } },
          themenbereiche: { type: 'array', items: { type: 'string' } },
          anzahl: { type: 'integer' },
          zeitraum: { type: 'string' },
          vertrauen: { type: 'string', enum: [...PATTERN_CONFIDENCES] },
        },
        required: [
          'titel',
          'beobachtung',
          'deutung',
          'empfehlung',
          'konzepte',
          'themenbereiche',
          'anzahl',
          'zeitraum',
          'vertrauen',
        ],
        additionalProperties: false,
      },
    },
    hinweis: { type: 'string' },
  },
  required: ['muster', 'hinweis'],
  additionalProperties: false,
} as const;

/* --- Der gespeicherte Report --------------------------------------------- */

/** Ein Muster im gespeicherten Report, samt seiner Kurzkennung. */
export interface StoredPattern extends ErrorPattern {
  /** Kurzkennung, unter der die zugehörigen Fehler markiert sind. */
  readonly tag: string;
  /** Wie viele Fehlereinträge dieser Tag trägt. */
  readonly taggedErrors: number;
}

/** Ein gespeicherter Report, wie AP6 ihn liest. */
export interface PatternReportView {
  readonly id: string;
  readonly status: PatternReportStatus;
  readonly generatedAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly errorCount: number;
  readonly conceptCount: number;
  readonly patterns: readonly StoredPattern[];
  /** Klartext, wenn kein Muster tragfähig war. */
  readonly note: string | null;
  readonly durationMs: number | null;
}
