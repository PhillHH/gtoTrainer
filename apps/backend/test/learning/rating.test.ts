import { describe, expect, it } from 'vitest';
import type { LearningSignalClass } from '@gto/shared';
import {
  RATING_BASE_ALPHA,
  foldRating,
  foldRatingSnapshots,
  ratingAlpha,
  snapshotId,
  startOfUtcDay,
} from '../../src/learning/rating.js';
import type { RatingSignal } from '../../src/learning/rating.js';

/**
 * Skill-Ratings je Themenbereich (AP4.T4.5) - reine Funktionen, keine
 * Datenbank.
 */

const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-01-01T09:00:00.000Z');
const at = (day: number, hour = 0): Date =>
  new Date(START.getTime() + day * DAY + hour * 60 * 60 * 1000);

function sig(
  outcome: number,
  signalClass: LearningSignalClass = 'objective',
  day = 0,
  difficulty = 0.5,
): RatingSignal {
  return { outcome, signalClass, difficulty, occurredAt: at(day) };
}

function series(count: number, outcome: number, signalClass: LearningSignalClass = 'objective') {
  return Array.from({ length: count }, (_, i) => sig(outcome, signalClass, i));
}

/** Der Rating-Wert einer Folge, auf drei Stellen gerundet. */
function ratingOf(signals: readonly RatingSignal[]): number {
  return Number((foldRating(signals)?.rating ?? 0).toFixed(3));
}

describe('Rating-Update (AP4.T4.5)', () => {
  it('setzt die erste Beobachtung als Ausgangswert', () => {
    // Ein Startwert von 0 waere doppeldeutig - "keine Daten" und "sehr
    // schlecht" saehen gleich aus.
    expect(ratingOf([sig(0.8)])).toBe(0.8);
    expect(ratingOf([sig(0.25)])).toBe(0.25);
    expect(foldRating([])).toBeNull();
  });

  it('hebt das Rating bei einer Folge guter Ereignisse', () => {
    const verlauf = [1, 2, 3, 5, 10, 20].map((n) => ratingOf(series(n, 1)));

    expect(verlauf).toEqual([1, 1, 1, 1, 1, 1]);

    // Aussagekraeftiger von unten: aus einem schwachen Start heraus.
    const auslauter = [sig(0.2, 'objective', 0), ...series(10, 1).slice(1)];
    const schritte = [1, 3, 5, 8, 11].map((n) => ratingOf(auslauter.slice(0, n)));
    expect(schritte).toEqual([0.2, 0.422, 0.582, 0.744, 0.815]);
    expect(schritte.every((value, i) => i === 0 || value > (schritte[i - 1] as number))).toBe(true);
  });

  it('senkt das Rating bei einer Folge schlechter Ereignisse', () => {
    const folge = [sig(1, 'objective', 0), ...series(10, 0).slice(1)];
    const schritte = [1, 3, 5, 8, 11].map((n) => ratingOf(folge.slice(0, n)));

    expect(schritte).toEqual([1, 0.723, 0.522, 0.321, 0.232]);
    expect(schritte.every((value, i) => i === 0 || value < (schritte[i - 1] as number))).toBe(true);
  });

  it('laesst objektive Signale staerker wirken als KI-Bewertungen', () => {
    // Gleicher Ausgangspunkt, gleiche Folge - nur die Signalklasse
    // unterscheidet sich. Dieselbe Rangfolge wie beim Mastery-Score (T4.3).
    const start = sig(0.2, 'objective', 0);
    const objektiv = [start, ...series(8, 1, 'objective').slice(1)];
    const kiBewertet = [start, ...series(8, 1, 'ai_judged').slice(1)];
    const selbst = [start, ...series(8, 1, 'self_reported').slice(1)];

    expect(ratingOf(objektiv)).toBe(0.744);
    expect(ratingOf(kiBewertet)).toBe(0.536);
    expect(ratingOf(selbst)).toBe(0.354);
    expect(ratingOf(objektiv)).toBeGreaterThan(ratingOf(kiBewertet));
    expect(ratingOf(kiBewertet)).toBeGreaterThan(ratingOf(selbst));
  });

  it('laesst ein schweres Ereignis staerker wirken als ein leichtes', () => {
    const start = sig(0.2, 'objective', 0);
    const leicht = [start, sig(1, 'objective', 1, 0)];
    const schwer = [start, sig(1, 'objective', 1, 1)];

    expect(ratingOf(leicht)).toBe(0.26);
    expect(ratingOf(schwer)).toBe(0.38);
    expect(ratingOf(schwer)).toBeGreaterThan(ratingOf(leicht));
  });

  it('bleibt traege: ein einzelnes schlechtes Ereignis reisst nichts ein', () => {
    const gut = series(12, 1);
    const mitAusrutscher = [...gut, sig(0, 'objective', 12)];

    const vorher = ratingOf(gut);
    const nachher = ratingOf(mitAusrutscher);

    expect(vorher).toBe(1);
    expect(nachher).toBe(0.85);
    // Genau der Abkling-Faktor: 15 % der Luecke, nicht mehr.
    expect(vorher - nachher).toBeCloseTo(RATING_BASE_ALPHA, 6);
  });

  it('gewichtet jede Beobachtung mit Signalklasse und Schwierigkeit', () => {
    expect(ratingAlpha(sig(1, 'objective', 0, 0.5))).toBeCloseTo(0.15, 10);
    expect(ratingAlpha(sig(1, 'objective', 0, 1))).toBeCloseTo(0.225, 10);
    expect(ratingAlpha(sig(1, 'ai_judged', 0, 0.5))).toBeCloseTo(0.075, 10);
    expect(ratingAlpha(sig(1, 'self_reported', 0, 0))).toBeCloseTo(0.015, 10);
  });

  it('haelt das Rating im Bereich 0 bis 1 und zaehlt die Ereignisse', () => {
    const result = foldRating(series(50, 1));
    expect(result?.rating).toBeLessThanOrEqual(1);
    expect(result?.eventCount).toBe(50);
    expect(foldRating(series(50, 0))?.rating).toBeGreaterThanOrEqual(0);
  });

  it('nimmt den Zeitstempel des juengsten Ereignisses, nicht die Systemzeit', () => {
    const result = foldRating(series(3, 1));
    expect(result?.updatedAt.toISOString()).toBe(at(2).toISOString());
  });
});

