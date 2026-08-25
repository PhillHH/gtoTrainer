import { CHART_HAND_COUNT, handComboWeight } from '@gto/shared';
import type { ChartMatrix } from '@gto/shared';

/**
 * Auswertung des Kalibrierungslaufs (AP3.T3.3, Scope-Delta 3).
 *
 * **Deterministisch, ohne KI.** Hier wird gemessen, nicht bewertet: Was ein
 * Modell gelesen hat, wird gegen von Hand geprüfte Sollwerte gehalten.
 *
 * Abgrenzung zu T3.4: Dort entstehen die **Prüfregeln der Pipeline**
 * (Frequenzsumme je Hand, Caption-Abgleich mit Toleranz, Plausibilität) und
 * die Zustandsübergänge. Hier wird dieselbe Rechnung einmalig für die
 * Modellwahl benutzt — die Charts bleiben davon unberührt und im Zustand
 * `raw`.
 */

/** Eine von Hand abgelesene Zelle. */
export interface ReferenceCell {
  readonly hand: string;
  readonly kind: string;
  readonly percent: number;
}

/** Sollwerte eines Charts. */
export interface ReferenceChart {
  readonly handRange: number;
  readonly file: string;
  readonly bauart: string;
  readonly warum: string;
  /** `matrix` = eine Strategie wird erwartet, `leer` = Strukturraster. */
  readonly erwartung: 'matrix' | 'leer';
  /** Gesamtfrequenzen aus der Bildunterschrift, je Aktionsart. */
  readonly captionPercent: Readonly<Record<string, number>>;
  readonly cells?: readonly ReferenceCell[];
}

/** Ergebnis eines Modells für einen Chart. */
export interface ChartAttempt {
  readonly handRange: number;
  readonly matrix: ChartMatrix;
  readonly durationMs: number;
  readonly totalTokens: number | null;
  readonly uncertain: readonly string[];
  /** Gesetzt, wenn der Aufruf gar nicht durchkam. */
  readonly error?: string;
}

/** Messwerte eines Charts. */
export interface ChartScore {
  readonly handRange: number;
  readonly complete: boolean;
  readonly cellCount: number;
  /** Von Hand geprüfte Zellen, die das Modell richtig gelesen hat. */
  readonly cellsCorrect: number;
  readonly cellsChecked: number;
  /**
   * Mittlere absolute Abweichung der Combo-gewichteten Gesamtfrequenzen von
   * den Prozentwerten der Bildunterschrift, in Prozentpunkten.
   * `null`, wenn die Unterschrift keine Prozente nennt.
   */
  readonly captionDeviationPp: number | null;
  readonly durationMs: number;
  readonly totalTokens: number | null;
  readonly error?: string;
}

/** Messwerte eines Modells über die ganze Stichprobe. */
export interface ModelScore {
  readonly model: string;
  readonly charts: number;
  /** Charts, bei denen der Aufruf durchkam. */
  readonly answered: number;
  /**
   * Anteil der Charts, deren Ergebnis der Erwartung entspricht: 169 Zellen bei
   * Strategie-Charts, leere Matrix beim Strukturraster. Bezogen auf die
   * **ganze** Stichprobe, nicht nur auf die beantworteten Charts.
   */
  readonly completeness: number;
  /** Anteil richtig gelesener Referenzzellen, 0-1. */
  readonly cellAccuracy: number;
  readonly cellsChecked: number;
  /** Mittlere Abweichung gegen die Caption-Prozente in Prozentpunkten. */
  readonly captionDeviationPp: number | null;
  readonly totalDurationMs: number;
  readonly totalTokens: number;
  readonly scores: readonly ChartScore[];
}

/**
 * Combo-gewichtete Gesamtfrequenz je Aktionsart.
 *
 * Genau die Rechnung, mit der das Buch seine Caption-Prozente bildet: Paare
 * zählen 6 Combos, suited 4, offsuit 12.
 */
export function weightedTotals(matrix: ChartMatrix): Record<string, number> {
  const sums = new Map<string, number>();
  let weightTotal = 0;

  for (const cell of matrix) {
    const weight = handComboWeight(cell.hand);
    weightTotal += weight;
    for (const entry of cell.actions) {
      sums.set(
        entry.action.kind,
        (sums.get(entry.action.kind) ?? 0) + (weight * entry.percent) / 100,
      );
    }
  }

  if (weightTotal === 0) return {};
  return Object.fromEntries(
    [...sums.entries()].map(([kind, sum]) => [kind, (sum / weightTotal) * 100]),
  );
}

/** Toleranz, innerhalb derer eine abgelesene Zelle als richtig gilt. */
const CELL_TOLERANCE_PP = 10;

