import type { JobEvent } from '@gto/shared';

/**
 * Prozessinterner Ereignisbus fuer Job-Statusaenderungen (AP2.T2.5).
 *
 * Bewusst ohne Broker: Der Worker laeuft im selben Prozess wie der
 * HTTP-Server ([ADR-0026](../../../../docs/DECISIONS.md)), also genuegt eine
 * Menge von Zuhoerern. Wuerde der Worker jemals in einen eigenen Prozess
 * wandern, traete hier `LISTEN/NOTIFY` an diese Stelle - die Schnittstelle
 * bliebe dieselbe.
 *
 * Der Bus haelt bewusst **keine** Historie: Ein spaet verbundener Client sieht
 * nur, was ab jetzt passiert. Den Verlauf liefert `llm_call_log`.
 */
export type JobEventListener = (event: JobEvent) => void;

export class JobEventBus {
  readonly #listeners = new Set<JobEventListener>();
  /** Obergrenze, damit haengende Verbindungen nicht unbegrenzt wachsen. */
  readonly #maxListeners: number;

  constructor(maxListeners = 50) {
    this.#maxListeners = maxListeners;
  }

  /** Wie viele Zuhoerer gerade angemeldet sind. */
  get size(): number {
    return this.#listeners.size;
  }

  /**
   * Meldet einen Zuhoerer an und liefert die Abmeldung zurueck.
   * Wirft, wenn die Obergrenze erreicht ist - lieber eine klare Absage als ein
   * langsam volllaufender Prozess.
   */
  subscribe(listener: JobEventListener): () => void {
    if (this.#listeners.size >= this.#maxListeners) {
      throw new Error(
        `Es sind bereits ${this.#maxListeners} Statuskanaele offen. Weitere werden abgelehnt.`,
      );
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Verteilt ein Ereignis. Ein fehlerhafter Zuhoerer bremst die anderen nicht. */
  publish(event: JobEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Eine kaputte Verbindung darf den Worker nicht beeinflussen.
        this.#listeners.delete(listener);
      }
    }
  }

  /** Beim Herunterfahren: alle Zuhoerer loesen. */
  clear(): void {
    this.#listeners.clear();
  }
}
