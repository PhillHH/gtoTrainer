import { describe, expect, it } from 'vitest';
import { LEARNING_THRESHOLD_RANGES } from '@gto/shared';
import type { LearningSignalClass, LearningThresholds } from '@gto/shared';
import {
  computeMasteryConfidence,
  computeMasteryScore,
  computeMasteryState,
  evaluateAdvance,
} from '../../src/learning/mastery.js';
import type { MasterySignal } from '../../src/learning/mastery.js';

/**
 * Mastery-Score, Konfidenz und Weiterschalt-Logik (AP4.T4.3).
 *
 * Alles reine Funktionen - keine Datenbank, kein Aufbau, keine Reihenfolge
 * zwischen den Tests. Genau deshalb liegt hier der Schwerpunkt des Tasks:
 * Was ueber "kann ich weitergehen?" entscheidet, muss vollstaendig
 * durchgerechnet und nicht nur angetestet sein.
 */

const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-01-01T00:00:00.000Z');

/** Ein Signal; `day` ist der Abstand zum Startzeitpunkt in Tagen. */
function sig(
  signalClass: LearningSignalClass,
  outcome: number,
  day = 0,
  difficulty = 0.5,
): MasterySignal {
  return { signalClass, outcome, difficulty, occurredAt: new Date(START.getTime() + day * DAY) };
}

