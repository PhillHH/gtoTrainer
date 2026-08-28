import { describe, expect, it } from 'vitest';
import type { LearningEventSource, LearningSignalClass, ReviewQueueOrigin } from '@gto/shared';
import {
  EASE_MAX,
  EASE_MIN,
  EASE_START,
  INITIAL_REVIEW_STATE,
  LAPSE_DELAY_MINUTES,
  MAX_INTERVAL_DAYS,
  easeDelta,
  overdueDays,
  prioritizeReviews,
  reviewOrigin,
  scheduleReview,
} from '../../src/learning/review.js';
import type { ReviewCandidate, ReviewState } from '../../src/learning/review.js';

/**
 * Intervalle, Ease, Rueckfaelle und Priorisierung (AP4.T4.4).
 *
 * Alles reine Funktionen, keine Datenbank. Was daraus folgt - wann ein Konzept
 * wiederkommt -, entscheidet ueber den Nutzen des ganzen Werkzeugs; deshalb
 * liegt hier der Schwerpunkt.
 */

const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-01-01T00:00:00.000Z');
const at = (day: number): Date => new Date(START.getTime() + day * DAY);

/** Eine gelungene Wiederholung, standardmaessig objektiv belegt. */
function pass(day: number, signalClass: LearningSignalClass = 'objective') {
  return { outcome: 1, signalClass, occurredAt: at(day) };
}

/** Eine misslungene Wiederholung. */
function fail(day: number, outcome = 0, signalClass: LearningSignalClass = 'objective') {
  return { outcome, signalClass, occurredAt: at(day) };
}

describe('Ease-Uebersetzung (AP4.T4.4)', () => {
  it('trifft die Stuetzstellen von SM-2 exakt', () => {
    // Dieselbe Parabel wie im Original, nur auf der Achse 0..1 statt 0..5.
    expect(easeDelta(1)).toBeCloseTo(0.1, 10); // q = 5
    expect(easeDelta(0.8)).toBeCloseTo(0, 10); // q = 4
    expect(easeDelta(0.6)).toBeCloseTo(-0.14, 10); // q = 3
    expect(easeDelta(0.4)).toBeCloseTo(-0.32, 10); // q = 2
    expect(easeDelta(0)).toBeCloseTo(-0.8, 10); // q = 0
  });
});

