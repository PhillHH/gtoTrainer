import { createHash } from 'node:crypto';
import type { LearningSignalClass } from '@gto/shared';
import { SCORE_WEIGHTS, difficultyFactor } from './mastery.js';

/**
 * Skill-Ratings je Themenbereich (AP4.T4.5) - **reine Funktionen**.
 *
 * Die zweite Dimension neben dem Kapitelfortschritt: Wo steht der Lernende
 * fachlich? Ein Rating je Themenbereich aus T3.2, fortgeschrieben als
 * gewichteter gleitender Durchschnitt (EWMA) ueber den Ereignisstrom.
 *
 * Die Determinismus-Regel aus T4.2 gilt unveraendert: kein `Date.now()`, kein
 * Zufall. Reihenfolge und Zeitpunkte kommen aus den Ereignissen.
 */

/* -------------------------------------------------------------------------
 * Konstanten - begruendet in ADR-0044
 * ---------------------------------------------------------------------- */

/**
 * Grundgewicht einer einzelnen Beobachtung im gleitenden Durchschnitt.
 *
 * Der Abkling-Faktor bestimmt die Traegheit: Ein neues Ereignis zieht das
 * Rating um `alpha` des Abstands zu seinem Ergebnis. Bei 0,15 bewegt ein
 * einzelnes objektives Ereignis mittlerer Schwierigkeit das Rating um 15 % der
 * Luecke - spuerbar, aber kein Einbruch. Nach zehn Beobachtungen zaehlt die
 * aelteste noch mit 0,85^10 ≈ 20 %, nach zwanzig mit 4 %.
 *
 * Zu gross gewaehlt, und ein schlechter Tag reisst das Rating ein; zu klein,
 * und echte Fortschritte werden monatelang nicht sichtbar.
 */
export const RATING_BASE_ALPHA = 0.15;

/* -------------------------------------------------------------------------
 * Eingaben
 * ---------------------------------------------------------------------- */

/** Ein Signal, wie das Rating es sieht - Konzeptbezug ist hier schon aufgeloest. */
export interface RatingSignal {
  readonly signalClass: LearningSignalClass;
  /** Ergebnis 0 bis 1 - dieselbe Groesse wie beim Mastery-Score. */
  readonly outcome: number;
  /** Schwierigkeit 0 bis 1; kommt aus dem Ereignis, wird nie geraten. */
  readonly difficulty: number;
  readonly occurredAt: Date;
}

export interface RatingProjection {
  readonly rating: number;
  readonly eventCount: number;
  readonly updatedAt: Date;
}

/**
 * Das Gewicht einer einzelnen Beobachtung.
 *
 * **Dieselben Signalgewichte und dasselbe Schwierigkeitsmass wie beim
 * Mastery-Score** (T4.3). Das ist keine Bequemlichkeit: Es waere verwirrend,
 * wenn Mastery und Rating auf dasselbe Ereignis gegenlaeufig reagierten - der
 * Nutzer saehe zwei Zahlen, die sich widersprechen, und keine Erklaerung dafuer.
 *
 * Nicht uebernommen wird die **Fehler-Asymmetrie** aus T4.3. Dort geht es um
 * ein einzelnes Konzept, und ein Fehler ist dort ein starker Beleg fuer genau
 * diese Luecke. Ein Skill-Rating mittelt ueber einen ganzen Themenbereich mit
 * dreizehn bis einunddreissig Konzepten; ein einzelner Fehler sagt darueber
 * deutlich weniger aus. Ihn hier zusaetzlich zu verstaerken wuerde der
 * geforderten Traegheit direkt zuwiderlaufen.
 */
export function ratingAlpha(signal: RatingSignal): number {
  const alpha =
    RATING_BASE_ALPHA * SCORE_WEIGHTS[signal.signalClass] * difficultyFactor(signal.difficulty);
  return Math.min(1, Math.max(0, alpha));
}

/**
 * Rating eines Themenbereichs aus seiner Signalfolge - **reine Funktion**.
 *
 * ```
 *   rating₁ = outcome₁                                  (erste Beobachtung)
 *   ratingᵢ = ratingᵢ₋₁ + αᵢ · (outcomeᵢ − ratingᵢ₋₁)    (danach)
 *   αᵢ = 0,15 · Signalgewicht · Schwierigkeit
 * ```
 *
 * Die **erste** Beobachtung setzt das Rating, statt es von 0 aus anzuziehen.
 * Ein Startwert von 0 waere doppeldeutig - er hiesse zugleich "keine Daten"
 * und "sehr schlecht" - und ein EWMA von 0 aus braeuchte ein Dutzend
 * Ereignisse, nur um den ersten Messwert einzuholen. Wie belastbar der Wert
 * ist, sagt `eventCount`, nicht das Rating selbst.
 *
 * `null` = im Themenbereich gab es nichts; die Achse bleibt unangetastet.
 */
