import { describe, expect, it } from 'vitest';
import { CHART_HANDS, CHART_TOLERANCES } from '@gto/shared';
import type { ChartMatrix } from '@gto/shared';
import {
  aggression,
  checkCaptionMatch,
  checkCompleteness,
  checkFrequencySum,
  checkMonotonicity,
  checkOutliers,
  flaggedHands,
  unweightedTotals,
  validateChart,
  weightedTotals,
} from '../../src/chart/validate.js';

/**
 * Die drei Prüfungen (AP3.T3.4). Je Prüfung ein positiver und ein negativer
 * Fall gegen konstruierte Datensätze - kein Testfall hier fasst die Datenbank
 * an, und keiner setzt einen Aufruf ab.
 */

/** Baut eine Matrix aus einer Zuordnung Blatt → Aktionen. */
function matrixOf(
  builder: (hand: string) => { kind: string; percent: number; sizing?: string | null }[],
): ChartMatrix {
  return CHART_HANDS.map((hand) => ({
    hand,
    actions: builder(hand).map((entry) => ({
      action: { kind: entry.kind as never, sizing: entry.sizing ?? null },
      percent: entry.percent,
    })),
  }));
}

/** Alles Fold. */
const allFold = (): ChartMatrix => matrixOf(() => [{ kind: 'fold', percent: 100 }]);

/** Nur Paare erhöhen, alles andere foldet. */
const pairsRaise = (): ChartMatrix =>
  matrixOf((hand) =>
    hand.length === 2 ? [{ kind: 'raise', percent: 100 }] : [{ kind: 'fold', percent: 100 }],
  );

describe('Prüfung 1 — Frequenzsumme je Hand', () => {
  it('nimmt eine Matrix an, deren Zellen zu 100 % summieren', () => {
    expect(checkFrequencySum(allFold())).toEqual([]);
  });

  it('nimmt gerundete Drittel innerhalb der Toleranz an', () => {
    // 33,3 × 3 = 99,9 - im Buch normal, kein Fehler.
    const matrix = matrixOf(() => [
      { kind: 'raise', percent: 33.3 },
      { kind: 'call', percent: 33.3 },
      { kind: 'fold', percent: 33.3 },
    ]);
    expect(checkFrequencySum(matrix)).toEqual([]);
  });

  it('beanstandet eine Zelle, deren Summe zu weit von 100 abweicht', () => {
    const matrix = allFold() as { hand: string; actions: unknown[] }[];
    matrix[0] = {
      hand: 'AA',
      actions: [{ action: { kind: 'raise', sizing: null }, percent: 60 }],
    };
    const findings = checkFrequencySum(matrix as ChartMatrix);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('frequency-sum-off');
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.hand).toBe('AA');
    expect(findings[0]?.detail).toContain('60.0 % statt 100 %');
  });

  it('meldet den Befund zellgenau, damit der Zweitdurchlauf zielen kann', () => {
    const matrix = allFold() as { hand: string; actions: unknown[] }[];
    matrix[0] = { hand: 'AA', actions: [{ action: { kind: 'raise', sizing: null }, percent: 40 }] };
    matrix[5] = {
      hand: 'A9s',
      actions: [{ action: { kind: 'raise', sizing: null }, percent: 40 }],
    };
    expect(flaggedHands(checkFrequencySum(matrix as ChartMatrix)).sort()).toEqual(['A9s', 'AA']);
  });
});

describe('Prüfung 2 — Combo-gewichteter Abgleich gegen die Bildunterschrift', () => {
  it('nimmt eine Matrix an, die zur Unterschrift passt', () => {
    // Nur Paare erhoehen: 13 Paare x 6 Combos = 78 von 1326 = 5,88 %.
    const findings = checkCaptionMatch(pairsRaise(), { raise: 5.9, fold: 94.1 });
    expect(findings).toEqual([]);
  });

  it('beanstandet eine Abweichung jenseits der Toleranz', () => {
    const findings = checkCaptionMatch(pairsRaise(), { raise: 20, fold: 80 });
    expect(findings.map((entry) => entry.kind)).toEqual(['caption-mismatch', 'caption-mismatch']);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.detail).toContain('Abweichung');
    expect(findings[0]?.detail).toContain(`Toleranz ±${CHART_TOLERANCES.captionMatchPp} pp`);
  });

  it('meldet eine Aktion, die in der Matrix gar nicht vorkommt', () => {
    const findings = checkCaptionMatch(allFold(), { fold: 100, all_in: 12 });
    expect(findings.map((entry) => entry.kind)).toContain('caption-missing-action');
    expect(findings.find((entry) => entry.kind === 'caption-missing-action')?.detail).toContain(
      'kommt diese Aktion überhaupt nicht vor',
    );
  });

  it('laesst ein Chart ohne Caption-Prozente nicht durchfallen, sondern meldet es als nicht prüfbar', () => {
    const findings = checkCaptionMatch(allFold(), {});
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('caption-not-checkable');
    expect(findings[0]?.severity).toBe('info');
  });
});

