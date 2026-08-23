/**
 * Nebenlaeufigkeitsbegrenzung und Wiederholstrategie.
 *
 * Beides ist bewusst hier und nicht im Provider: AP3 wird hunderte
 * Chart-Aufrufe absetzen, und dieselbe Begrenzung soll spaeter auch der
 * Host-Runner nutzen koennen.
 */

/** Zaehlende Semaphore mit FIFO-Warteschlange. */
export class Semaphore {
  readonly limit: number;
  #inFlight = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Semaphore-Limit muss >= 1 sein, ist: ${limit}`);
    }
    this.limit = limit;
  }

  /** Wie viele Aufgaben gerade laufen. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Wie viele Aufgaben auf einen freien Platz warten. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /** Fuehrt `task` aus, sobald ein Platz frei ist. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#inFlight < this.limit) {
      this.#inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiting.push(() => {
        this.#inFlight += 1;
        resolve();
      });
    });
  }

  #release(): void {
    this.#inFlight -= 1;
    const next = this.#waiting.shift();
    if (next !== undefined) next();
  }
}

export interface RetryPolicy {
  /** Gesamtzahl der Versuche, inklusive des ersten. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Harte Obergrenze fuer alle Versuche zusammen, inklusive Wartezeiten. */
  readonly totalBudgetMs: number;
}

export interface RetryHooks {
  /** Entscheidet, ob dieser Fehler ueberhaupt wiederholt werden darf. */
  readonly isRetryable: (error: unknown) => boolean;
  /** Vom Fehler vorgegebene Mindestwartezeit, falls vorhanden. */
  readonly retryAfterMs?: (error: unknown) => number | undefined;
  /** Nur fuer Tests: ersetzt `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Nur fuer Tests: ersetzt `Math.random` fuer den Jitter. */
  readonly random?: () => number;
  /** Nur fuer Tests: ersetzt `Date.now`. */
  readonly now?: () => number;
}

/**
 * Fuehrt `task` aus und wiederholt bei wiederholbaren Fehlern mit
 * exponentiellem Backoff plus Streuung.
 *
 * Nicht wiederholbare Fehler (Auth, Invalid, Parse) fliegen sofort durch -
 * genau dafuer gibt es die Taxonomie aus T2.1.
 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks,
): Promise<T> {
  const now = hooks.now ?? (() => Date.now());
  const sleep = hooks.sleep ?? defaultSleep;
  const random = hooks.random ?? Math.random;
  const startedAt = now();

  let attempt = 1;
  for (;;) {
    try {
      return await task(attempt);
    } catch (error) {
      const isLast = attempt >= policy.maxAttempts;
      if (isLast || !hooks.isRetryable(error)) throw error;

      const delay = nextDelay(attempt, policy, random, hooks.retryAfterMs?.(error));
      const elapsed = now() - startedAt;
      // Wiederholen nur, wenn der naechste Versuch noch ins Gesamtbudget passt.
      if (elapsed + delay >= policy.totalBudgetMs) throw error;

      await sleep(delay);
      attempt += 1;
    }
  }
}

/** Exponentieller Backoff mit voller Streuung, gedeckelt auf `maxDelayMs`. */
function nextDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number,
  retryAfterMs: number | undefined,
): number {
  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  // Volle Streuung verhindert, dass viele parallele Aufrufe im Gleichtakt
  // erneut anklopfen.
  const jittered = Math.round(exponential * (0.5 + 0.5 * random()));
  return Math.max(jittered, retryAfterMs ?? 0);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
