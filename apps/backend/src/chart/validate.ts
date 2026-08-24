import {
  ALL_CHECKS,
  CARD_RANKS,
  CHART_HANDS,
  CHART_HAND_COUNT,
  CHART_TOLERANCES,
  FINDING_CHECK,
  handComboWeight,
} from '@gto/shared';
import type {
  ChartCheckOptions,
  ChartFinding,
  ChartFindingKind,
  ChartFindingSeverity,
  ChartMatrix,
  ChartValidationResult,
} from '@gto/shared';

/**
 * Die drei Prüfungen der Chart-Validierung (AP3.T3.4).
 *
 * **Deterministischer Code, keine KI.** Eine KI, die eine KI prüft, teilt
 * deren Fehler; hier wird gerechnet. Die einzige Stelle, an der in T3.4 ein
 * Modell zum Einsatz kommt, ist der gezielte Zweitdurchlauf — und der liest
 * das Bild neu, statt die Zahlen zu beurteilen.
 *
 * Die Prüfungen sind **unabhängig**:
 *
 * 1. `frequency-sum` rechnet innerhalb der Matrix.
 * 2. `caption-match` hält die Matrix gegen die Prozentwerte der
 *    Bildunterschrift aus T3.1 — die hat kein Modell je gesehen.
 * 3. `plausibility` prüft die Form gegen Pokerwissen, unabhängig von beidem.
 */

/* -------------------------------------------------------------------------
 * Hilfen
 * ---------------------------------------------------------------------- */

/** Rangwert eines Kartenzeichens: A = 12 … 2 = 0. */
const RANK_VALUE: ReadonlyMap<string, number> = new Map(
  CARD_RANKS.map((rank, index) => [rank, CARD_RANKS.length - 1 - index]),
);

type Category = 'pair' | 'suited' | 'offsuit';

interface ParsedHand {
  readonly hand: string;
  readonly category: Category;
  readonly high: number;
  readonly low: number;
}

/** Zerlegt eine Blattbezeichnung in Kategorie und Rangwerte. */
export function parseHand(hand: string): ParsedHand | undefined {
  const first = RANK_VALUE.get(hand[0] ?? '');
  const second = RANK_VALUE.get(hand[1] ?? '');
  if (first === undefined || second === undefined) return undefined;

  const suffix = hand.slice(2);
  const category: Category = suffix === 's' ? 'suited' : suffix === 'o' ? 'offsuit' : 'pair';
  if (category === 'pair' && first !== second) return undefined;

  return { hand, category, high: Math.max(first, second), low: Math.min(first, second) };
}

/**
 * Aggressionsanteil einer Zelle: alles, was nicht Fold ist.
 *
 * Der Wert taugt als eine Zahl je Blatt, an der sich Monotonie und Ausreißer
 * messen lassen, ohne die Aktionsstruktur des Charts zu kennen.
 */
export function aggression(
  actions: readonly { action: { kind: string }; percent: number }[],
): number {
  return actions
    .filter((entry) => entry.action.kind !== 'fold')
    .reduce((sum, entry) => sum + entry.percent, 0);
}

/**
 * Combo-gewichtete Gesamtfrequenz je Aktionsart.
 *
 * Genau die Rechnung, mit der das Buch seine Caption-Prozente bildet: Paare
 * zählen 6 Kombinationen, suited 4, offsuit 12. Eine ungewichtete Mittelung
 * über 169 Zellen liegt systematisch daneben, weil offsuit dreimal so schwer
 * wiegt wie suited und doppelt so schwer wie ein Paar.
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

/** Dieselbe Rechnung **ohne** Gewichtung - nur fuer den Vergleichstest. */
export function unweightedTotals(matrix: ChartMatrix): Record<string, number> {
  const sums = new Map<string, number>();
  for (const cell of matrix) {
    for (const entry of cell.actions) {
      sums.set(entry.action.kind, (sums.get(entry.action.kind) ?? 0) + entry.percent / 100);
    }
  }
  if (matrix.length === 0) return {};
  return Object.fromEntries(
    [...sums.entries()].map(([kind, sum]) => [kind, (sum / matrix.length) * 100]),
  );
}

function finding(
  kind: ChartFindingKind,
  severity: ChartFindingSeverity,
  detail: string,
  extra: Partial<Pick<ChartFinding, 'hand' | 'actionKind' | 'measured' | 'expected'>> = {},
): ChartFinding {
  return {
    check: FINDING_CHECK[kind],
    kind,
    severity,
    hand: extra.hand ?? null,
    actionKind: extra.actionKind ?? null,
    measured: extra.measured ?? null,
    expected: extra.expected ?? null,
    detail,
  };
}

