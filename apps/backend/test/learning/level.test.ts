import { describe, expect, it } from 'vitest';
import { LEARNER_LEVELS, MANUAL_LEVEL_GRACE_DAYS } from '@gto/shared';
import type { LearnerLevel, LevelSignals } from '@gto/shared';
import {
  LEVEL_ORDER,
  automaticLevel,
  calibrateLevel,
  levelRank,
} from '../../src/learning/level.js';

/**
 * Level-Kalibrierung mit Hysterese (AP4.T4.5) - reine Funktionen.
 *
 * Das Level steuert ab AP5, wie tief die KI erklaert. Springt es an einer
 * Grenze hin und her, wechselt der Erklaerstil mitten in einer Lernphase -
 * verwirrender als ein leicht falsches Level. Deshalb liegt der Schwerpunkt
 * dieses Tests auf der Hysterese.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T12:00:00.000Z');

/** Kennzahlen mit Vorgaben, die jeder Test gezielt ueberschreibt. */
function signals(overrides: Partial<LevelSignals> = {}): LevelSignals {
  return {
    averageRating: 0.6,
    coveredTopicAreas: 6,
    masteredConcepts: 10,
    objectiveShare: 0.3,
    totalSignals: 100,
    ...overrides,
  };
}

function calibrate(current: LearnerLevel, over: Partial<LevelSignals> = {}): LearnerLevel {
  return calibrateLevel({
    current,
    signals: signals(over),
    asOf: NOW,
  }).level;
}

describe('Stufenfolge (AP4.T4.5)', () => {
  it('nutzt dieselbe Liste wie concept.min_level aus T3.2', () => {
    // Keine zweite Liste: Das Level wird gegen `min_level` der Konzepte
    // gehalten - eine vierte Lernenden-Stufe haette dort keine Entsprechung.
    expect(LEVEL_ORDER).toEqual(LEARNER_LEVELS);
    expect(LEVEL_ORDER).toEqual(['einsteiger', 'fortgeschritten', 'experte']);
    expect(levelRank('einsteiger')).toBe(0);
    expect(levelRank('experte')).toBe(2);
  });

  it('startet ohne jede Datenlage bei "einsteiger"', () => {
    const leer: LevelSignals = {
      averageRating: 0,
      coveredTopicAreas: 0,
      masteredConcepts: 0,
      objectiveShare: 0,
      totalSignals: 0,
    };
    expect(automaticLevel(leer)).toBe('einsteiger');
    expect(calibrateLevel({ current: 'einsteiger', signals: leer, asOf: NOW }).level).toBe(
      'einsteiger',
    );
  });
});

describe('Hysterese (AP4.T4.5)', () => {
  it('springt an der Aufstiegsschwelle nicht hin und her', () => {
    // DER Test dieses Tasks. Die Aufstiegsschwelle zu `fortgeschritten` liegt
    // bei einem Rating-Schnitt von 0,55, die Halteschwelle bei 0,45. Die Folge
    // pendelt genau um die Aufstiegsschwelle - und zwar so, wie es in der
    // Praxis passiert: ein paar Zehntel hoch, ein paar runter.
    const folge = [0.56, 0.54, 0.56, 0.53, 0.57, 0.52, 0.55, 0.54];

    let level: LearnerLevel = 'einsteiger';
    const verlauf: LearnerLevel[] = [];
    for (const averageRating of folge) {
      level = calibrate(level, { averageRating });
      verlauf.push(level);
    }

    // Genau **ein** Wechsel: hoch beim ersten Wert ueber 0,55, danach Ruhe.
    expect(verlauf).toEqual([
      'fortgeschritten',
      'fortgeschritten',
      'fortgeschritten',
      'fortgeschritten',
      'fortgeschritten',
      'fortgeschritten',
      'fortgeschritten',
      'fortgeschritten',
    ]);
    expect(new Set(verlauf).size).toBe(1);
  });

  it('haelt im toten Band die Stufe, in der man gerade ist', () => {
    // Derselbe Wert, zwei Ausgangslagen, zwei Ergebnisse - genau das ist
    // Hysterese: Im Band entscheidet die Geschichte, nicht die Zahl.
    const imBand = { averageRating: 0.5, masteredConcepts: 4 };

    expect(calibrate('einsteiger', imBand)).toBe('einsteiger');
    expect(calibrate('fortgeschritten', imBand)).toBe('fortgeschritten');
  });

  it('steigt erst oberhalb der Aufstiegsschwelle auf', () => {
    expect(calibrate('einsteiger', { averageRating: 0.54, masteredConcepts: 5 })).toBe(
      'einsteiger',
    );
    expect(calibrate('einsteiger', { averageRating: 0.55, masteredConcepts: 5 })).toBe(
      'fortgeschritten',
    );
  });

  it('steigt erst unterhalb der Halteschwelle ab', () => {
    expect(calibrate('fortgeschritten', { averageRating: 0.45, masteredConcepts: 3 })).toBe(
      'fortgeschritten',
    );
    expect(calibrate('fortgeschritten', { averageRating: 0.44, masteredConcepts: 3 })).toBe(
      'einsteiger',
    );
  });
});