describe('Combo-Gewichtung', () => {
  it('rechnet mit 6/4/12 und nicht ungewichtet', () => {
    const matrix = pairsRaise();

    // Gewichtet: 13 Paare x 6 = 78 Combos von 1326 = 5,88 %.
    expect(weightedTotals(matrix)['raise']).toBeCloseTo((78 / 1326) * 100, 2);
    // Ungewichtet: 13 von 169 Zellen = 7,69 %.
    expect(unweightedTotals(matrix)['raise']).toBeCloseTo((13 / 169) * 100, 2);

    // Die beiden Rechenwege liegen um 1,8 pp auseinander - mehr als die
    // Toleranz von 1,5 pp. Wer ungewichtet rechnet, beanstandet ein korrektes
    // Chart oder laesst ein falsches durch.
    const difference =
      (unweightedTotals(matrix)['raise'] as number) - (weightedTotals(matrix)['raise'] as number);
    expect(difference).toBeGreaterThan(CHART_TOLERANCES.captionMatchPp);

    // Und der Beleg, dass die Pruefung den gewichteten Weg nimmt: gegen die
    // gewichtete Zahl besteht sie, gegen die ungewichtete nicht.
    expect(checkCaptionMatch(matrix, { raise: 5.88, fold: 94.12 })).toEqual([]);
    expect(checkCaptionMatch(matrix, { raise: 7.69, fold: 92.31 }).length).toBeGreaterThan(0);
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

  it('summiert die Aggression einer Zelle ohne Fold', () => {
    expect(
      aggression([
        { action: { kind: 'raise' }, percent: 70 },
        { action: { kind: 'fold' }, percent: 30 },
      ]),
    ).toBe(70);
  });
});

describe('Prüfung 3 — Plausibilität: Vollständigkeit', () => {
  it('nimmt eine vollständige Matrix an', () => {
    expect(checkCompleteness(allFold())).toEqual([]);
  });

  it('beanstandet fehlende Blätter', () => {
    const findings = checkCompleteness(allFold().slice(0, 160));
    expect(findings[0]?.kind).toBe('incomplete-matrix');
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.detail).toContain('9 von 169');
  });

  it('beanstandet eine Zelle ohne Aktion', () => {
    const matrix = allFold() as { hand: string; actions: unknown[] }[];
    matrix[0] = { hand: 'AA', actions: [] };
    const findings = checkCompleteness(matrix as ChartMatrix);
    expect(findings.map((entry) => entry.kind)).toContain('empty-cell');
  });
});

describe('Prüfung 3 — Plausibilität: Monotonie', () => {
  it('meldet nichts bei einer sauberen Range', () => {
    // Alle Paare erhoehen, alles andere foldet: dominanzkonform.
    expect(checkMonotonicity(pairsRaise())).toEqual([]);
  });

  it('vergleicht nur Blaetter mit deutlichem Rangabstand', () => {
    // Zwei Zellen, sonst nichts - so laesst sich die Beziehung isoliert
    // pruefen, ohne dass der Rest der Range dazwischenfunkt.
    const nahe: ChartMatrix = [
      { hand: 'A9s', actions: [{ action: { kind: 'fold', sizing: null }, percent: 100 }] },
      { hand: '98s', actions: [{ action: { kind: 'raise', sizing: null }, percent: 100 }] },
    ];
    // A9s dominiert 98s, aber nur mit Abstand 6. Ein Suited Connector, der
    // haeufiger im Spiel ist als ein schwaches suited Ass, ist Strategie und
    // kein Lesefehler - deshalb kein Befund.
    expect(checkMonotonicity(nahe)).toEqual([]);

    const fern: ChartMatrix = [
      { hand: 'AKs', actions: [{ action: { kind: 'fold', sizing: null }, percent: 100 }] },
      { hand: '72s', actions: [{ action: { kind: 'raise', sizing: null }, percent: 100 }] },
    ];
    // AKs gegen 72s hat Abstand 18 - das Beispiel der AP-Datei. Hier wird
    // gemeldet.
    expect(checkMonotonicity(fern)).toHaveLength(1);
    expect(checkMonotonicity(fern)[0]?.hand).toBe('AKs');
  });

  it('beanstandet, wenn ein deutlich schwächeres Blatt aggressiver gespielt wird', () => {
    // 72s erhoeht, AKs foldet - das Beispiel aus der AP-Datei.
    const matrix = matrixOf((hand) =>
      hand === '72s' ? [{ kind: 'raise', percent: 100 }] : [{ kind: 'fold', percent: 100 }],
    );
    const findings = checkMonotonicity(matrix);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.kind).toBe('monotonicity');
    expect(findings[0]?.severity).toBe('warning');
    expect(findings.some((entry) => entry.detail.includes('72s'))).toBe(true);
  });
});

