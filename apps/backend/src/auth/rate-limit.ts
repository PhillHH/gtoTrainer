/**
 * Rate-Limit fuer den Login-Endpunkt.
 *
 * Bewusst ohne Zusatz-Dependency (siehe ADR-0010): Gezaehlt werden nur
 * **fehlgeschlagene** Versuche je Schluessel. Generische Rate-Limit-Plugins
 * zaehlen jeden Request und wuerden auch erfolgreiche Logins blockieren - genau
 * das soll laut Anforderung nicht passieren.
 *
 * Der Zaehler liegt im Prozessspeicher. Fuer einen Single-User-Dienst mit einer
 * Backend-Instanz genuegt das; bei mehreren Instanzen muesste der Zaehler in
 * die Datenbank oder einen gemeinsamen Cache wandern.
 */

export interface RateLimitOptions {
  /** Erlaubte Fehlversuche innerhalb des Zeitfensters. */
  readonly maxAttempts: number;
  /** Laenge des Zeitfensters in Millisekunden. */
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Verbleibende Fehlversuche vor der Sperre. */
  readonly remaining: number;
  /** Sekunden bis zur Freigabe - fuer den `Retry-After`-Header. */
  readonly retryAfterSeconds: number;
}

interface Bucket {
  failures: number;
  /** Zeitpunkt, an dem das Fenster endet. */
  resetAt: number;
}

/**
 * Zaehlt Fehlversuche pro Schluessel in einem gleitend zuruecksetzenden
 * Zeitfenster.
 */
export class LoginRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #options: RateLimitOptions;

  constructor(options: RateLimitOptions) {
    this.#options = options;
  }

  /** Entfernt abgelaufene Eintraege, damit die Map nicht unbegrenzt waechst. */
  #prune(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now) this.#buckets.delete(key);
    }
  }

  /** Prueft, ob ein weiterer Versuch erlaubt ist - ohne ihn zu zaehlen. */
  check(key: string, now: number = Date.now()): RateLimitDecision {
    const bucket = this.#buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      return {
        allowed: true,
        remaining: this.#options.maxAttempts,
        retryAfterSeconds: 0,
      };
    }

    const allowed = bucket.failures < this.#options.maxAttempts;
    return {
      allowed,
      remaining: Math.max(0, this.#options.maxAttempts - bucket.failures),
      retryAfterSeconds: allowed ? 0 : Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  /** Verbucht einen Fehlversuch. */
  registerFailure(key: string, now: number = Date.now()): RateLimitDecision {
    this.#prune(now);

    const existing = this.#buckets.get(key);
    const bucket =
      existing && existing.resetAt > now
        ? existing
        : { failures: 0, resetAt: now + this.#options.windowMs };

    bucket.failures += 1;
    this.#buckets.set(key, bucket);

    return this.check(key, now);
  }

  /**
   * Setzt den Zaehler zurueck. Wird nach erfolgreichem Login aufgerufen, damit
   * frueher gescheiterte Versuche einen legitimen Benutzer nicht nachtraeglich
   * aussperren.
   */
  reset(key: string): void {
    this.#buckets.delete(key);
  }

  /** Nur fuer Tests. */
  clear(): void {
    this.#buckets.clear();
  }
}
