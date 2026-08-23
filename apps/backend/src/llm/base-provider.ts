import type { LLMProvider, LlmProviderId, LlmRequest, LlmResponse } from '@gto/shared';
import { Semaphore, withRetry } from './concurrency.js';
import type { RetryPolicy } from './concurrency.js';
import { LlmError, isLlmError } from './errors.js';

/**
 * Gemeinsame Hülle für **alle** Adapter.
 *
 * Nebenläufigkeitslimit, Retry-Strategie und die Vorprüfung der Anfrage liegen
 * hier und **nur** hier - sonst müsste jeder neue Adapter sie nachbauen und
 * könnte dabei von der Fehler-Taxonomie abweichen. Ein Adapter implementiert
 * ausschliesslich `attempt()`: einen einzelnen Versuch.
 */

/** Grenzwerte, die für jeden Adapter gelten. */
export interface ProviderLimits {
  readonly maxConcurrency: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly retryTotalBudgetMs: number;
}

export abstract class GuardedProvider implements LLMProvider {
  abstract readonly id: LlmProviderId;

  readonly #semaphore: Semaphore;
  readonly #policy: RetryPolicy;
  readonly #defaultTimeoutMs: number;

  protected constructor(limits: ProviderLimits) {
    this.#semaphore = new Semaphore(limits.maxConcurrency);
    this.#defaultTimeoutMs = limits.timeoutMs;
    this.#policy = {
      maxAttempts: limits.maxAttempts,
      baseDelayMs: limits.retryBaseDelayMs,
      maxDelayMs: limits.retryMaxDelayMs,
      totalBudgetMs: limits.retryTotalBudgetMs,
    };
  }

  /** Nur fuer Diagnose und Tests: aktuelle Auslastung der Semaphore. */
  get inFlight(): number {
    return this.#semaphore.inFlight;
  }

  async complete<TJson = unknown>(request: LlmRequest): Promise<LlmResponse<TJson>> {
    this.#assertRequest(request);
    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs;

    const response = await withRetry(
      () => this.#semaphore.run(() => this.attempt(request, timeoutMs)),
      this.#policy,
      {
        // Einzige Quelle der Wahrheit ist die Taxonomie aus T2.1. Damit haben
        // beide Adapter dieselbe Retry-Einstufung.
        isRetryable: (error) => isLlmError(error) && error.retryable,
        retryAfterMs: (error) => (isLlmError(error) ? error.retryAfterMs : undefined),
      },
    );

    return response as LlmResponse<TJson>;
  }

  /** Ein einzelner Aufruf ohne Retry und ohne Semaphore. */
  protected abstract attempt(request: LlmRequest, timeoutMs: number): Promise<LlmResponse>;

  /** Bequemer Fehler-Konstruktor für Unterklassen. */
  protected fail(kind: LlmError['kind'], message: string, retryAfterMs?: number): LlmError {
    return new LlmError(
      retryAfterMs === undefined
        ? { kind, provider: this.id, message }
        : { kind, provider: this.id, message, retryAfterMs },
    );
  }

  /** Frueher Abbruch bei offensichtlich unbrauchbaren Anfragen. */
  #assertRequest(request: LlmRequest): void {
    if (request.messages.length === 0) {
      throw this.fail('invalid', 'Die Anfrage enthaelt keine Nachricht.');
    }
    if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1) {
      throw this.fail(
        'invalid',
        `maxTokens muss eine positive Ganzzahl sein, ist: ${String(request.maxTokens)}.`,
      );
    }
  }
}