describe('Prüfung 3 — Plausibilität: Ausreißer', () => {
  it('meldet keinen Ausreißer, wenn Paare erhöhen und der Rest foldet', () => {
    // Die Rasternachbarn eines Paares sind suited und offsuit. Wuerden sie
    // mitgezaehlt, waere jedes Paar ein Ausreisser - ein Fehlalarm durch
    // Bauart des Rasters.
    expect(checkOutliers(pairsRaise())).toEqual([]);
  });

  it('beanstandet eine einzelne Zelle mitten in einer einheitlichen Nachbarschaft', () => {
    const matrix = matrixOf((hand) =>
      hand === '85s' ? [{ kind: 'raise', percent: 100 }] : [{ kind: 'fold', percent: 100 }],
    );
    const findings = checkOutliers(matrix);
    expect(findings.map((entry) => entry.hand)).toContain('85s');
    expect(findings[0]?.severity).toBe('warning');
  });
});

describe('Verfälschter Datensatz', () => {
  it('erkennt eine vertikal gespiegelte Matrix als fehlerhaft', () => {
    // Verfaelschung: Die Zeilen des Rasters werden umgedreht - starke Blaetter
    // stehen dort, wo schwache hingehoeren. Genau der Lesefehler, gegen den die
    // Monotonie-Heuristik gebaut ist.
    const gesund = pairsRaise();
    const werte = new Map(gesund.map((cell) => [cell.hand, cell.actions]));
    const verfaelscht: ChartMatrix = CHART_HANDS.map((hand, index) => {
      const row = Math.floor(index / 13);
      const column = index % 13;
      const quelle = CHART_HANDS[(12 - row) * 13 + column] as string;
      return { hand, actions: werte.get(quelle) as never };
    });

    const result = validateChart(verfaelscht, { raise: 5.9, fold: 94.1 });
    expect(result.passed).toBe(false);
    const kinds = result.findings.map((entry) => entry.kind);
    expect(kinds).toContain('caption-mismatch');
    expect(kinds).toContain('monotonicity');
  });

  it('erkennt eine um eine Zelle verschobene Frequenz', () => {
    const matrix = allFold() as { hand: string; actions: unknown[] }[];
    // Aus 100 % Fold wird 100 % Fold PLUS 30 % Raise - die Summe kippt.
    matrix[42] = {
      hand: CHART_HANDS[42] as string,
      actions: [
        { action: { kind: 'fold', sizing: null }, percent: 100 },
        { action: { kind: 'raise', sizing: null }, percent: 30 },
      ],
    };
    const result = validateChart(matrix as ChartMatrix, { fold: 100 });
    expect(result.passed).toBe(false);
    expect(result.findings.map((entry) => entry.kind)).toContain('frequency-sum-off');
  });
});

describe('Zusammenspiel', () => {
  it('besteht, wenn alle Prüfungen sauber sind', () => {
    const result = validateChart(pairsRaise(), { raise: 5.9, fold: 94.1 });
    expect(result.passed).toBe(true);
    expect(result.findings.filter((entry) => entry.severity === 'error')).toEqual([]);
  });

  it('lässt Warnungen das Bestehen nicht verhindern', () => {
    const matrix = matrixOf((hand) =>
      hand === '85s' ? [{ kind: 'raise', percent: 100 }] : [{ kind: 'fold', percent: 100 }],
    );
    // 85s sind 4 Combos von 1326 = 0,3 %.
    const result = validateChart(matrix, { raise: 0.3, fold: 99.7 });
    expect(result.findings.some((entry) => entry.severity === 'warning')).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('laesst sich je Heuristik abschalten', () => {
    const matrix = matrixOf((hand) =>
      hand === '72s' ? [{ kind: 'raise', percent: 100 }] : [{ kind: 'fold', percent: 100 }],
    );
    const mit = validateChart(matrix, { raise: 0.3, fold: 99.7 });
    const ohne = validateChart(matrix, { raise: 0.3, fold: 99.7 }, { monotonicity: false });
    expect(mit.findings.some((entry) => entry.kind === 'monotonicity')).toBe(true);
    expect(ohne.findings.some((entry) => entry.kind === 'monotonicity')).toBe(false);
  });
});
