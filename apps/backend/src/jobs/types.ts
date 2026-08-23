import type { JobStatus } from '@gto/shared';
import type { Database } from '../db/client.js';

/**
 * Vertrag der Job-Verarbeitung (AP2.T2.5).
 *
 * Der Worker kennt keine Fachlichkeit - er kennt nur die
 * {@link JobHandlerRegistry}. AP3, AP4, AP8 und AP9 haengen dort ihre
 * Job-Typen ein; wie das geht, steht in docs/INTERFACES.md Abschnitt 10.
 */

/** Ein Job, so wie ihn der Worker aus der Tabelle zieht. */
export interface ClaimedJob {
  readonly id: string;
  readonly jobType: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
}

/** Was ein Handler zur Verfuegung hat. */
export interface JobContext {
  readonly db: Database;
  readonly job: ClaimedJob;
  /** Wird beim Herunterfahren ausgeloest - lange Handler sollen darauf hoeren. */
  readonly signal: AbortSignal;
  /** Fuer Meldungen, die im Serverprotokoll landen sollen. */
  readonly log: (message: string) => void;
}

/**
 * Ein Job-Typ: Name, Payload-Pruefung und Verarbeitung.
 *
 * `parsePayload` ist bewusst getrennt von `run`: Eine unbrauchbare Nutzlast ist
 * **nicht** wiederholbar und geht sofort in den Dead-Letter-Zustand, ohne dass
 * ein Aufruf abgesetzt wird.
 */
export interface JobType<TPayload = unknown> {
  readonly type: string;
  /** Wirft `JobPayloadError`, wenn die Nutzlast nicht taugt. */
  parsePayload(raw: unknown): TPayload;
  /** Fuehrt die Arbeit aus. Ein geworfener Fehler entscheidet ueber den Retry. */
  run(payload: TPayload, context: JobContext): Promise<void>;
}

/** Ungueltige Nutzlast - gilt immer als nicht wiederholbar. */
export class JobPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobPayloadError';
  }
}

/** Unbekannter Job-Typ - ebenfalls nicht wiederholbar. */
export class UnknownJobTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownJobTypeError';
  }
}

/**
 * Verzeichnis der Job-Typen.
 *
 * Doppelte Registrierung ist ein Fehler - sonst wuerde ein Arbeitspaket still
 * den Handler eines anderen ueberschreiben.
 */
export class JobHandlerRegistry {
  readonly #types = new Map<string, JobType<never>>();

  register<TPayload>(jobType: JobType<TPayload>): this {
    if (this.#types.has(jobType.type)) {
      throw new Error(
        `Job-Typ "${jobType.type}" ist bereits registriert. Kennungen muessen eindeutig sein.`,
      );
    }
    this.#types.set(jobType.type, jobType as JobType<never>);
    return this;
  }

  /** Alle bekannten Kennungen, sortiert. */
  types(): readonly string[] {
    return [...this.#types.keys()].sort();
  }

  /** Wirft `UnknownJobTypeError`, wenn nichts registriert ist. */
  get(type: string): JobType<never> {
    const found = this.#types.get(type);
    if (found === undefined) {
      throw new UnknownJobTypeError(
        `Unbekannter Job-Typ "${type}". Registriert sind: ${this.types().join(', ') || '(keiner)'}.`,
      );
    }
    return found;
  }
}

/** Ergebnis eines Verarbeitungsdurchlaufs - fuer Tests und Protokoll. */
export interface JobOutcome {
  readonly jobId: string;
  readonly jobType: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly error?: string;
}
