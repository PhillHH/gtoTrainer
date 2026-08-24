import { describe, expect, it } from 'vitest';
import {
  CHART_ACTION_KINDS,
  CHART_HANDS,
  CHART_HAND_COUNT,
  chartActionKey,
  chartActionLabel,
  handComboWeight,
  isChartHand,
  isValidChartMatrix,
  validateChartMatrix,
} from '@gto/shared';
import type { ChartCell } from '@gto/shared';

/**
 * Das Chart-Schema ist die strengste Stelle des Projekts: Diese Zahlen gelten
 * ab hier als Wahrheit. Unvollstaendiges, Unbekanntes und Unmoegliches wird
 * abgelehnt, nicht zurechtgebogen.
 */

/** Eine vollstaendige Matrix, in der alles gefoldet wird. */
function fullFoldMatrix(): ChartCell[] {
  return CHART_HANDS.map((hand) => ({
    hand,
    actions: [{ action: { kind: 'fold' as const, sizing: null }, percent: 100 }],
  }));
}

describe('Blattraster', () => {
  it('kennt genau 169 Blaetter', () => {
    expect(CHART_HANDS).toHaveLength(CHART_HAND_COUNT);
    expect(new Set(CHART_HANDS).size).toBe(CHART_HAND_COUNT);
  });

  it('nutzt die uebliche Notation: Paar, suited, offsuit', () => {
    expect(CHART_HANDS[0]).toBe('AA');
    expect(isChartHand('AKs')).toBe(true);
    expect(isChartHand('AKo')).toBe(true);
    // Die umgekehrte Reihenfolge ist keine gueltige Bezeichnung.
    expect(isChartHand('KAs')).toBe(false);
    expect(isChartHand('AAs')).toBe(false);
  });

  it('gewichtet Combos wie das Buch: Paare 6, suited 4, offsuit 12', () => {
    expect(handComboWeight('AA')).toBe(6);
    expect(handComboWeight('AKs')).toBe(4);
    expect(handComboWeight('AKo')).toBe(12);
    // Gegenprobe: die Summe aller Gewichte ist die Zahl aller Startblaetter.
    expect(CHART_HANDS.reduce((sum, hand) => sum + handComboWeight(hand), 0)).toBe(1326);
  });
});

describe('Matrixpruefung', () => {
  it('nimmt eine vollstaendige Matrix an', () => {
    expect(validateChartMatrix(fullFoldMatrix())).toEqual([]);
    expect(isValidChartMatrix(fullFoldMatrix())).toBe(true);
  });

  it('lehnt eine unvollstaendige Matrix ab', () => {
    const issues = validateChartMatrix(fullFoldMatrix().slice(0, 168));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('missing-hands');
    expect(issues[0]?.message).toContain('unvollständig');
    expect(issues[0]?.message).toContain('1 von 169');
  });

  it('lehnt eine unbekannte Aktion ab', () => {
    const matrix = fullFoldMatrix();
    matrix[0] = {
      hand: 'AA',
      actions: [{ action: { kind: 'muck' as never, sizing: null }, percent: 100 }],
    };
    const issues = validateChartMatrix(matrix);
    expect(issues.map((issue) => issue.kind)).toContain('unknown-action');
    expect(issues[0]?.message).toContain('unbekannte Aktionsart "muck"');
    expect(issues[0]?.message).toContain(CHART_ACTION_KINDS.join(', '));
  });

  it('lehnt eine Frequenz ausserhalb 0-100 ab', () => {
    const matrix = fullFoldMatrix();
    matrix[1] = {
      hand: 'AKs',
      actions: [{ action: { kind: 'raise', sizing: null }, percent: 140 }],
    };
    const issues = validateChartMatrix(matrix);
    expect(issues.map((issue) => issue.kind)).toContain('percent-out-of-range');
    expect(issues[0]?.message).toContain('140 liegt außerhalb 0-100');
  });

  it('lehnt eine negative Frequenz ab', () => {
    const matrix = fullFoldMatrix();
    matrix[2] = { hand: 'AQs', actions: [{ action: { kind: 'fold', sizing: null }, percent: -1 }] };
    expect(validateChartMatrix(matrix).map((issue) => issue.kind)).toContain(
      'percent-out-of-range',
    );
  });

  it('lehnt ein unbekanntes Blatt ab', () => {
    const matrix = fullFoldMatrix();
    matrix[0] = {
      hand: 'ZZ',
      actions: [{ action: { kind: 'fold', sizing: null }, percent: 100 }],
    };
    const issues = validateChartMatrix(matrix);
    expect(issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(['unknown-hand', 'missing-hands']),
    );
  });

  it('lehnt ein doppelt gelistetes Blatt ab', () => {
    const matrix = fullFoldMatrix();
    matrix[1] = matrix[0] as ChartCell;
    const issues = validateChartMatrix(matrix);
    expect(issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(['duplicate-hand', 'missing-hands']),
    );
  });

  it('lehnt eine Zelle ohne Aktion ab - auch reines Fold wird ausgewiesen', () => {
    const matrix = fullFoldMatrix();
    matrix[3] = { hand: 'AJs', actions: [] };
    const issues = validateChartMatrix(matrix);
    expect(issues.map((issue) => issue.kind)).toContain('empty-cell');
    expect(issues[0]?.message).toContain('Auch reines Fold wird ausgewiesen');
  });

  it('lehnt etwas ab, das gar keine Liste ist', () => {
    expect(validateChartMatrix({ nope: true })[0]?.kind).toBe('missing-hands');
  });
});

describe('Aktionen', () => {
  it('bildet eine stabile Kennung mit und ohne Sizing', () => {
    expect(chartActionKey({ kind: 'fold', sizing: null })).toBe('fold');
    expect(chartActionKey({ kind: 'raise', sizing: '2.5x' })).toBe('raise@2.5x');
  });

  it('beschriftet Aktionen lesbar', () => {
    expect(chartActionLabel({ kind: 'three_bet', sizing: null })).toBe('3-Bet');
    expect(chartActionLabel({ kind: 'raise', sizing: '3.3x' })).toBe('Raise 3.3x');
  });
});
