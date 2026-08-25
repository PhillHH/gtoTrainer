import { describe, expect, it } from 'vitest';
import {
  captionActionsToLegend,
  parseChartAction,
  parseChartSpot,
  toChartMatrix,
} from '../../src/chart/spot.js';

/**
 * Spot und Aktionen kommen **deterministisch aus der Bildunterschrift** - das
 * Modell bekommt sie als Kontext, bestimmt sie aber nicht. Die Beispiele
 * folgen den Schreibweisen, die im Buch tatsaechlich vorkommen.
 */

describe('Aktionsbeschriftung zerlegen', () => {
  it('erkennt die einfachen Arten', () => {
    expect(parseChartAction('Fold')).toEqual({ kind: 'fold', sizing: null });
    expect(parseChartAction('Call')).toEqual({ kind: 'call', sizing: null });
    expect(parseChartAction('Limp')).toEqual({ kind: 'limp', sizing: null });
    expect(parseChartAction('Check')).toEqual({ kind: 'check', sizing: null });
    expect(parseChartAction('All-in')).toEqual({ kind: 'all_in', sizing: null });
  });

  it('trennt Aktionsart und Groessenangabe', () => {
    expect(parseChartAction('Raise 2.25x')).toEqual({ kind: 'raise', sizing: '2.25x' });
    expect(parseChartAction('Raise 3.3x')).toEqual({ kind: 'raise', sizing: '3.3x' });
    expect(parseChartAction('3Bet 10bb')).toEqual({ kind: 'three_bet', sizing: '10bb' });
    expect(parseChartAction('Bet Full Pot')).toEqual({ kind: 'bet', sizing: 'pot' });
  });

  it('ordnet mehrstufige Bets der richtigen Stufe zu', () => {
    expect(parseChartAction('3-bet')).toEqual({ kind: 'three_bet', sizing: null });
    expect(parseChartAction('4-bet 2.2x')).toEqual({ kind: 'four_bet', sizing: '2.2x' });
    // "5-bet All-in" ist ein 5-Bet, nicht ein All-in.
    expect(parseChartAction('5-bet All-in')).toEqual({ kind: 'five_bet', sizing: 'all-in' });
    // "Call All-in" ist ein Call.
    expect(parseChartAction('Call All-in')).toEqual({ kind: 'call', sizing: 'all-in' });
  });

  it('liest eine blosse Groessenangabe als Raise', () => {
    expect(parseChartAction('3.5x')).toEqual({ kind: 'raise', sizing: '3.5x' });
  });

  it('gibt bei Unbekanntem null zurueck, statt zu raten', () => {
    expect(parseChartAction('Irgendwas')).toBeNull();
    expect(parseChartAction('   ')).toBeNull();
  });

  it('baut aus den Caption-Aktionen die Legende und meldet Unzuordenbares', () => {
    const result = captionActionsToLegend([
      { action: 'All-in', percent: 1.8 },
      { action: 'Raise 3.3x', percent: 30 },
      { action: 'Limp', percent: 50.3 },
      { action: 'Fold', percent: 17.9 },
      { action: 'Hokuspokus', percent: 0 },
    ]);
    expect(result.actions).toEqual([
      { kind: 'all_in', sizing: null },
      { kind: 'raise', sizing: '3.3x' },
      { kind: 'limp', sizing: null },
      { kind: 'fold', sizing: null },
    ]);
    expect(result.unmapped).toEqual(['Hokuspokus']);
  });
});

describe('Spot aus der Unterschrift', () => {
  it('liest Positionen und Stacktiefe', () => {
    const spot = parseChartSpot('SB vs BB (15bb)');
    expect(spot.heroPosition).toBe('SB');
    expect(spot.villainPosition).toBe('BB');
    expect(spot.stackDepthBb).toBe(15);
  });

  it('liest Aktionsfolge und Sizing', () => {
    const spot = parseChartSpot('BB defend vs CO 2.25x (40bb)', [
      { action: 'Call', percent: 56.8 },
    ]);
    expect(spot.heroPosition).toBe('BB');
    expect(spot.villainPosition).toBe('CO');
    expect(spot.stackDepthBb).toBe(40);
    expect(spot.sizings).toContain('2.25x');
  });

  it('liest die Aktionsfolge aus der Klammer', () => {
    const spot = parseChartSpot('CO 25bb (2x vs SB 3x 3-bet)');
    expect(spot.heroPosition).toBe('CO');
    expect(spot.actionSequence).toBe('2x vs SB 3x 3-bet');
    expect(spot.stackDepthBb).toBe(25);
  });

  it('nimmt bei einer Spanne die obere Stacktiefe', () => {
    expect(parseChartSpot('BN Open vs BB Rejam (10-25bb)').stackDepthBb).toBe(25);
  });

  it('laesst unbekannt, was die Unterschrift nicht hergibt', () => {
    const spot = parseChartSpot('The Basic Hand Grid');
    expect(spot.heroPosition).toBeNull();
    expect(spot.stackDepthBb).toBeNull();
    expect(spot.actionSequence).toBeNull();
    expect(spot.format).toBeNull();
  });

  it('kommt ohne Unterschrift zurecht', () => {
    expect(parseChartSpot(null).heroPosition).toBeNull();
  });
});

describe('Modellantwort in die Matrix umformen', () => {
  it('uebernimmt Blatt, Aktionsart, Sizing und Prozent', () => {
    const matrix = toChartMatrix([
      { hand: 'AA', aktionen: [{ art: 'raise', sizing: '2.5x', prozent: 100 }] },
      { hand: '72o', aktionen: [{ art: 'fold', prozent: 100 }] },
    ]);
    expect(matrix).toEqual([
      { hand: 'AA', actions: [{ action: { kind: 'raise', sizing: '2.5x' }, percent: 100 }] },
      { hand: '72o', actions: [{ action: { kind: 'fold', sizing: null }, percent: 100 }] },
    ]);
  });

  it('verwirft eine unbekannte Aktionsart, statt sie zu erfinden', () => {
    const matrix = toChartMatrix([{ hand: 'AA', aktionen: [{ art: 'muck', prozent: 100 }] }]);
    expect(matrix[0]?.actions).toEqual([]);
  });

  it('kommt mit einer Antwort zurecht, die keine Liste ist', () => {
    expect(toChartMatrix('nichts')).toEqual([]);
  });
});