function repeat(count: number, make: (index: number) => MasterySignal): MasterySignal[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

const THRESHOLDS: LearningThresholds = { masteryThreshold: 0.75, minObjectiveAnchors: 2 };

/** Ein Mastery-Stand, wie er in `concept_mastery` steht. */
function mastery(
  overrides: Partial<Parameters<typeof evaluateAdvance>[0]['mastery'] & object> = {},
) {
  return {
    score: 0.9,
    confidence: 0.6,
    objectiveSignals: 3,
    aiJudgedSignals: 0,
    selfReportedSignals: 0,
    lastCheckedAt: START,
    ...overrides,
  };
}

describe('Signalgewichtung (AP4.T4.3)', () => {
  it('gewichtet objektive Treffer staerker als KI-Bewertungen', () => {
    const objective = repeat(3, () => sig('objective', 1));
    const aiJudged = repeat(3, () => sig('ai_judged', 1));

    // Dieselbe Anzahl, dasselbe Ergebnis - aber nicht dieselbe Wirkung.
    // Schwache Signale ziehen den Score weniger weit vom Prior weg.
    expect(computeMasteryScore(objective)).toBeCloseTo(0.75, 4);
    expect(computeMasteryScore(aiJudged)).toBeCloseTo(0.6, 4);
    expect(computeMasteryScore(objective)).toBeGreaterThan(computeMasteryScore(aiJudged));
  });

  it('gewichtet KI-Bewertungen staerker als Selbsteinschaetzungen', () => {
    const aiJudged = repeat(3, () => sig('ai_judged', 1));
    const selfReported = repeat(3, () => sig('self_reported', 1));

    expect(computeMasteryScore(aiJudged)).toBeGreaterThan(computeMasteryScore(selfReported));
  });

  it('laesst eine Serie freundlicher KI-Bewertungen die Schwelle nicht so schnell reissen', () => {
    // Drei objektive Treffer reichen genau bis zur Schwelle; drei
    // KI-Bewertungen mit demselben Ergebnis bleiben deutlich darunter.
    expect(computeMasteryScore(repeat(3, () => sig('objective', 1)))).toBeGreaterThanOrEqual(0.75);
    expect(computeMasteryScore(repeat(3, () => sig('ai_judged', 1)))).toBeLessThan(0.75);
  });

  it('haelt den Score im Bereich 0 bis 1', () => {
    expect(computeMasteryScore([])).toBe(0);
    expect(computeMasteryScore(repeat(50, (i) => sig('objective', 1, i)))).toBeLessThanOrEqual(1);
    expect(computeMasteryScore(repeat(50, (i) => sig('objective', 0, i)))).toBeGreaterThanOrEqual(
      0,
    );
  });
});

describe('Asymmetrie von Fehlern (AP4.T4.3)', () => {
  it('senkt der Fehler nach Treffern staerker, als der Treffer nach Fehlern hebt', () => {
    const hits = repeat(3, (i) => sig('objective', 1, i));
    const hitsThenMiss = [...hits, sig('objective', 0, 3)];
    const misses = repeat(3, (i) => sig('objective', 0, i));
    const missesThenHit = [...misses, sig('objective', 1, 3)];

    const drop = computeMasteryScore(hits) - computeMasteryScore(hitsThenMiss);
    const rise = computeMasteryScore(missesThenHit) - computeMasteryScore(misses);

    // 0,7457 -> 0,5340 (Fall um 0,2117) gegen 0,0000 -> 0,1588 (Anstieg 0,1588).
    expect(computeMasteryScore(hits)).toBeCloseTo(0.7457, 4);
    expect(computeMasteryScore(hitsThenMiss)).toBeCloseTo(0.534, 4);
    expect(computeMasteryScore(misses)).toBeCloseTo(0, 4);
    expect(computeMasteryScore(missesThenHit)).toBeCloseTo(0.1588, 4);

    expect(drop).toBeGreaterThan(rise);
  });
});

describe('Zeitliche Gewichtung (AP4.T4.3)', () => {
  it('laesst neuere Ereignisse dominieren', () => {
    // Dieselbe Folge - erst ein Fehler, dann ein Treffer -, nur die Abstaende
    // unterscheiden sich. Liegt der Fehler weit zurueck, zaehlt er kaum noch.
    const dichtBeieinander = [sig('objective', 0, 0), sig('objective', 1, 1)];
    const weitAuseinander = [sig('objective', 0, 0), sig('objective', 1, 120)];

    expect(computeMasteryScore(dichtBeieinander)).toBeCloseTo(0.2885, 4);
    expect(computeMasteryScore(weitAuseinander)).toBeCloseTo(0.4776, 4);
    expect(computeMasteryScore(weitAuseinander)).toBeGreaterThan(
      computeMasteryScore(dichtBeieinander),
    );
  });

  it('misst die Aktualitaet gegen das juengste Ereignis, nicht gegen die Uhr', () => {
    // Derselbe Strom, um ein Jahr verschoben: identisches Ergebnis. Ohne diese
    // Eigenschaft waere der Replay aus T4.2 nicht reproduzierbar.
    const jetzt = [sig('objective', 1, 0), sig('objective', 0, 10)];
    const verschoben = [sig('objective', 1, 365), sig('objective', 0, 375)];

    expect(computeMasteryScore(verschoben)).toBeCloseTo(computeMasteryScore(jetzt), 10);
    expect(computeMasteryConfidence(verschoben)).toBeCloseTo(computeMasteryConfidence(jetzt), 10);
  });
});

describe('Schwierigkeitsgewicht (AP4.T4.3)', () => {
  it('laesst einen Treffer bei einer schweren Frage mehr wiegen', () => {
    const leicht = [sig('objective', 1, 0, 0)];
    const mittel = [sig('objective', 1, 0, 0.5)];
    const schwer = [sig('objective', 1, 0, 1)];

    expect(computeMasteryScore(leicht)).toBeCloseTo(0.3333, 4);
    expect(computeMasteryScore(mittel)).toBeCloseTo(0.5, 4);
    expect(computeMasteryScore(schwer)).toBeCloseTo(0.6, 4);
  });

  it('laesst einen Fehler bei einer leichten Frage weniger schaden als bei einer schweren', () => {
    const leichterFehler = [sig('objective', 1, 0), sig('objective', 0, 1, 0)];
    const schwererFehler = [sig('objective', 1, 0), sig('objective', 0, 1, 1)];

    expect(computeMasteryScore(leichterFehler)).toBeGreaterThan(
      computeMasteryScore(schwererFehler),
    );
  });
});

describe('Konfidenz - getrennt vom Score (AP4.T4.3)', () => {
  it('unterscheidet bei gleichem Score deutlich nach Belastbarkeit der Signale', () => {
    // Der Kern der Trennung: **derselbe Score**, zwei sehr verschiedene
    // Aussagen darueber, wie sicher man sich sein darf.
    const objektiv = repeat(4, () => sig('objective', 1));
    const kiBewertet = repeat(8, () => sig('ai_judged', 1));

    expect(computeMasteryScore(objektiv)).toBeCloseTo(0.8, 4);
    expect(computeMasteryScore(kiBewertet)).toBeCloseTo(0.8, 4);
    expect(computeMasteryScore(objektiv)).toBeCloseTo(computeMasteryScore(kiBewertet), 10);

    expect(computeMasteryConfidence(objektiv)).toBeCloseTo(0.6321, 4);
    expect(computeMasteryConfidence(kiBewertet)).toBeCloseTo(0.3297, 4);
    // Fast doppelt so hoch - trotz halb so vieler Ereignisse.
    expect(computeMasteryConfidence(objektiv)).toBeGreaterThan(
      computeMasteryConfidence(kiBewertet) * 1.5,
    );
  });

  it('steigt mit der Anzahl der Signale', () => {
    const wenig = repeat(2, () => sig('objective', 1));
    const viel = repeat(10, () => sig('objective', 1));

    expect(computeMasteryConfidence(viel)).toBeGreaterThan(computeMasteryConfidence(wenig));
  });

  it('haengt nicht davon ab, ob die Signale gut oder schlecht ausfielen', () => {
    // Auch ein Fehlschlag ist eine Messung: Er macht die Einschaetzung
    // sicherer, nicht unsicherer.
    const treffer = repeat(4, (i) => sig('objective', 1, i));
    const fehler = repeat(4, (i) => sig('objective', 0, i));

    expect(computeMasteryConfidence(fehler)).toBeCloseTo(computeMasteryConfidence(treffer), 10);
    expect(computeMasteryScore(fehler)).not.toBeCloseTo(computeMasteryScore(treffer), 2);
  });

  it('sinkt mit dem zeitlichen Abstand zur letzten Pruefung', () => {
    const stand = mastery({ confidence: 0.8 });

    const frisch = evaluateAdvance({
      mastery: stand,
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: START,
    });
    const nachEinemMonat = evaluateAdvance({
      mastery: stand,
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: new Date(START.getTime() + 30 * DAY),
    });
    const nachEinemJahr = evaluateAdvance({
      mastery: stand,
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: new Date(START.getTime() + 365 * DAY),
    });

    expect(frisch.confidence).toBeCloseTo(0.8, 4);
    // Eine Halbwertszeit spaeter: die Haelfte.
    expect(nachEinemMonat.confidence).toBeCloseTo(0.4, 4);
    expect(nachEinemJahr.confidence).toBeLessThan(0.02);

    // Der gespeicherte Wert bleibt unberuehrt - die Veralterung ist eine
    // Frage der Abfrage, nicht der Ableitung.
    expect(nachEinemJahr.storedConfidence).toBe(0.8);
    expect(nachEinemJahr.daysSinceLastCheck).toBeCloseTo(365, 6);
  });
});

describe('Weiterschalt-Entscheidung (AP4.T4.3)', () => {
  it('blockiert bei Score ueber der Schwelle, aber zu wenigen objektiven Ankern', () => {
    // DER Test dieses Tasks: Ein hoher Score aus KI-Bewertungen kommt an der
    // Ankerpflicht nicht vorbei. Sonst bestuende die Pruefung darin, dass ein
    // Sprachmodell einem Sprachmodell zustimmt (Risiko R3).
    const decision = evaluateAdvance({
      mastery: mastery({
        score: 0.92,
        confidence: 0.33,
        objectiveSignals: 1,
        aiJudgedSignals: 8,
        selfReportedSignals: 0,
      }),
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: START,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('insufficient_objective_anchors');
    expect(decision.blockers).toEqual(['insufficient_objective_anchors']);
    expect(decision.score).toBe(0.92);
    expect(decision.threshold).toBe(0.75);
    expect(decision.objectiveAnchors).toBe(1);
    expect(decision.requiredObjectiveAnchors).toBe(2);
    expect(decision.signalCounts).toEqual({ objective: 1, aiJudged: 8, selfReported: 0 });
  });

  it('blockiert bei genug Ankern, aber Score unter der Schwelle', () => {
    const decision = evaluateAdvance({
      mastery: mastery({ score: 0.6, objectiveSignals: 5 }),
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: START,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('score_below_threshold');
    expect(decision.blockers).toEqual(['score_below_threshold']);
  });

  it('nennt beide Gruende, wenn beide Bedingungen verletzt sind', () => {
    const decision = evaluateAdvance({
      mastery: mastery({ score: 0.3, objectiveSignals: 0, aiJudgedSignals: 1 }),
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: START,
    });

    expect(decision.blockers).toEqual(['score_below_threshold', 'insufficient_objective_anchors']);
    // Die fehlenden Anker sind die ueberraschendere Auskunft und stehen vorn.
    expect(decision.reason).toBe('insufficient_objective_anchors');
  });

  it('schaltet weiter, wenn beide Bedingungen erfuellt sind', () => {
    const decision = evaluateAdvance({
      mastery: mastery({ score: 0.83, confidence: 0.71, objectiveSignals: 5 }),
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: START,
    });

    expect(decision).toEqual({
      allowed: true,
      reason: 'mastered',
      blockers: [],
      score: 0.83,
      threshold: 0.75,
      storedConfidence: 0.71,
      confidence: 0.71,
      daysSinceLastCheck: 0,
      objectiveAnchors: 5,
      requiredObjectiveAnchors: 2,
      objectiveAnchorsPossible: true,
      substituteAnchors: 5,
      signalCounts: { objective: 5, aiJudged: 0, selfReported: 0 },
    });
  });

  it('meldet ohne jeden Beleg "no_evidence" statt eines Scores von 0', () => {
    const decision = evaluateAdvance({
      mastery: null,
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: START,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no_evidence');
    expect(decision.blockers).toEqual(['no_evidence']);
    expect(decision.daysSinceLastCheck).toBeNull();
    expect(decision.confidence).toBe(0);
  });
});

describe('Uebergangszustand ohne moegliche Anker (Scope-Delta 2)', () => {
  it('schaltet weiter, kennzeichnet das aber als ohne objektive Absicherung', () => {
    const decision = evaluateAdvance({
      mastery: mastery({
        score: 0.8,
        confidence: 0.18,
        objectiveSignals: 0,
        aiJudgedSignals: 6,
        selfReportedSignals: 2,
      }),
      thresholds: THRESHOLDS,
      // Fuer dieses Konzept gibt es kein freigegebenes Chart.
      objectiveAnchorsPossible: false,
      asOf: START,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('mastered_without_objective_anchors');
    expect(decision.objectiveAnchorsPossible).toBe(false);
    expect(decision.objectiveAnchors).toBe(0);
    expect(decision.substituteAnchors).toBe(2);
    // Keine stillschweigende Gleichbehandlung: Die Konfidenz bleibt niedrig.
    expect(decision.confidence).toBeLessThan(0.2);
  });

  it('schaltet auch im Uebergangszustand nicht allein auf KI-Bewertungen weiter', () => {
    const decision = evaluateAdvance({
      mastery: mastery({
        score: 0.95,
        objectiveSignals: 0,
        aiJudgedSignals: 20,
        selfReportedSignals: 0,
      }),
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: false,
      asOf: START,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('insufficient_substitute_anchors');
    expect(decision.blockers).toEqual(['insufficient_substitute_anchors']);
    expect(decision.substituteAnchors).toBe(0);
  });

  it('verlangt wieder die vollen objektiven Anker, sobald ein Chart freigegeben ist', () => {
    const stand = mastery({
      score: 0.8,
      objectiveSignals: 0,
      aiJudgedSignals: 6,
      selfReportedSignals: 2,
    });

    // Identischer Lernstand, nur die Chart-Lage kippt - und die Entscheidung
    // kippt mit. Es muss dafuer keine Zeile Code geaendert werden.
    expect(
      evaluateAdvance({
        mastery: stand,
        thresholds: THRESHOLDS,
        objectiveAnchorsPossible: false,
        asOf: START,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateAdvance({
        mastery: stand,
        thresholds: THRESHOLDS,
        objectiveAnchorsPossible: true,
        asOf: START,
      }),
    ).toMatchObject({ allowed: false, reason: 'insufficient_objective_anchors' });
  });
});

describe('Grenzwerte (AP4.T4.3)', () => {
  it('laesst einen Score exakt auf der Schwelle durch', () => {
    const decision = evaluateAdvance({
      mastery: mastery({ score: 0.75, objectiveSignals: 2 }),
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: START,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('mastered');
  });

  it('blockiert knapp unter der Schwelle', () => {
    const decision = evaluateAdvance({
      mastery: mastery({ score: 0.7499, objectiveSignals: 2 }),
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: START,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toEqual(['score_below_threshold']);
  });

  it('laesst die Ankerzahl exakt am Minimum durch, eine darunter nicht', () => {
    const am = evaluateAdvance({
      mastery: mastery({ score: 0.8, objectiveSignals: 2 }),
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: START,
    });
    const darunter = evaluateAdvance({
      mastery: mastery({ score: 0.8, objectiveSignals: 1 }),
      thresholds: THRESHOLDS,
      objectiveAnchorsPossible: true,
      asOf: START,
    });

    expect(am.allowed).toBe(true);
    expect(darunter.allowed).toBe(false);
    expect(darunter.reason).toBe('insufficient_objective_anchors');
  });

  it('laesst bei Mindestanzahl 0 auch ohne Anker durch - aber nur, weil es so eingestellt ist', () => {
    const decision = evaluateAdvance({
      mastery: mastery({ score: 0.8, objectiveSignals: 0, aiJudgedSignals: 9 }),
      thresholds: { masteryThreshold: 0.75, minObjectiveAnchors: 0 },
      objectiveAnchorsPossible: true,
      asOf: START,
    });

    // Eine bewusste Entscheidung des Nutzers gegen die Absicherung, kein
    // stiller Default: `LEARNING_THRESHOLD_RANGES` laesst 0 ausdruecklich zu.
    expect(LEARNING_THRESHOLD_RANGES.minObjectiveAnchors.min).toBe(0);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('mastered');
  });
});

describe('Determinismus der Mastery-Logik (AP4.T4.3)', () => {
  it('liefert bei derselben Signalfolge zweimal identische Werte', () => {
    const signals = [
      sig('objective', 1, 0, 0.8),
      sig('ai_judged', 0.6, 5),
      sig('self_reported', 1, 9),
      sig('objective', 0, 12, 1),
    ];

    expect(computeMasteryState(signals)).toEqual(computeMasteryState(signals));
    expect(computeMasteryState([...signals].reverse())).toEqual(computeMasteryState(signals));
  });

  it('zaehlt die Signalklassen vollstaendig', () => {
    const state = computeMasteryState([
      sig('objective', 1),
      sig('objective', 0),
      sig('ai_judged', 1),
      sig('self_reported', 1),
    ]);

    expect(state).toMatchObject({
      objectiveSignals: 2,
      aiJudgedSignals: 1,
      selfReportedSignals: 1,
    });
  });

  it('liefert ohne Signale keinen Zustand', () => {
    expect(computeMasteryState([])).toBeNull();
  });
});