/* -------------------------------------------------------------------------
 * Prüfung 1 — Frequenzsumme je Hand
 * ---------------------------------------------------------------------- */

/**
 * Die Anteile einer Zelle müssen zusammen ungefähr 100 % ergeben.
 *
 * Der Befund ist **zellgenau**, nicht „Chart fehlerhaft": Der Zweitdurchlauf
 * soll gezielt auf die betroffenen Blätter hinweisen können.
 */
export function checkFrequencySum(matrix: ChartMatrix): ChartFinding[] {
  const findings: ChartFinding[] = [];
  const tolerance = CHART_TOLERANCES.frequencySumPp;

  for (const cell of matrix) {
    const sum = cell.actions.reduce((total, entry) => total + entry.percent, 0);
    if (Math.abs(sum - 100) <= tolerance) continue;
    findings.push(
      finding(
        'frequency-sum-off',
        'error',
        `Zelle ${cell.hand}: Frequenzen ergeben ${sum.toFixed(1)} % statt 100 % ` +
          `(Toleranz ±${tolerance} pp).`,
        { hand: cell.hand, measured: Number(sum.toFixed(2)), expected: 100 },
      ),
    );
  }

  return findings;
}

/* -------------------------------------------------------------------------
 * Prüfung 2 — Combo-gewichteter Abgleich gegen die Bildunterschrift
 * ---------------------------------------------------------------------- */

/**
 * Hält die Matrix gegen die Prozentwerte der Bildunterschrift.
 *
 * Das ist die einzige Prüfung mit einer **externen** Wahrheit: Die
 * Caption-Werte stammen aus T3.1, wurden dort unverändert gespeichert und sind
 * keinem Modell je gezeigt worden.
 *
 * Ein Chart ohne verwertbare Caption-Prozente fällt **nicht durch** — es ist
 * schlicht nicht prüfbar, und das ist ein Sachverhalt, kein Fehler.
 */
export function checkCaptionMatch(
  matrix: ChartMatrix,
  captionTotals: Readonly<Record<string, number>>,
): ChartFinding[] {
  const kinds = Object.keys(captionTotals);
  if (kinds.length === 0) {
    return [
      finding(
        'caption-not-checkable',
        'info',
        'Die Bildunterschrift nennt keine Aktions-Prozente; der Abgleich ist ' +
          'für dieses Chart nicht möglich. Es braucht eine manuelle Sichtung.',
      ),
    ];
  }

  const totals = weightedTotals(matrix);
  const tolerance = CHART_TOLERANCES.captionMatchPp;
  const findings: ChartFinding[] = [];

  for (const kind of kinds) {
    const expected = captionTotals[kind] as number;
    const measured = totals[kind];

    if (measured === undefined) {
      findings.push(
        finding(
          'caption-missing-action',
          'error',
          `Die Unterschrift nennt "${kind}" mit ${expected.toFixed(1)} %, in der Matrix ` +
            `kommt diese Aktion überhaupt nicht vor.`,
          { actionKind: kind, measured: 0, expected },
        ),
      );
      continue;
    }

    const deviation = Math.abs(measured - expected);
    if (deviation <= tolerance) continue;
    findings.push(
      finding(
        'caption-mismatch',
        'error',
        `Aktion "${kind}": combo-gewichtet ${measured.toFixed(1)} %, Unterschrift ` +
          `${expected.toFixed(1)} % — Abweichung ${deviation.toFixed(1)} pp ` +
          `(Toleranz ±${tolerance} pp).`,
        { actionKind: kind, measured: Number(measured.toFixed(2)), expected },
      ),
    );
  }

  return findings;
}

/* -------------------------------------------------------------------------
 * Prüfung 3 — Plausibilität
 * ---------------------------------------------------------------------- */

/** Vollständigkeit: 169 Zellen, keine ohne Aktion. */
export function checkCompleteness(matrix: ChartMatrix): ChartFinding[] {
  const findings: ChartFinding[] = [];
  const seen = new Set(matrix.map((cell) => cell.hand));
  const missing = CHART_HANDS.filter((hand) => !seen.has(hand));

  if (missing.length > 0) {
    findings.push(
      finding(
        'incomplete-matrix',
        'error',
        `${missing.length} von ${CHART_HAND_COUNT} Blättern fehlen (z. B. ${missing.slice(0, 5).join(', ')}).`,
        { measured: matrix.length, expected: CHART_HAND_COUNT },
      ),
    );
  }

  for (const cell of matrix) {
    if (cell.actions.length > 0) continue;
    findings.push(
      finding('empty-cell', 'error', `Zelle ${cell.hand} trägt keine Aktion.`, { hand: cell.hand }),
    );
  }

  return findings;
}