describe('Verlauf als Snapshots (AP4.T4.5)', () => {
  it('verdichtet auf einen Punkt je Kalendertag', () => {
    // Fuenf Ereignisse an zwei Tagen ergeben zwei Punkte, nicht fuenf.
    const signals: RatingSignal[] = [
      { outcome: 1, signalClass: 'objective', difficulty: 0.5, occurredAt: at(0, 0) },
      { outcome: 0.8, signalClass: 'objective', difficulty: 0.5, occurredAt: at(0, 2) },
      { outcome: 0.6, signalClass: 'objective', difficulty: 0.5, occurredAt: at(0, 5) },
      { outcome: 1, signalClass: 'objective', difficulty: 0.5, occurredAt: at(1, 1) },
      { outcome: 1, signalClass: 'objective', difficulty: 0.5, occurredAt: at(1, 3) },
    ];

    const snapshots = foldRatingSnapshots(signals);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.capturedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(snapshots[1]?.capturedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    // Der Wert eines Tages ist der Stand **am Ende** dieses Tages.
    expect(snapshots[0]?.rating).toBeCloseTo(0.9145, 4);
  });

  it('waechst mit der Zahl der Tage, nicht mit der Zahl der Ereignisse', () => {
    // 600 Ereignisse ueber 30 Tage - zwanzig am Tag.
    const viele: RatingSignal[] = Array.from({ length: 600 }, (_, i) => ({
      outcome: i % 4 === 0 ? 0 : 1,
      signalClass: 'objective' as const,
      difficulty: 0.5,
      occurredAt: new Date(START.getTime() + Math.floor(i / 20) * DAY + (i % 20) * 30 * 60_000),
    }));

    expect(foldRatingSnapshots(viele)).toHaveLength(30);
  });

  it('liefert ohne Ereignisse keinen Punkt', () => {
    expect(foldRatingSnapshots([])).toEqual([]);
  });

  it('legt den Tagesschnitt auf UTC-Mitternacht', () => {
    expect(startOfUtcDay(new Date('2026-03-15T23:59:59.999Z')).toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
    expect(startOfUtcDay(new Date('2026-03-16T00:00:00.000Z')).toISOString()).toBe(
      '2026-03-16T00:00:00.000Z',
    );
  });
});

describe('Deterministische Snapshot-IDs (AP4.T4.5)', () => {
  it('erzeugt aus Themenbereich und Tag immer dieselbe ID', () => {
    const tag = new Date('2026-01-01T00:00:00.000Z');

    expect(snapshotId('flop-spiel', tag)).toBe(snapshotId('flop-spiel', tag));
    expect(snapshotId('flop-spiel', tag)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('unterscheidet Themenbereiche und Tage', () => {
    const tag = new Date('2026-01-01T00:00:00.000Z');
    const anderertag = new Date('2026-01-02T00:00:00.000Z');

    expect(snapshotId('flop-spiel', tag)).not.toBe(snapshotId('turn-spiel', tag));
    expect(snapshotId('flop-spiel', tag)).not.toBe(snapshotId('flop-spiel', anderertag));
  });
});
