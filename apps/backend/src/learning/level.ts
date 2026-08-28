import { LEARNER_LEVELS, MANUAL_LEVEL_GRACE_DAYS } from '@gto/shared';
import type { LearnerLevel, LevelCalibration, LevelSignals } from '@gto/shared';

/**
 * Level-Kalibrierung (AP4.T4.5) - **reine Funktionen**.
 *
 * Das Level beantwortet: **Auf welchem Niveau wird unterrichtet?** (F07) Ab AP5
 * steuert es, wie tief die KI erklaert, welche Fachsprache sie voraussetzt und
 * wie schwer die Fragen ausfallen.
 *
 * Die Determinismus-Regel aus T4.2 gilt: kein `Date.now()`, kein Zufall. Der
 * Bezugszeitpunkt fuer die Frist der manuellen Setzung kommt als
 * `asOf`-Argument herein - dieselbe Trennung wie bei der Konfidenz-Veralterung
 * in T4.3.
 */

/* -------------------------------------------------------------------------
 * Die Stufen
 * ---------------------------------------------------------------------- */

/**
 * Die Stufenfolge - **bewusst dieselbe wie `concept.min_level`** aus T3.2:
 * `einsteiger`, `fortgeschritten`, `experte`.
 *
 * Begruendung siehe ADR-0045. Kurz: Das Level hat genau einen Zweck, naemlich
 * gegen `min_level` der Konzepte gehalten zu werden und AP5 die Erklaertiefe
 * vorzugeben. Eine vierte Lernenden-Stufe ohne Entsprechung im Konzeptgraphen
 * waere ein Unterschied, der nirgends ankommt - und eine zweite Liste, die mit
 * der ersten auseinanderlaufen kann.
 */
export const LEVEL_ORDER: readonly LearnerLevel[] = LEARNER_LEVELS;

/** Rang einer Stufe, 0 = niedrigste. */
export function levelRank(level: LearnerLevel): number {
  const index = LEVEL_ORDER.indexOf(level);
  return index === -1 ? 0 : index;
}

/* -------------------------------------------------------------------------
 * Die Schwellen - mit Hysterese
 * ---------------------------------------------------------------------- */

/** Was erfuellt sein muss, um eine Stufe zu erreichen oder zu halten. */
interface LevelGate {
  readonly averageRating: number;
  readonly masteredConcepts: number;
  readonly objectiveShare: number;
  readonly coveredTopicAreas: number;
}

/**
 * Aufstiegs- und Halteschwellen je Stufe.
 *
 * **Die Halteschwelle liegt unter der Aufstiegsschwelle** - das ist die
 * Hysterese. Der Abstand dazwischen ist das tote Band: Wer darin liegt,
 * bleibt, wo er ist. Ohne dieses Band wechselte das Level an der Grenze bei
 * jedem Ereignis, und die KI wuerde mitten in einer Lernphase den Erklaerstil
 * aendern - verwirrender als ein leicht falsches Level.
 *
 * `einsteiger` hat keine Schwelle: Es ist die Ausgangsstufe, unter die niemand
 * faellt.
 */
const GATES: Readonly<
  Record<LearnerLevel, { readonly rise: LevelGate; readonly hold: LevelGate }>
> = {
  einsteiger: {
    rise: { averageRating: 0, masteredConcepts: 0, objectiveShare: 0, coveredTopicAreas: 0 },
    hold: { averageRating: 0, masteredConcepts: 0, objectiveShare: 0, coveredTopicAreas: 0 },
  },
  fortgeschritten: {
    rise: {
      averageRating: 0.55,
      masteredConcepts: 5,
      objectiveShare: 0.2,
      coveredTopicAreas: 2,
    },
    hold: {
      averageRating: 0.45,
      masteredConcepts: 3,
      objectiveShare: 0.1,
      coveredTopicAreas: 1,
    },
  },
  experte: {
    rise: {
      averageRating: 0.78,
      masteredConcepts: 20,
      objectiveShare: 0.4,
      coveredTopicAreas: 5,
    },
    hold: {
      averageRating: 0.68,
      masteredConcepts: 15,
      objectiveShare: 0.3,
      coveredTopicAreas: 4,
    },
  },
};

/** Ab welchem Mastery-Score und welcher Konfidenz ein Konzept "belastbar" sitzt. */
export const MASTERED_SCORE = 0.75;
export const MASTERED_CONFIDENCE = 0.4;

function meets(signals: LevelSignals, gate: LevelGate): boolean {
  return (
    signals.averageRating >= gate.averageRating &&
    signals.masteredConcepts >= gate.masteredConcepts &&
    signals.objectiveShare >= gate.objectiveShare &&
    signals.coveredTopicAreas >= gate.coveredTopicAreas
  );
}

/* -------------------------------------------------------------------------
 * Kalibrierung
 * ---------------------------------------------------------------------- */

