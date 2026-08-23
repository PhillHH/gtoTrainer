import { isLlmErrorRetryable } from '@gto/shared';
import type { LlmErrorKind, LlmErrorPayload, LlmProviderId } from '@gto/shared';

/**
 * Fehler eines LLM-Adapters in der Form, die der Vertrag aus T2.1 vorgibt.
 *
 * Beide Adapter (CLI in T2.2, API in T2.3) werfen ausschliesslich diesen Typ,
 * damit Job-Worker und UI nicht zwischen Providern unterscheiden muessen.
 */
export class LlmError extends Error implements LlmErrorPayload {
  readonly kind: LlmErrorKind;
  readonly provider: LlmProviderId;
  readonly retryAfterMs?: number;

  constructor(payload: LlmErrorPayload, options?: { cause?: unknown }) {
    super(payload.message, options);
    this.name = 'LlmError';
    this.kind = payload.kind;
    this.provider = payload.provider;
    if (payload.retryAfterMs !== undefined) this.retryAfterMs = payload.retryAfterMs;
  }

  /** Darf dieser Fehler wiederholt werden? Antwort kommt aus der Taxonomie. */
  get retryable(): boolean {
    return isLlmErrorRetryable(this.kind);
  }
}

/** Type-Guard, damit Aufrufer nicht auf `instanceof` ueber Modulgrenzen bauen. */
export function isLlmError(value: unknown): value is LlmError {
  return value instanceof LlmError;
}