describe('Aufstieg (AP4.T4.5)', () => {
  it('erkennt zuegig, dass der Nutzer kein Anfaenger ist', () => {
    // Der Start bei "einsteiger" ist eine Vorsichtsannahme, keine
    // Feststellung. Wer bereits Turniere spielt, soll nicht erst zwanzig
    // Sitzungen lang Anfaengererklaerungen bekommen: Tragen die Kennzahlen
    // zwei Stufen, geht es in einem Schritt hoch.
    expect(
      calibrate('einsteiger', {
        averageRating: 0.82,
        coveredTopicAreas: 8,
        masteredConcepts: 25,
        objectiveShare: 0.5,
      }),
    ).toBe('experte');
  });

  it('springt nicht nach drei guten Antworten auf die hoechste Stufe', () => {
    // Hoher Schnitt, aber duenne Datenlage: ein Themenbereich, drei Konzepte.
    expect(
      calibrate('einsteiger', {
        averageRating: 1,
        coveredTopicAreas: 1,
        masteredConcepts: 3,
        objectiveShare: 1,
        totalSignals: 3,
      }),
    ).toBe('einsteiger');
  });

  it('verlangt fuer "experte" auch objektive Belege', () => {
    const ohneAnker = {
      averageRating: 0.85,
      coveredTopicAreas: 8,
      masteredConcepts: 30,
      objectiveShare: 0.1,
    };

    // Alles andere reicht - nur die objektive Absicherung fehlt. Dieselbe
    // Haltung wie bei der Weiterschaltung in T4.3.
    expect(calibrate('fortgeschritten', ohneAnker)).toBe('fortgeschritten');
    expect(calibrate('fortgeschritten', { ...ohneAnker, objectiveShare: 0.4 })).toBe('experte');
  });
});

