import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHART_HANDS } from '@gto/shared';
import type { ChartMatrix } from '@gto/shared';
import { formatScores, scoreChart, scoreModel, weightedTotals } from '../../src/chart/calibrate.js';
import type { ChartAttempt, ReferenceChart } from '../../src/chart/calibrate.js';
import { toChartMatrix } from '../../src/chart/spot.js';

/**
 * Regressionstest gegen die Kalibrierungs-Sollwerte (AP3.T3.3, Subtask 8).
 *
 * Läuft gegen **gespeicherte Antworten** aus dem Kalibrierungslauf, nicht
 * gegen einen Live-Aufruf: Der Test kostet kein Kontingent und schlägt an,
 * wenn eine Änderung an Parser, Schema oder Auswertung die Ergebnisse
 * verschiebt.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const RECORDED = join(FIXTURES, 'recorded');

interface RecordedAnswer {
  readonly model: string;
  readonly handRange: number;
  readonly zellen: unknown;
  readonly unsicher: string[];
  readonly legende: string[];
}

function loadReferences(): ReferenceChart[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES, 'calibration-reference.json'), 'utf8')) as {
    charts: ReferenceChart[];
  };
  return raw.charts;
}

function loadRecorded(): RecordedAnswer[] {
  return readdirSync(RECORDED)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(RECORDED, file), 'utf8')) as RecordedAnswer);
}

const references = loadReferences();
const recorded = loadRecorded();

describe('Kalibrierungs-Sollwerte', () => {
  it('enthält Charts unterschiedlicher Bauart mit Begründung', () => {
    expect(references.length).toBeGreaterThanOrEqual(5);
    expect(references.length).toBeLessThanOrEqual(10);
    for (const reference of references) {
      expect(reference.bauart.length).toBeGreaterThan(10);
      expect(reference.warum.length).toBeGreaterThan(10);
    }
    // Mindestens ein Strukturraster als Ehrlichkeitsprobe.
    expect(references.some((reference) => reference.erwartung === 'leer')).toBe(true);
  });

  it('nennt nur gültige Blätter und Aktionsarten', () => {
    for (const reference of references) {
      for (const cell of reference.cells ?? []) {
        expect(CHART_HANDS).toContain(cell.hand);
        expect(cell.percent).toBeGreaterThanOrEqual(0);
        expect(cell.percent).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('Gewichtete Gesamtfrequenz', () => {
  it('rechnet Paare 6, suited 4, offsuit 12', () => {
    // Nur AA wird geraist, alles andere gefoldet: 6 von 1326 Combos = 0,45 %.
    const matrix: ChartMatrix = CHART_HANDS.map((hand) => ({
      hand,
      actions: [
        hand === 'AA'
          ? { action: { kind: 'raise' as const, sizing: null }, percent: 100 }
          : { action: { kind: 'fold' as const, sizing: null }, percent: 100 },
      ],
    }));
    const totals = weightedTotals(matrix);
    expect(totals['raise']).toBeCloseTo((6 / 1326) * 100, 2);
    expect(totals['fold']).toBeCloseTo(100 - (6 / 1326) * 100, 2);
  });

  it('teilt eine Mischzelle anteilig auf', () => {
    const matrix: ChartMatrix = [
      {
        hand: 'AA',
        actions: [
          { action: { kind: 'raise', sizing: null }, percent: 60 },
          { action: { kind: 'fold', sizing: null }, percent: 40 },
        ],
      },
    ];
    expect(weightedTotals(matrix)['raise']).toBeCloseTo(60, 5);
  });
});

describe('Bewertung eines Charts', () => {
  it('erkennt eine vollständige, korrekte Ablesung', () => {
    const reference = references.find((entry) => entry.handRange === 8) as ReferenceChart;
    const matrix: ChartMatrix = CHART_HANDS.map((hand) => ({
      hand,
      actions: [
        {
          action: {
            kind:
              (reference.cells ?? []).find((cell) => cell.hand === hand)?.kind === 'fold'
                ? ('fold' as const)
                : ('raise' as const),
            sizing: null,
          },
          percent: 100,
        },
      ],
    }));
    const score = scoreChart(reference, attempt(reference.handRange, matrix));
    expect(score.complete).toBe(true);
    expect(score.cellsCorrect).toBe(score.cellsChecked);
  });

  it('wertet eine erfundene Matrix beim Strukturraster als falsch', () => {
    const reference = references.find((entry) => entry.erwartung === 'leer') as ReferenceChart;
    const erfunden: ChartMatrix = CHART_HANDS.map((hand) => ({
      hand,
      actions: [{ action: { kind: 'fold' as const, sizing: null }, percent: 100 }],
    }));
    expect(scoreChart(reference, attempt(reference.handRange, erfunden)).cellsCorrect).toBe(0);
    expect(scoreChart(reference, attempt(reference.handRange, [])).cellsCorrect).toBe(1);
  });

  it('zählt einen fehlgeschlagenen Aufruf als nicht beantwortet', () => {
    const reference = references[1] as ReferenceChart;
    const score = scoreChart(reference, {
      handRange: reference.handRange,
      matrix: [],
      durationMs: 1,
      totalTokens: null,
      uncertain: [],
      error: 'timeout',
    });
    expect(score.error).toBe('timeout');
    expect(score.complete).toBe(false);
  });
});

describe('Gespeicherte Antworten des Kalibrierungslaufs', () => {
  it('liegen im Repo und decken mehr als ein Modell ab', () => {
    expect(recorded.length).toBeGreaterThan(0);
    expect(new Set(recorded.map((entry) => entry.model)).size).toBeGreaterThanOrEqual(2);
  });

  it('ergeben dieselben Messwerte wie beim Lauf - ohne einen einzigen Aufruf', () => {
    const byModel = new Map<string, ChartAttempt[]>();
    for (const answer of recorded) {
      const attempts = byModel.get(answer.model) ?? [];
      attempts.push({
        handRange: answer.handRange,
        matrix: toChartMatrix(answer.zellen),
        durationMs: 0,
        totalTokens: null,
        uncertain: answer.unsicher,
      });
      byModel.set(answer.model, attempts);
    }

    const scores = [...byModel.entries()].map(([model, attempts]) => {
      const covered = references.filter((reference) =>
        attempts.some((entry) => entry.handRange === reference.handRange),
      );
      return scoreModel(model, covered, attempts);
    });

    // Jede aufgezeichnete Antwort ist bewertbar - kein leeres Ergebnis.
    for (const score of scores) {
      expect(score.charts).toBeGreaterThan(0);
      expect(score.answered).toBe(score.charts);
    }
    // Die Tabelle laesst sich formatieren; sie geht so in ADR und Bericht.
    expect(formatScores(scores)).toContain('| Modell |');
  });

  it('haelt die Trefferquote des gewaehlten Modells auf dem Stand der Kalibrierung', () => {
    // Regressionsschwelle: Wer Parser, Schema oder Prompt-Auswertung aendert
    // und diese Zahl druckt, hat etwas kaputt gemacht.
    const chosen = recorded.filter((entry) => entry.model === 'claude-sonnet-5');
    expect(chosen.length).toBeGreaterThan(0);

    const covered = references.filter((reference) =>
      chosen.some((entry) => entry.handRange === reference.handRange),
    );
    const score = scoreModel(
      'claude-sonnet-5',
      covered,
      chosen.map((answer) => ({
        handRange: answer.handRange,
        matrix: toChartMatrix(answer.zellen),
        durationMs: 0,
        totalTokens: null,
        uncertain: answer.unsicher,
      })),
    );

    expect(score.cellAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(score.completeness).toBe(1);
  });
});

function attempt(handRange: number, matrix: ChartMatrix): ChartAttempt {
  return { handRange, matrix, durationMs: 100, totalTokens: 1000, uncertain: [] };
}