/** Bewertet einen einzelnen Chart gegen seine Sollwerte. */
export function scoreChart(reference: ReferenceChart, attempt: ChartAttempt): ChartScore {
  if (attempt.error !== undefined) {
    return {
      handRange: reference.handRange,
      complete: false,
      cellCount: 0,
      cellsCorrect: 0,
      cellsChecked: reference.cells?.length ?? 0,
      captionDeviationPp: null,
      durationMs: attempt.durationMs,
      totalTokens: attempt.totalTokens,
      error: attempt.error,
    };
  }

  // Strukturraster: Erwartet wird eine leere Matrix. Wer hier 169 Zellen
  // erfindet, hat die Ehrlichkeitsprobe nicht bestanden.
  if (reference.erwartung === 'leer') {
    return {
      handRange: reference.handRange,
      complete: attempt.matrix.length === 0,
      cellCount: attempt.matrix.length,
      cellsCorrect: attempt.matrix.length === 0 ? 1 : 0,
      cellsChecked: 1,
      captionDeviationPp: null,
      durationMs: attempt.durationMs,
      totalTokens: attempt.totalTokens,
    };
  }

  const byHand = new Map(attempt.matrix.map((cell) => [cell.hand, cell]));
  const cells = reference.cells ?? [];
  let correct = 0;
  for (const expected of cells) {
    const cell = byHand.get(expected.hand);
    if (!cell) continue;
    const match = cell.actions.find((entry) => entry.action.kind === expected.kind);
    if (match && Math.abs(match.percent - expected.percent) <= CELL_TOLERANCE_PP) correct += 1;
  }

  const captionKinds = Object.keys(reference.captionPercent);
  let captionDeviationPp: number | null = null;
  if (captionKinds.length > 0 && attempt.matrix.length > 0) {
    const totals = weightedTotals(attempt.matrix);
    const deviations = captionKinds.map((kind) =>
      Math.abs((totals[kind] ?? 0) - (reference.captionPercent[kind] ?? 0)),
    );
    captionDeviationPp = deviations.reduce((sum, value) => sum + value, 0) / deviations.length;
  }

  return {
    handRange: reference.handRange,
    complete: attempt.matrix.length === CHART_HAND_COUNT,
    cellCount: attempt.matrix.length,
    cellsCorrect: correct,
    cellsChecked: cells.length,
    captionDeviationPp,
    durationMs: attempt.durationMs,
    totalTokens: attempt.totalTokens,
  };
}

/** Fasst die Messwerte eines Modells zusammen. */
export function scoreModel(
  model: string,
  references: readonly ReferenceChart[],
  attempts: readonly ChartAttempt[],
): ModelScore {
  const byHandRange = new Map(attempts.map((attempt) => [attempt.handRange, attempt]));
  const scores: ChartScore[] = [];

  for (const reference of references) {
    const attempt = byHandRange.get(reference.handRange);
    if (!attempt) continue;
    scores.push(scoreChart(reference, attempt));
  }

  const answered = scores.filter((score) => score.error === undefined);
  const completed = answered.filter((score) => score.complete);
  const cellsChecked = scores.reduce((sum, score) => sum + score.cellsChecked, 0);
  const cellsCorrect = scores.reduce((sum, score) => sum + score.cellsCorrect, 0);
  const deviations = scores
    .map((score) => score.captionDeviationPp)
    .filter((value): value is number => value !== null);

  return {
    model,
    charts: references.length,
    answered: answered.length,
    completeness: references.length === 0 ? 0 : completed.length / references.length,
    cellAccuracy: cellsChecked === 0 ? 0 : cellsCorrect / cellsChecked,
    cellsChecked,
    captionDeviationPp:
      deviations.length === 0
        ? null
        : deviations.reduce((sum, value) => sum + value, 0) / deviations.length,
    totalDurationMs: scores.reduce((sum, score) => sum + score.durationMs, 0),
    totalTokens: scores.reduce((sum, score) => sum + (score.totalTokens ?? 0), 0),
    scores,
  };
}

/** Die Messwerte als Markdown-Tabelle - fuer ADR und Bericht. */
export function formatScores(scores: readonly ModelScore[]): string {
  const lines = [
    '| Modell | Charts | vollständig | Zellen richtig | Ø Caption-Abw. | Dauer | Tokens |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const score of scores) {
    lines.push(
      `| \`${score.model}\` | ${score.answered}/${score.charts} | ` +
        `${Math.round(score.completeness * 100)} % | ` +
        `${Math.round(score.cellAccuracy * 100)} % (${score.cellsChecked} geprüft) | ` +
        `${score.captionDeviationPp === null ? '—' : `${score.captionDeviationPp.toFixed(1)} pp`} | ` +
        `${Math.round(score.totalDurationMs / 1000)} s | ` +
        `${score.totalTokens.toLocaleString('de-DE')} |`,
    );
  }
  return lines.join('\n');
}