export function foldRating(signals: readonly RatingSignal[]): RatingProjection | null {
  if (signals.length === 0) return null;

  let rating = clampRatio((signals[0] as RatingSignal).outcome);
  for (let i = 1; i < signals.length; i += 1) {
    const signal = signals[i] as RatingSignal;
    rating += ratingAlpha(signal) * (clampRatio(signal.outcome) - rating);
  }

  const last = signals[signals.length - 1] as RatingSignal;
  return {
    // Runden wie in `mastery.ts`: haelt das Ergebnis unabhaengig von der
    // Summationsreihenfolge und damit den Replay-Vergleich sauber.
    rating: roundStored(clampRatio(rating)),
    eventCount: signals.length,
    updatedAt: last.occurredAt,
  };
}

/* -------------------------------------------------------------------------
 * Verlauf: ein Punkt je Kalendertag
 * ---------------------------------------------------------------------- */

/** Ein verdichteter Verlaufspunkt. */
export interface RatingSnapshot {
  /** Deterministische ID - siehe {@link snapshotId}. */
  readonly id: string;
  /** UTC-Mitternacht des Tages, den dieser Punkt zusammenfasst. */
  readonly capturedAt: Date;
  readonly rating: number;
}

/** UTC-Mitternacht des Tages, in dem ein Zeitpunkt liegt. */
export function startOfUtcDay(moment: Date): Date {
  return new Date(
    Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * Der Verlauf einer Achse: **ein Punkt je Kalendertag**, nicht je Ereignis.
 *
 * Die Verdichtung ist noetig, weil der Verlauf sonst unbegrenzt waechst - bei
 * intensiver Nutzung waeren das Tausende Zeilen je Themenbereich im Jahr, fuer
 * eine Grafik, die ohnehin nur Wochen aufloest. Ein Tag ist die feinste
 * Aufloesung, die eine Entwicklungskurve in AP6 braucht; damit sind es
 * hoechstens 12 × 365 Zeilen im Jahr, und das dauerhaft.
 *
 * Der Wert eines Tages ist der Stand **am Ende** dieses Tages, also nach dem
 * letzten Ereignis. Ein Zwischenstand mitten am Tag ist keine Auskunft, die
 * jemand braucht.
 */
export function foldRatingSnapshots(signals: readonly RatingSignal[]): readonly RatingSnapshot[] {
  if (signals.length === 0) return [];

  const byDay = new Map<number, number>();
  let rating = clampRatio((signals[0] as RatingSignal).outcome);
  byDay.set(startOfUtcDay((signals[0] as RatingSignal).occurredAt).getTime(), rating);

  for (let i = 1; i < signals.length; i += 1) {
    const signal = signals[i] as RatingSignal;
    rating += ratingAlpha(signal) * (clampRatio(signal.outcome) - rating);
    byDay.set(startOfUtcDay(signal.occurredAt).getTime(), roundStored(clampRatio(rating)));
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, value]) => {
      const capturedAt = new Date(day);
      return { id: '', capturedAt, rating: roundStored(clampRatio(value)) };
    });
}

/**
 * Feste Namensraum-UUID fuer die Verlaufspunkte. Beliebig gewaehlt, aber
 * unveraenderlich - sie ist Teil des Schluessels.
 */
const SNAPSHOT_NAMESPACE = '6f2a1c58-7e21-4a2b-9b3d-5c8f0a1d4e77';

/**
 * Deterministische ID eines Verlaufspunkts aus Themenbereich und Tag.
 *
 * Klingt nach Detail, ist aber Pflicht: `gen_random_uuid()` erzeugte beim
 * Replay andere Schluessel als beim inkrementellen Lauf, und der Vergleich
 * "Replay == inkrementell" aus T4.2 schluege fehl - bei inhaltlich identischen
 * Zeilen. Dieselbe Ueberlegung wie bei `error_log.id = event_id` (ADR-0040).
 *
 * Verfahren: UUID Version 5 (SHA-1 ueber Namensraum und Name), wie in RFC 4122
 * beschrieben. Zwanzig Zeilen eigener Code statt einer Abhaengigkeit.
 */
export function snapshotId(topicArea: string, capturedAt: Date): string {
  const namespaceBytes = Buffer.from(SNAPSHOT_NAMESPACE.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(`${topicArea}|${capturedAt.toISOString()}`, 'utf8');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, nameBytes]))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5 und RFC-4122-Variante in die dafuer vorgesehenen Bits schreiben.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/* -------------------------------------------------------------------------
 * Kleinkram
 * ---------------------------------------------------------------------- */

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function roundStored(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