/**
 * Monotonie über die **Dominanz-Ordnung**, mit Mindestabstand.
 *
 * Ein Blatt dominiert ein anderes derselben Kategorie, wenn beide Ränge
 * mindestens so hoch sind und einer echt höher ist. Für solche Paare gilt:
 * Das stärkere sollte nicht deutlich seltener aggressiv gespielt werden.
 *
 * **Der Mindestabstand ist wesentlich.** Ohne ihn meldet die Heuristik lauter
 * korrekte Charts: `A8s` dominiert `98s`, aber ein Suited Connector wird in
 * vielen Spots tatsächlich aggressiver gespielt als ein schwaches suited Ass —
 * das ist Strategie, kein Lesefehler. Erst bei deutlichem Rangabstand wird die
 * Beziehung verlässlich; die AP-Datei nennt genau solche Paare (`AA` gegen
 * `22`, `AKs` gegen `72s`).
 *
 * Ein erster Entwurf ohne Mindestabstand erzeugte 159 Warnungen über 16
 * Charts, fast alle aus benachbarten Blättern — unbrauchbar für eine Review.
 *
 * Ergebnis sind **Warnungen**, keine Fehler: Hinweisgeber, keine Beweise.
 */
/**
 * Mindestabstand in Rangstufen, ab dem die Dominanz-Ordnung verlaesslich ist.
 *
 * Summe der Rangunterschiede beider Karten. Die Beispiele der AP-Datei liegen
 * hoch: `AKs` gegen `72s` ergibt 18, `AA` gegen `22` sogar 24. Die Fehlalarme
 * lagen niedrig: `A9s` gegen `98s` und `K6s` gegen `76s` ergeben je 6 - und in
 * beiden Faellen ist der Suited Connector strategisch tatsaechlich haeufiger
 * im Spiel als das schwache suited Broadway. Bei 10 verschwinden diese Muster,
 * waehrend die groben Verwechslungen sicher haengen bleiben.
 *
 * Gemessen am echten Bestand: Abstand 6 ergab 80 Warnungen ueber 13 Charts,
 * Abstand 10 deutlich weniger - ohne dass ein echter Lesefehler durchrutschte.
 */
const MIN_DOMINANCE_DISTANCE = 10;

export function checkMonotonicity(matrix: ChartMatrix): ChartFinding[] {
  const byCategory = new Map<Category, { parsed: ParsedHand; value: number }[]>();

  for (const cell of matrix) {
    const parsed = parseHand(cell.hand);
    if (parsed === undefined) continue;
    const list = byCategory.get(parsed.category) ?? [];
    list.push({ parsed, value: aggression(cell.actions) });
    byCategory.set(parsed.category, list);
  }

  const tolerance = CHART_TOLERANCES.monotonicityPp;
  const findings: ChartFinding[] = [];

  for (const entries of byCategory.values()) {
    for (const strong of entries) {
      for (const weak of entries) {
        if (strong === weak) continue;
        const dominates =
          strong.parsed.high >= weak.parsed.high && strong.parsed.low >= weak.parsed.low;
        if (!dominates) continue;

        // Nur deutlich verschiedene Blaetter vergleichen - siehe oben.
        const distance =
          strong.parsed.high - weak.parsed.high + (strong.parsed.low - weak.parsed.low);
        if (distance < MIN_DOMINANCE_DISTANCE) continue;

        const gap = weak.value - strong.value;
        if (gap <= tolerance) continue;
        findings.push(
          finding(
            'monotonicity',
            'warning',
            `${strong.parsed.hand} wird zu ${strong.value.toFixed(0)} % aggressiv gespielt, ` +
              `das dominierte ${weak.parsed.hand} dagegen zu ${weak.value.toFixed(0)} % — ` +
              `${gap.toFixed(0)} pp Unterschied in die falsche Richtung.`,
            {
              hand: strong.parsed.hand,
              measured: Number(strong.value.toFixed(1)),
              expected: Number(weak.value.toFixed(1)),
            },
          ),
        );
      }
    }
  }

  // Bei einer vertauschten Matrix bricht die Ordnung hundertfach. Die Liste
  // wird gekappt, damit der Befund lesbar bleibt - die Zahl steht im Text.
  if (findings.length <= 10) return findings;
  return [
    ...findings.slice(0, 10),
    finding(
      'monotonicity',
      'warning',
      `… und ${findings.length - 10} weitere Verletzungen der Dominanz-Ordnung. ` +
        `So viele auf einmal deuten auf vertauschte Zeilen oder Spalten hin.`,
      { measured: findings.length },
    ),
  ];
}

