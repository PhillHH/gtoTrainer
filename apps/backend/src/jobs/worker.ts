import type { JobEvent, JobStatus } from '@gto/shared';
import type { Database } from '../db/client.js';
import { isLlmError } from '../llm/errors.js';
import type { JobEventBus } from './events.js';
import { claimNextJob, markDead, markDone, scheduleRetry } from './queue.js';
import { JobPayloadError, UnknownJobTypeError } from './types.js';
import type { ClaimedJob, JobHandlerRegistry, JobOutcome, JobType } from './types.js';

/**
 * Der Job-Worker (AP2.T2.5).
 *
 * Laeuft als Schleife **im Backend-Prozess** ([ADR-0026](../../../../docs/DECISIONS.md)).
 * Er kennt keine Fachlichkeit, sondern nur die {@link JobHandlerRegistry}, und
 * er entscheidet ueber Wiederholung allein anhand der Fehler-Taxonomie aus
 * T2.1: nur was dort als wiederholbar gilt, wird erneut eingeplant.
 *
 * Die Nebenlaeufigkeit gegenueber der KI liegt weiterhin in der Semaphore der
 * Adapter (T2.2). Der Worker holt bewusst **einen** Job je Durchlauf; mehr
 * Parallelitaet wuerde die Semaphore nur zu einer Warteschlange davor machen.
 */

export interface WorkerOptions {
  readonly db: Database;
  readonly handlers: JobHandlerRegistry;
  readonly events: JobEventBus;
  /** Wartezeit zwischen zwei Durchlaeufen, wenn nichts zu tun war. */
  readonly pollIntervalMs: number;
  /** Ab wann ein `running`-Job als verwaist gilt. */
  readonly staleAfterMs: number;
  /** Basiswartezeit des Backoffs bei wiederholbaren Fehlern. */
  readonly retryBaseDelayMs: number;
  /** Obergrenze einer einzelnen Backoff-Wartezeit. */
  readonly retryMaxDelayMs: number;
  readonly log?: (message: string) => void;
  /** Nur fuer Tests: ersetzt `Math.random` fuer den Jitter. */
  readonly random?: () => number;
}

export class JobWorker {
  readonly #options: WorkerOptions;
  readonly #log: (message: string) => void;
  #controller = new AbortController();
  #running = false;
  #loop: Promise<void> | undefined;

  constructor(options: WorkerOptions) {
    this.#options = options;
    this.#log = options.log ?? (() => undefined);
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /** Startet die Schleife. Kehrt sofort zurueck. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#controller = new AbortController();
    this.#loop = this.#run();
    this.#log('Job-Worker gestartet.');
  }

  /** Bricht laufende Arbeit ab und wartet auf das Ende der Schleife. */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#controller.abort();
    await this.#loop;
    this.#loop = undefined;
    this.#log('Job-Worker gestoppt.');
  }

  /**
   * Verarbeitet **einen** faelligen Job, falls es einen gibt.
   *
   * Oeffentlich, weil Tests damit deterministisch arbeiten koennen, ohne auf
   * eine Schleife zu warten.
   */
  async runOnce(): Promise<JobOutcome | undefined> {
    const job = await claimNextJob(this.#options.db, {
      staleAfterMs: this.#options.staleAfterMs,
    });
    if (job === undefined) return undefined;