export interface LevelInput {
  /** Das gespeicherte Level - es traegt die Hysterese. */
  readonly current: LearnerLevel;
  readonly signals: LevelSignals;
  /**
   * Die juengste manuelle Setzung, falls es eine gibt. Sie kommt aus dem
   * Ereignisstrom (`level_set`), nicht aus einem Schreibzugriff.
   */
  readonly manual?: { readonly level: LearnerLevel; readonly setAt: Date } | undefined;
  /** Bezugszeitpunkt fuer die Frist der manuellen Setzung. */
  readonly asOf: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Welches Level die Kennzahlen allein hergeben - **ohne** Hysterese.
 *
 * Die hoechste Stufe, deren Aufstiegsschwelle erfuellt ist.
 */
export function automaticLevel(signals: LevelSignals): LearnerLevel {
  let result: LearnerLevel = LEVEL_ORDER[0] as LearnerLevel;
  for (const level of LEVEL_ORDER) {
    if (meets(signals, GATES[level].rise)) result = level;
  }
  return result;
}

/**
 * Das Level nach einer Kalibrierung - **reine Funktion mit Hysterese**.
 *
 * Drei Regeln, in dieser Reihenfolge:
 *
 * 1. **Eine frische manuelle Setzung gewinnt.** Sie gilt
 *    {@link MANUAL_LEVEL_GRACE_DAYS} Tage; danach greift die Automatik wieder.
 *    Ohne diese Frist ueberschriebe der naechste Lauf die Korrektur sofort.
 * 2. **Aufstieg**, sobald die Aufstiegsschwelle der naechsten Stufe erfuellt
 *    ist - und zwar unmittelbar bis zur hoechsten erfuellten Stufe. Der Start
 *    bei `einsteiger` ist eine Vorsichtsannahme, keine Feststellung: Wer
 *    bereits Turniere spielt, soll nicht erst zwanzig Sitzungen lang
 *    Anfaengererklaerungen bekommen.
 * 3. **Abstieg nur**, wenn die **Halteschwelle** der aktuellen Stufe
 *    unterschritten ist. Zwischen Halte- und Aufstiegsschwelle liegt das tote
 *    Band, in dem sich nichts bewegt.
 *
 * Ein Aufruf ist immer ein Fixpunkt: Ein zweiter Aufruf auf dem Ergebnis
 * aendert nichts mehr. Das ist die Bedingung dafuer, dass ein Replay dieselbe
 * Stufe liefert wie der inkrementelle Weg.
 *
 * Warum ein einzelnes schlechtes Ereignis nicht degradiert, ist keine
 * Zusatzregel, sondern folgt aus dem Zusammenspiel: Der Durchschnitt laeuft
 * ueber zwoelf Themenbereiche, und in einem davon bewegt ein Ereignis das
 * Rating um hoechstens 22 % der Luecke (T4.5-Abkling-Faktor). Der
 * Gesamtdurchschnitt aendert sich damit um wenige Hundertstel - das tote Band
 * ist zehn Hundertstel breit.
 */
export function calibrateLevel(input: LevelInput): LevelCalibration {
  const { current, signals, manual, asOf } = input;
  const automatic = automaticLevel(signals);

  if (manual) {
    const expiresAt = new Date(manual.setAt.getTime() + MANUAL_LEVEL_GRACE_DAYS * DAY_MS);
    if (asOf.getTime() < expiresAt.getTime()) {
      return {
        level: manual.level,
        previousLevel: current,
        changed: manual.level !== current,
        source: 'manual',
        manualUntil: expiresAt.toISOString(),
        automaticLevel: automatic,
        signals,
      };
    }
  }

  const level = withHysteresis(current, signals);

  return {
    level,
    previousLevel: current,
    changed: level !== current,
    source: 'automatic',
    manualUntil: null,
    automaticLevel: automatic,
    signals,
  };
}

/**
 * Die eigentliche Hysterese: aufsteigen nach der Aufstiegsschwelle, absteigen
 * erst unter der Halteschwelle.
 */
function withHysteresis(current: LearnerLevel, signals: LevelSignals): LearnerLevel {
  const target = automaticLevel(signals);
  const currentRank = levelRank(current);

  // Aufstieg: Die Kennzahlen tragen eine hoehere Stufe.
  if (levelRank(target) > currentRank) return target;

  // Halten: Die Halteschwelle der aktuellen Stufe ist noch erfuellt.
  if (meets(signals, GATES[current].hold)) return current;

  // Abstieg auf die hoechste Stufe, deren Halteschwelle noch traegt. Das kann
  // auch zwei Stufen tief gehen - dann hat sich die Beleglage aber auch
  // wirklich aufgeloest. Eine kuenstliche Bremse ("nur eine Stufe pro
  // Ereignis") waere hier keine Vorsicht, sondern eine Anzeige, die dem
  // Nutzer laenger als noetig ein Niveau bescheinigt, das er nicht mehr hat.
  for (let rank = currentRank - 1; rank >= 0; rank -= 1) {
    const candidate = LEVEL_ORDER[rank] as LearnerLevel;
    if (meets(signals, GATES[candidate].hold)) return candidate;
  }

  return LEVEL_ORDER[0] as LearnerLevel;
}

/** Die Schwellen zur Anzeige und fuer die Doku - keine zweite Wahrheit. */
export function levelGates(): typeof GATES {
  return GATES;
}