/**
 * Ausreißer: eine Zelle, die aus dem Muster ihrer Rasternachbarn fällt.
 *
 * Zwei Einschränkungen, beide notwendig:
 *
 * - **Nur Nachbarn derselben Kategorie.** Die Rasternachbarn eines Paares auf
 *   der Diagonale sind ein suited und ein offsuit Blatt. In einem Chart, in
 *   dem alle Paare erhöhen und die meisten anderen Blätter folden, wäre sonst
 *   jedes Paar ein Ausreißer — ein Fehlalarm durch Bauart des Rasters.
 * - **Nur wenn die Nachbarn untereinander einig sind.** Sonst wäre jede Grenze
 *   zwischen zwei Bereichen ein Ausreißer, und ein Chart hat viele Grenzen.
 */
export function checkOutliers(matrix: ChartMatrix): ChartFinding[] {
  const index = new Map(CHART_HANDS.map((hand, position) => [hand, position]));
  const values = new Map<string, number>();
  for (const cell of matrix) values.set(cell.hand, aggression(cell.actions));

  const tolerance = CHART_TOLERANCES.outlierPp;
  const findings: ChartFinding[] = [];

  for (const cell of matrix) {
    const position = index.get(cell.hand);
    const own_category = parseHand(cell.hand)?.category;
    if (position === undefined || own_category === undefined) continue;
    const row = Math.floor(position / 13);
    const column = position % 13;

    const neighbours: number[] = [];
    for (const [deltaRow, deltaColumn] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      const nextRow = row + deltaRow;
      const nextColumn = column + deltaColumn;
      if (nextRow < 0 || nextRow > 12 || nextColumn < 0 || nextColumn > 12) continue;
      const neighbour = CHART_HANDS[nextRow * 13 + nextColumn] as string;
      if (parseHand(neighbour)?.category !== own_category) continue;
      const value = values.get(neighbour);
      if (value !== undefined) neighbours.push(value);
    }
    if (neighbours.length < 3) continue;

    const spread = Math.max(...neighbours) - Math.min(...neighbours);
    if (spread > tolerance / 2) continue; // Nachbarn uneins - keine Aussage.

    const mean = neighbours.reduce((sum, value) => sum + value, 0) / neighbours.length;
    const own = values.get(cell.hand) ?? 0;
    if (Math.abs(own - mean) <= tolerance) continue;

    findings.push(
      finding(
        'outlier',
        'warning',
        `Zelle ${cell.hand} liegt bei ${own.toFixed(0)} % Aggression, ihre Nachbarn ` +
          `einheitlich bei ${mean.toFixed(0)} %.`,
        { hand: cell.hand, measured: Number(own.toFixed(1)), expected: Number(mean.toFixed(1)) },
      ),
    );
  }

  return findings;
}

/* -------------------------------------------------------------------------
 * Alles zusammen
 * ---------------------------------------------------------------------- */

/**
 * Führt die aktivierten Prüfungen aus.
 *
 * `passed` ist genau dann `true`, wenn kein Befund den Schweregrad `error`
 * trägt. Warnungen blockieren nicht — sie sind Hinweise für die Review.
 */
export function validateChart(
  matrix: ChartMatrix,
  captionTotals: Readonly<Record<string, number>>,
  options: ChartCheckOptions = ALL_CHECKS,
): ChartValidationResult {
  const enabled = { ...ALL_CHECKS, ...options };
  const findings: ChartFinding[] = [];

  if (enabled.frequencySum) findings.push(...checkFrequencySum(matrix));
  if (enabled.captionMatch) findings.push(...checkCaptionMatch(matrix, captionTotals));
  if (enabled.completeness) findings.push(...checkCompleteness(matrix));
  if (enabled.monotonicity) findings.push(...checkMonotonicity(matrix));
  if (enabled.outlier) findings.push(...checkOutliers(matrix));

  return {
    findings,
    weightedTotals: weightedTotals(matrix),
    captionTotals,
    passed: !findings.some((entry) => entry.severity === 'error'),
  };
}

/** Die Blätter, auf die sich Fehlerbefunde beziehen - für den Zweitdurchlauf. */
export function flaggedHands(findings: readonly ChartFinding[]): string[] {
  const hands = new Set<string>();
  for (const entry of findings) {
    if (entry.severity !== 'error') continue;
    if (entry.hand !== null) hands.add(entry.hand);
  }
  return [...hands];
}