describe('Intervallwachstum (AP4.T4.4)', () => {
  it('vergroessert das Intervall ueber aufeinanderfolgende Erfolge nachvollziehbar', () => {
    let state = INITIAL_REVIEW_STATE;
    const intervals: number[] = [];
    const eases: number[] = [];
    let day = 0;

    for (let i = 0; i < 6; i += 1) {
      state = scheduleReview(state, pass(day));
      intervals.push(state.intervalDays);
      eases.push(state.easeFactor);
      day += state.intervalDays;
    }

    // 1 und 6 sind die Lernschritte aus SM-2, danach greift der Ease-Faktor.
    expect(intervals).toEqual([1, 6, 17, 49, 147, 365]);
    expect(eases).toEqual([2.6, 2.7, 2.8, 2.9, 3, 3]);
  });

  it('setzt die Faelligkeit aus dem Ereigniszeitpunkt, nicht aus der Systemzeit', () => {
    const state = scheduleReview(INITIAL_REVIEW_STATE, pass(0));

    expect(state.dueAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(state.lastReviewedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('deckelt das Intervall bei einem Jahr', () => {
    let state: ReviewState = { ...INITIAL_REVIEW_STATE, repetitions: 5, intervalDays: 300 };
    state = scheduleReview(state, pass(0));

    expect(state.intervalDays).toBe(MAX_INTERVAL_DAYS);
  });

  it('laesst ein schwaches Signal das Intervall nur wenig strecken', () => {
    // Derselbe Ausgangszustand, derselbe Erfolg - einmal objektiv belegt,
    // einmal nur selbst eingeschaetzt. Wer sich selbst bescheinigt, es zu
    // koennen, kauft sich damit keine lange Pause.
    const base: ReviewState = { ...INITIAL_REVIEW_STATE, repetitions: 3, intervalDays: 10 };

    const objektiv = scheduleReview(base, pass(0, 'objective'));
    const selbst = scheduleReview(base, pass(0, 'self_reported'));

    expect(objektiv.intervalDays).toBe(26);
    expect(selbst.intervalDays).toBe(13);
    expect(objektiv.intervalDays).toBeGreaterThan(selbst.intervalDays);
  });
});

describe('Ease-Grenzen (AP4.T4.4)', () => {
  it('bleibt auch nach vielen Erfolgen unter der Obergrenze', () => {
    let state = INITIAL_REVIEW_STATE;
    for (let i = 0; i < 30; i += 1) state = scheduleReview(state, pass(i));

    expect(state.easeFactor).toBe(EASE_MAX);
    expect(state.easeFactor).toBeLessThanOrEqual(EASE_MAX);
  });

  it('bleibt auch nach vielen Fehlern ueber der Untergrenze', () => {
    let state = INITIAL_REVIEW_STATE;
    for (let i = 0; i < 30; i += 1) state = scheduleReview(state, fail(i));

    expect(state.easeFactor).toBe(EASE_MIN);
    expect(state.easeFactor).toBeGreaterThanOrEqual(EASE_MIN);
    // Und das Intervall kollabiert trotzdem nicht auf null Tage im Kreis:
    // In der Lernphase bleibt es beim Ein-Tages-Schritt.
    expect(state.intervalDays).toBe(1);
  });
});

describe('Rueckfall-Behandlung (AP4.T4.4)', () => {
  it('setzt ein langes Intervall nach einem Rueckfall deutlich zurueck', () => {
    // Erst hochlaufen lassen: fuenf Erfolge ergeben ein Intervall von 147 Tagen.
    let state = INITIAL_REVIEW_STATE;
    let day = 0;
    for (let i = 0; i < 5; i += 1) {
      state = scheduleReview(state, pass(day));
      day += state.intervalDays;
    }
    expect(state.intervalDays).toBe(147);
    expect(state.easeFactor).toBe(3);
    expect(state.repetitions).toBe(5);

    // Dann kippt es.
    const nachRueckfall = scheduleReview(state, fail(day));

    expect(nachRueckfall.intervalDays).toBe(0);
    expect(nachRueckfall.repetitions).toBe(0);
    expect(nachRueckfall.lapses).toBe(1);
    expect(nachRueckfall.easeFactor).toBe(2.2);
    // Zeitnah wieder dran - eine Stunde, nicht Tage.
    expect(nachRueckfall.dueAt?.getTime()).toBe(at(day).getTime() + LAPSE_DELAY_MINUTES * 60_000);
  });

  it('behandelt einen Fehlschlag in der Lernphase als normalen Ein-Tages-Schritt', () => {
    // Kein Rueckfall: Das Konzept sass noch nie. Jemanden im Stundentakt mit
    // etwas zu behelligen, das er noch gar nicht gelernt hat, hilft niemandem.
    const state = scheduleReview(INITIAL_REVIEW_STATE, fail(0));

    expect(state.intervalDays).toBe(1);
    expect(state.lapses).toBe(1);
    expect(state.dueAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('senkt der Ease-Faktor bei wiederholten Rueckfaellen dauerhaft', () => {
    // Teilweise richtig (0,4) statt komplett falsch - so wird der Abstieg
    // ueber mehrere Schritte sichtbar statt nach zweien am Boden.
    let state = INITIAL_REVIEW_STATE;
    const eases = [state.easeFactor];
    for (let i = 0; i < 5; i += 1) {
      state = scheduleReview(state, fail(i, 0.4));
      eases.push(state.easeFactor);
    }

    expect(eases).toEqual([2.5, 2.18, 1.86, 1.54, 1.3, 1.3]);
    expect(state.lapses).toBe(5);
    // Und er erholt sich nur langsam: ein Erfolg bringt hoechstens +0,1.
    const nachErfolg = scheduleReview(state, pass(9));
    expect(nachErfolg.easeFactor).toBe(1.4);
  });
});

describe('Ursprung eines Eintrags (AP4.T4.4)', () => {
  const signal = (
    outcome: number,
    signalClass: LearningSignalClass,
    source: LearningEventSource,
  ) => ({ outcome, signalClass, source });

  it('kennzeichnet einen Fehlschlag als "error"', () => {
    expect(reviewOrigin([signal(0, 'objective', 'drill')])).toBe<ReviewQueueOrigin>('error');
    expect(reviewOrigin([signal(0.2, 'ai_judged', 'theory_session')])).toBe('error');
  });

  it('kennzeichnet einen Fehlschlag aus der Praxis als "practice_finding"', () => {
    expect(reviewOrigin([signal(0, 'objective', 'hand_analysis')])).toBe('practice_finding');
    expect(reviewOrigin([signal(0, 'objective', 'tournament')])).toBe('practice_finding');
  });

  it('kennzeichnet einen Stand ohne objektives Signal als "knowledge_gap"', () => {
    // Kein Fehler, aber auch kein Beleg, der nicht von einem Modell oder vom
    // Lernenden selbst kommt - genau der Fall, den T4.3 als
    // `mastered_without_objective_anchors` durchlaesst.
    expect(
      reviewOrigin([
        signal(1, 'ai_judged', 'theory_session'),
        signal(1, 'self_reported', 'journal'),
      ]),
    ).toBe('knowledge_gap');
  });

  it('legt ein sauber objektiv belegtes Konzept ohne Fehler nicht in die Queue', () => {
    expect(
      reviewOrigin([signal(1, 'objective', 'drill'), signal(1, 'objective', 'theory_session')]),
    ).toBeNull();
    expect(reviewOrigin([])).toBeNull();
  });

  it('richtet sich nach dem juengsten Fehlschlag, nicht nach dem ersten', () => {
    expect(
      reviewOrigin([signal(0, 'objective', 'drill'), signal(0, 'objective', 'hand_analysis')]),
    ).toBe('practice_finding');
  });
});

describe('Priorisierung (AP4.T4.4)', () => {
  const NOW = new Date('2026-02-01T12:00:00.000Z');

  function candidate(
    conceptId: string,
    overdue: number,
    origin: ReviewQueueOrigin,
    masteryScore: number,
    prerequisiteIds: readonly string[] = [],
  ): ReviewCandidate {
    return {
      conceptId,
      dueAt: new Date(NOW.getTime() - overdue * DAY),
      origin,
      intervalDays: 5,
      easeFactor: EASE_START,
      repetitions: 1,
      lapses: 0,
      masteryScore,
      prerequisiteIds,
    };
  }

  it('sortiert nach Ueberfaelligkeit, dann Ursprung, dann Mastery', () => {
    const eingabe = [
      candidate('c-luecke-frisch', 0, 'knowledge_gap', 0.6),
      candidate('c-fehler-frisch', 0, 'error', 0.6),
      candidate('c-praxis-frisch', 0, 'practice_finding', 0.6),
      candidate('c-luecke-alt', 5, 'knowledge_gap', 0.9),
      candidate('c-fehler-schwach', 0, 'error', 0.2),
    ];

    expect(prioritizeReviews(eingabe, NOW).map((entry) => entry.conceptId)).toEqual([
      // 5 Tage ueberfaellig schlaegt alles andere.
      'c-luecke-alt',
      // Gleiche Ueberfaelligkeit: Fehler vor Praxisbefund vor Luecke ...
      'c-fehler-schwach',
      'c-fehler-frisch',
      'c-praxis-frisch',
      'c-luecke-frisch',
    ]);
    // ... und unter den beiden Fehlern zuerst der mit der schlechteren Mastery.
    expect(prioritizeReviews(eingabe, NOW)[1]?.masteryScore).toBe(0.2);
  });

  it('rundet die Ueberfaelligkeit auf ganze Tage', () => {
    // Zwei Stunden Unterschied sind keine unterschiedliche Dringlichkeit -
    // dann soll der Ursprung entscheiden, nicht der Zufall der Uhrzeit.
    const frueherAmTag: ReviewCandidate = {
      ...candidate('c-luecke', 0, 'knowledge_gap', 0.5),
      dueAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000),
    };
    const spaeter = candidate('c-fehler', 0, 'error', 0.5);

    expect(overdueDays(frueherAmTag, NOW)).toBe(0);
    expect(prioritizeReviews([frueherAmTag, spaeter], NOW).map((e) => e.conceptId)).toEqual([
      'c-fehler',
      'c-luecke',
    ]);
  });

  it('stellt ein Konzept zurueck, dessen faellige Voraussetzung noch aussteht', () => {
    // `c-aufbau` waere nach Prioritaet vorn (Fehler, schwache Mastery), haengt
    // aber an `c-basis`, das ebenfalls faellig ist.
    const basis = candidate('c-basis', 0, 'knowledge_gap', 0.9);
    const aufbau = candidate('c-aufbau', 0, 'error', 0.1, ['c-basis']);

    expect(prioritizeReviews([aufbau, basis], NOW).map((e) => e.conceptId)).toEqual([
      'c-basis',
      'c-aufbau',
    ]);
  });

  it('stellt nicht zurueck, wenn die Voraussetzung gar nicht faellig ist', () => {
    // Die Regel greift nur zwischen Eintraegen derselben Ausgabe. Sonst waere
    // ein Konzept blockiert, weil irgendwo eine Voraussetzung schwach ist -
    // und der Nutzer bekaeme gar nichts vorgelegt.
    const aufbau = candidate('c-aufbau', 0, 'error', 0.1, ['c-nicht-faellig']);
    const anderes = candidate('c-anderes', 0, 'knowledge_gap', 0.9);

    expect(prioritizeReviews([aufbau, anderes], NOW).map((e) => e.conceptId)).toEqual([
      'c-aufbau',
      'c-anderes',
    ]);
  });

  it('loest eine Kette von Voraussetzungen in der richtigen Reihenfolge auf', () => {
    const a = candidate('c-a', 0, 'knowledge_gap', 0.9);
    const b = candidate('c-b', 0, 'knowledge_gap', 0.8, ['c-a']);
    const c = candidate('c-c', 3, 'error', 0.1, ['c-b']);

    // `c-c` ist am dringendsten, kommt aber trotzdem zuletzt.
    expect(prioritizeReviews([c, b, a], NOW).map((e) => e.conceptId)).toEqual([
      'c-a',
      'c-b',
      'c-c',
    ]);
  });

  it('liefert bei gleicher Eingabe immer dieselbe Reihenfolge', () => {
    const eingabe = [
      candidate('c-2', 1, 'error', 0.5),
      candidate('c-1', 1, 'error', 0.5),
      candidate('c-3', 1, 'error', 0.5),
    ];

    const einmal = prioritizeReviews(eingabe, NOW).map((e) => e.conceptId);
    const nochmal = prioritizeReviews([...eingabe].reverse(), NOW).map((e) => e.conceptId);

    // Vollstaendiger Gleichstand: Die Konzept-ID entscheidet, damit die
    // Reihenfolge nicht an der Zeilenfolge der Datenbank haengt.
    expect(einmal).toEqual(['c-1', 'c-2', 'c-3']);
    expect(nochmal).toEqual(einmal);
  });

  it('liefert bei einer leeren Menge eine leere Reihenfolge', () => {
    expect(prioritizeReviews([], NOW)).toEqual([]);
  });
});
