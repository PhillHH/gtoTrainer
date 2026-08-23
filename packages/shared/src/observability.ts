/**
 * Vertraege rund um Job-Queue und Aufruf-Protokoll (AP2.T2.5).
 *
 * Backend und Frontend teilen sich diese Definitionen: Der Worker meldet
 * Statusaenderungen ueber SSE, und die Ansicht "letzte KI-Aufrufe" unter
 * Einstellungen liest das Protokoll ueber die HTTP-API.
 */

/* -------------------------------------------------------------------------
 * Aufruf-Protokoll (llm_call_log)
 * ---------------------------------------------------------------------- */

/** Zustaende eines protokollierten Aufrufs - identisch zur CHECK-Regel der Tabelle. */
export const LLM_CALL_STATUSES = ['pending', 'success', 'error'] as const;
export type LlmCallStatus = (typeof LLM_CALL_STATUSES)[number];

export function isLlmCallStatus(value: unknown): value is LlmCallStatus {
  return typeof value === 'string' && (LLM_CALL_STATUSES as readonly string[]).includes(value);
}

/** Ein Eintrag in der Liste - ohne Prompt und Antwort, damit sie schlank bleibt. */
export interface LlmCallSummary {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly status: LlmCallStatus;
  readonly durationMs: number | null;
  readonly totalTokens: number | null;
  /** ISO-8601. */
  readonly createdAt: string;
  /** Fehlermeldung, gekuerzt auf Listenlaenge. */
  readonly error: string | null;
}

/** Ein Eintrag mit vollem Inhalt - fuer die Detailansicht. */
export interface LlmCallDetail extends LlmCallSummary {
  readonly prompt: string;
  readonly response: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

/** Antwort von `GET /api/llm/calls`. */
export interface LlmCallListResponse {
  readonly calls: readonly LlmCallSummary[];
}

/** Antwort von `GET /api/llm/calls/:id`. */
export interface LlmCallDetailResponse {
  readonly call: LlmCallDetail;
}

/**
 * Markierung, die eine gekuerzte Nutzlast im Protokoll traegt. Wer sie in
 * Prompt oder Antwort sieht, weiss: hier fehlt etwas, und zwar absichtlich.
 */
export const LLM_LOG_TRUNCATION_MARKER = '[gekuerzt]';

/* -------------------------------------------------------------------------
 * Job-Queue
 * ---------------------------------------------------------------------- */

/**
 * Zustaende eines Jobs.
 *
 * `dead` ist der Dead-Letter-Zustand: entweder war der Fehler nicht
 * wiederholbar, oder `max_attempts` ist erschoepft. `failed` stammt aus dem
 * Schema-Skelett von AP1 und wird vom Worker **nicht** verwendet - ein Job ist
 * entweder wieder eingeplant (`queued`) oder endgueltig `dead`.
 */
export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * Statusaenderung eines Jobs, wie sie ueber SSE beim Frontend ankommt.
 *
 * Ereignisname im Stream ist immer `job`; `status` sagt, was passiert ist.
 */
export interface JobEvent {
  readonly jobId: string;
  readonly jobType: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** ISO-8601 des Ereignisses. */
  readonly at: string;
  /** Nur bei Fehlschlag: Kategorie aus der Fehler-Taxonomie, falls bekannt. */
  readonly errorKind?: string;
  /** Nur bei Fehlschlag: Meldung, gekuerzt. */
  readonly error?: string;
  /** Wann der naechste Versuch fruehestens laeuft (nur bei erneuter Einplanung). */
  readonly nextAttemptAt?: string;
  /** Verweis auf den Protokolleintrag, sofern der Job einen erzeugt hat. */
  readonly callId?: string;
}

export function isJobEvent(value: unknown): value is JobEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['jobId'] === 'string' &&
    typeof candidate['jobType'] === 'string' &&
    isJobStatus(candidate['status']) &&
    typeof candidate['at'] === 'string'
  );
}

/** Antwort von `POST /api/jobs/:id/retry`. */
export interface JobRetryResponse {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly attempts: number;
}

/** Name des SSE-Ereignisses, unter dem Statusaenderungen ankommen. */
export const JOB_EVENT_NAME = 'job';