describe('Abstieg (AP4.T4.5)', () => {
  it('degradiert nicht wegen eines einzelnen Ereignisses', () => {
    // Ein Ereignis bewegt das Rating **eines** Themenbereichs um hoechstens
    // 22,5 % der Luecke (T4.5-Abkling-Faktor). Bei sechs Bereichen im
    // Durchschnitt sind das wenige Hundertstel - das tote Band ist zehn
    // Hundertstel breit. Der Abstand ist also nicht knapp, sondern
    // rechnerisch unerreichbar.
    const solide = { averageRating: 0.6, masteredConcepts: 10 };
    const nachEinemAusrutscher = { averageRating: 0.6 - 0.225 / 6, masteredConcepts: 10 };

    expect(calibrate('fortgeschritten', solide)).toBe('fortgeschritten');
    expect(calibrate('fortgeschritten', nachEinemAusrutscher)).toBe('fortgeschritten');
    expect(nachEinemAusrutscher.averageRating).toBeGreaterThan(0.45);
  });

  it('degradiert bei anhaltender Verschlechterung', () => {
    // Eine lange Talfahrt zieht den Schnitt Schritt fuer Schritt unter die
    // Halteschwelle - dann greift der Abstieg.
    const talfahrt = [0.6, 0.55, 0.5, 0.46, 0.42, 0.38];

    let level: LearnerLevel = 'fortgeschritten';
    const verlauf = talfahrt.map((averageRating) => {
      level = calibrate(level, { averageRating, masteredConcepts: 3 });
      return level;
    });

    expect(verlauf).toEqual([
      'fortgeschritten',
      'fortgeschritten',
      'fortgeschritten',
      'fortgeschritten',
      'einsteiger',
      'einsteiger',
    ]);
  });

  it('faellt auf die hoechste Stufe, deren Halteschwelle noch traegt', () => {
    // Loest sich die Beleglage vollstaendig auf, geht es auch zwei Stufen
    // tief. Eine kuenstliche Bremse waere hier keine Vorsicht, sondern eine
    // Anzeige, die laenger als noetig ein Niveau bescheinigt, das nicht mehr da
    // ist.
    const eingebrochen = {
      averageRating: 0.2,
      coveredTopicAreas: 1,
      masteredConcepts: 0,
      objectiveShare: 0,
    };
    // Nur der obere Halt faellt weg: dann genau eine Stufe.
    const knappDarunter = {
      averageRating: 0.6,
      coveredTopicAreas: 6,
      masteredConcepts: 10,
      objectiveShare: 0.3,
    };

    expect(calibrate('experte', eingebrochen)).toBe('einsteiger');
    expect(calibrate('experte', knappDarunter)).toBe('fortgeschritten');
  });

  it('ist nach einem Aufruf ein Fixpunkt', () => {
    // Bedingung dafuer, dass ein Replay dieselbe Stufe liefert wie der
    // inkrementelle Weg.
    for (const start of LEVEL_ORDER) {
      for (const averageRating of [0.2, 0.45, 0.5, 0.55, 0.7, 0.8, 0.9]) {
        const einmal = calibrate(start, {
          averageRating,
          masteredConcepts: 20,
          objectiveShare: 0.5,
          coveredTopicAreas: 8,
        });
        expect(
          calibrate(einmal, {
            averageRating,
            masteredConcepts: 20,
            objectiveShare: 0.5,
            coveredTopicAreas: 8,
          }),
        ).toBe(einmal);
      }
    }
  });
});

describe('Manuelle Level-Setzung (AP4.T4.5)', () => {
  const setAt = new Date('2026-06-01T10:00:00.000Z');
  const schwach = signals({ averageRating: 0.2, masteredConcepts: 0, coveredTopicAreas: 1 });

  it('gewinnt gegen die Automatik, solange die Frist laeuft', () => {
    const result = calibrateLevel({
      current: 'einsteiger',
      signals: schwach,
      manual: { level: 'experte', setAt },
      asOf: NOW,
    });

    expect(result.level).toBe('experte');
    expect(result.source).toBe('manual');
    expect(result.changed).toBe(true);
    // Die Automatik saehe etwas anderes - und sagt das auch.
    expect(result.automaticLevel).toBe('einsteiger');
    expect(result.manualUntil).toBe(
      new Date(setAt.getTime() + MANUAL_LEVEL_GRACE_DAYS * DAY).toISOString(),
    );
  });

  it('gilt bis zum letzten Moment der Frist und danach nicht mehr', () => {
    const grenze = new Date(setAt.getTime() + MANUAL_LEVEL_GRACE_DAYS * DAY);

    const kurzDavor = calibrateLevel({
      current: 'experte',
      signals: schwach,
      manual: { level: 'experte', setAt },
      asOf: new Date(grenze.getTime() - 1),
    });
    const genauDanach = calibrateLevel({
      current: 'experte',
      signals: schwach,
      manual: { level: 'experte', setAt },
      asOf: grenze,
    });

    expect(kurzDavor.source).toBe('manual');
    expect(kurzDavor.level).toBe('experte');
    // Nach Ablauf greift die Automatik - und zwar schrittweise, nicht in
    // einem Sturz.
    expect(genauDanach.source).toBe('automatic');
    // Die Kennzahlen tragen keine Stufe mehr - die Automatik holt zurueck,
    // was die manuelle Setzung vorgegriffen hatte.
    expect(genauDanach.level).toBe('einsteiger');
    expect(genauDanach.manualUntil).toBeNull();
  });

  it('meldet ohne manuelle Setzung "automatic"', () => {
    const result = calibrateLevel({ current: 'einsteiger', signals: signals(), asOf: NOW });

    expect(result.source).toBe('automatic');
    expect(result.manualUntil).toBeNull();
    expect(result.previousLevel).toBe('einsteiger');
  });
});
