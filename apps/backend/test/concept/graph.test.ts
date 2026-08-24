import { describe, expect, it } from 'vitest';
import { findCycles, hasCycle, selectAcyclicEdges } from '../../src/concept/graph.js';

/**
 * Zyklenpruefung (AP3.T3.2, Subtask 5/9).
 *
 * Ein Zyklus macht den Lernpfad in AP5 unableitbar - deshalb wird er nicht nur
 * irgendwie erkannt, sondern auch indirekt ueber mehrere Kanten.
 */
describe('Prerequisite-Graph: Zyklenpruefung', () => {
  it('erkennt einen direkten Zyklus (A ↔ B)', () => {
    const cycles = findCycles([
      { conceptId: 'B', prerequisiteId: 'A' },
      { conceptId: 'A', prerequisiteId: 'B' },
    ]);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(['A', 'B']));
  });

  it('erkennt einen indirekten Zyklus (A → B → C → A)', () => {
    const cycles = findCycles([
      { conceptId: 'B', prerequisiteId: 'A' },
      { conceptId: 'C', prerequisiteId: 'B' },
      { conceptId: 'A', prerequisiteId: 'C' },
    ]);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(['A', 'B', 'C']));
  });

  it('meldet einen zyklenfreien Graphen als sauber', () => {
    expect(
      hasCycle([
        { conceptId: 'B', prerequisiteId: 'A' },
        { conceptId: 'C', prerequisiteId: 'A' },
        { conceptId: 'D', prerequisiteId: 'B' },
        { conceptId: 'D', prerequisiteId: 'C' },
      ]),
    ).toBe(false);
  });

  it('meldet denselben Zyklus nur einmal, unabhaengig vom Startknoten', () => {
    const cycles = findCycles([
      { conceptId: 'B', prerequisiteId: 'A' },
      { conceptId: 'A', prerequisiteId: 'B' },
      { conceptId: 'A', prerequisiteId: 'Z' },
    ]);
    expect(cycles).toHaveLength(1);
  });

  it('findet mehrere unabhaengige Zyklen', () => {
    const cycles = findCycles([
      { conceptId: 'B', prerequisiteId: 'A' },
      { conceptId: 'A', prerequisiteId: 'B' },
      { conceptId: 'D', prerequisiteId: 'C' },
      { conceptId: 'C', prerequisiteId: 'D' },
    ]);
    expect(cycles).toHaveLength(2);
  });

  it('liefert bei gleicher Eingabe dasselbe Ergebnis', () => {
    const edges = [
      { conceptId: 'B', prerequisiteId: 'A' },
      { conceptId: 'C', prerequisiteId: 'B' },
      { conceptId: 'A', prerequisiteId: 'C' },
    ];
    expect(findCycles(edges)).toEqual(findCycles(edges));
  });
});

describe('Prerequisite-Graph: Kanten auswaehlen', () => {
  it('laesst die Kante weg, die den Zyklus schliesst', () => {
    const { accepted, rejected } = selectAcyclicEdges([
      { conceptId: 'B', prerequisiteId: 'A' },
      { conceptId: 'C', prerequisiteId: 'B' },
      { conceptId: 'A', prerequisiteId: 'C' },
    ]);
    expect(accepted).toHaveLength(2);
    expect(rejected).toEqual([{ conceptId: 'A', prerequisiteId: 'C' }]);
    expect(hasCycle(accepted)).toBe(false);
  });

  it('weist einen Selbstverweis ab', () => {
    const { accepted, rejected } = selectAcyclicEdges([{ conceptId: 'A', prerequisiteId: 'A' }]);
    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(1);
  });

  it('nimmt einen zyklenfreien Graphen unveraendert an', () => {
    const edges = [
      { conceptId: 'B', prerequisiteId: 'A' },
      { conceptId: 'C', prerequisiteId: 'B' },
    ];
    expect(selectAcyclicEdges(edges).accepted).toEqual(edges);
  });
});