    this.#emit(job, 'running');
    return this.#process(job);
  }

  async #run(): Promise<void> {
    while (this.#running) {
      let didWork = false;
      try {
        didWork = (await this.runOnce()) !== undefined;
      } catch (error) {
        // Ein Fehler in der Schleife selbst (z. B. DB kurz weg) darf den
        // Worker nicht beenden.
        this.#log(`Job-Worker: Durchlauf fehlgeschlagen: ${describe(error)}`);
      }
      // Gab es Arbeit, sofort weiter - sonst warten.
      if (!didWork) await this.#sleep(this.#options.pollIntervalMs);
    }
  }

  async #process(job: ClaimedJob): Promise<JobOutcome> {
    let prepared: { type: JobType<never>; payload: never };
    try {
      const type = this.#options.handlers.get(job.jobType);
      prepared = { type, payload: type.parsePayload(job.payload) as never };
    } catch (error) {
      // Unbrauchbare Nutzlast oder unbekannter Typ: nicht wiederholbar, also
      // sofort Dead-Letter - ohne dass je ein Aufruf abgesetzt wurde.
      return this.#toDead(job, error);
    }

    try {
      await prepared.type.run(prepared.payload, {
        db: this.#options.db,
        job,
        signal: this.#controller.signal,
        log: this.#log,
      });
    } catch (error) {
      return this.#onFailure(job, error);
    }

    await markDone(this.#options.db, job.id);
    this.#emit(job, 'done');
    return { jobId: job.id, jobType: job.jobType, status: 'done', attempts: job.attempts };
  }

  /** Entscheidet zwischen erneutem Versuch und Dead-Letter. */
  async #onFailure(job: ClaimedJob, error: unknown): Promise<JobOutcome> {
    if (!isRetryable(error) || job.attempts >= job.maxAttempts) {
      return this.#toDead(job, error);
    }

    const nextAttemptAt = new Date(Date.now() + this.#backoffMs(job.attempts, error));
    const message = describe(error);
    await scheduleRetry(this.#options.db, job.id, { nextAttemptAt, error: message });

    this.#emit(job, 'queued', {
      error: message,
      nextAttemptAt: nextAttemptAt.toISOString(),
      ...(isLlmError(error) ? { errorKind: error.kind } : {}),
    });
    this.#log(
      `Job ${job.id} (${job.jobType}) fehlgeschlagen, Versuch ${job.attempts}/${job.maxAttempts}; ` +
        `naechster Versuch ab ${nextAttemptAt.toISOString()}.`,
    );
    return {
      jobId: job.id,
      jobType: job.jobType,
      status: 'queued',
      attempts: job.attempts,
      error: message,
    };
  }

  async #toDead(job: ClaimedJob, error: unknown): Promise<JobOutcome> {
    const message = describe(error);
    await markDead(this.#options.db, job.id, message);
    this.#emit(job, 'dead', {
      error: message,
      ...(isLlmError(error) ? { errorKind: error.kind } : {}),
    });
    this.#log(`Job ${job.id} (${job.jobType}) in Dead-Letter: ${message}`);
    return {
      jobId: job.id,
      jobType: job.jobType,
      status: 'dead',
      attempts: job.attempts,
      error: message,
    };
  }

  /**
   * Exponentieller Backoff mit Streuung - dieselbe Form wie in T2.2. Nennt der
   * Fehler eine Mindestwartezeit (Kontingent-Limit), gilt diese.
   */
  #backoffMs(attempt: number, error: unknown): number {
    const random = this.#options.random ?? Math.random;
    const exponential = Math.min(
      this.#options.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1),
      this.#options.retryMaxDelayMs,
    );
    const jittered = Math.round(exponential * (0.5 + 0.5 * random()));
    const retryAfter = isLlmError(error) ? (error.retryAfterMs ?? 0) : 0;
    return Math.max(jittered, retryAfter);
  }

  #emit(job: ClaimedJob, status: JobStatus, extra: Partial<JobEvent> = {}): void {
    this.#options.events.publish({
      jobId: job.id,
      jobType: job.jobType,
      status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      at: new Date().toISOString(),
      ...extra,
    });
  }

  /** Wartet, laesst sich aber vom Abbruchsignal sofort unterbrechen. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.#controller.signal;
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      signal.addEventListener('abort', finish, { once: true });

      function finish(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      }
    });
  }
}

/**
 * Wiederholen ja oder nein - einzige Quelle ist die Taxonomie aus T2.1.
 *
 * Alles, was kein `LlmError` ist (Programmfehler, unbekannter Job-Typ,
 * kaputte Nutzlast), gilt als **nicht** wiederholbar: Bei unklarer Ursache
 * wird nicht blind wiederholt.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof JobPayloadError || error instanceof UnknownJobTypeError) return false;
  return isLlmError(error) && error.retryable;
}

function describe(error: unknown): string {
  if (isLlmError(error)) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
