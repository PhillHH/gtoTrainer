import { SPOT_STACK_TOLERANCE_BB } from '@gto/shared';
import type {
  ChartFormat,
  ChartPosition,
  ChartSummary,
  SpotCoverage,
  SpotMatch,
  SpotSearchResponse,
} from '@gto/shared';
import type { Database } from '../db/client.js';
import { approvedSummaries } from './chart-queries.js';

/**
 * Spot-Suche (AP3.T3.5, Subtask 5).
 *
 * Die Grundlage der Drills in AP7 und der Handanalyse in AP8. Zwei
 * Eigenschaften machen sie brauchbar statt nur technisch korrekt:
 *
 * 1. **Die Stacktiefe ist ein Bereich, keine Gleichheit.** Das Buch zeigt
 *    Charts für 10, 15, 20, 25, 40 bb. Wer eine Hand mit 22 bb analysiert,
 *    braucht das 20er-Chart — eine Gleichheitssuche gäbe ihm nichts.
 * 2. **Eine leere Antwort erklärt sich.** Wer nach 200 bb sucht, erfährt, dass
 *    der Bestand bei 40 bb endet, statt eine leere Liste anzustarren.
 *
 * Bewertet wird **anteilig**: Jedes angegebene Kriterium bringt Punkte, das
 * Ergebnis ist der erreichte Anteil. Wer nur die Position angibt, bekommt alle
 * Charts dieser Position mit `score = 1`; wer vier Kriterien angibt, bekommt
 * eine feinere Rangfolge.
 */

export interface SpotQuery {
  readonly heroPosition?: ChartPosition | undefined;
  readonly villainPosition?: ChartPosition | undefined;
  readonly stackDepthBb?: number | undefined;
  readonly stackToleranceBb?: number | undefined;
  readonly action?: string | undefined;
  readonly format?: ChartFormat | undefined;
}

/** Gewichte der Kriterien. Position wiegt am schwersten — sie ist der Spot. */
const WEIGHT = {
  heroPosition: 3,
  villainPosition: 2,
  stackDepthBb: 2,
  action: 1.5,
  format: 1,
} as const;

/** Was der Bestand hergibt — die Grundlage jeder Erklärung. */
export function coverageOf(charts: readonly ChartSummary[]): SpotCoverage {
  const depths = charts
    .map((chart) => chart.spot.stackDepthBb)
    .filter((depth): depth is number => depth !== null);

  const unique = <T>(values: readonly (T | null)[]): T[] =>
    [...new Set(values.filter((value): value is T => value !== null))].sort();

  return {
    stackDepthBb: {
      min: depths.length === 0 ? null : Math.min(...depths),
      max: depths.length === 0 ? null : Math.max(...depths),
    },
    heroPositions: unique(charts.map((chart) => chart.spot.heroPosition)),
    villainPositions: unique(charts.map((chart) => chart.spot.villainPosition)),
    formats: unique(charts.map((chart) => chart.spot.format)),
    chartsSearched: charts.length,
  };
}

/**
 * Passt die Aktionsfolge?
 *
 * Bewusst nachsichtig: Die Unterschriften schreiben „2.5x Raise", „2.25x
 * Open", „3-bet all-in". Eine Anfrage nach „raise" soll das erste treffen,
 * eine nach „3-bet" das letzte. Verglichen wird deshalb wortweise gegen
 * Aktionsfolge, Legende und Sizings.
 */
function actionMatches(chart: ChartSummary, action: string): boolean {
  const haystack = [
    chart.spot.actionSequence ?? '',
    ...chart.spot.sizings,
    ...chart.actions.map((entry) => `${entry.kind} ${entry.sizing ?? ''}`),
    chart.captionRaw ?? '',
  ]
    .join(' ')
    .toLowerCase()
    .replace(/[-_]/g, ' ');

  const needles = action.toLowerCase().replace(/[-_]/g, ' ').split(/\s+/).filter(Boolean);
  return needles.length > 0 && needles.every((needle) => haystack.includes(needle));
}

/**
 * „Unopened" heißt: Das Chart zeigt eine Eröffnung, keine Reaktion.
 *
 * Erkennbar daran, dass die Unterschrift keine Gegenposition und keine
 * vorangegangene Aktion nennt.
 */
function isUnopened(chart: ChartSummary): boolean {
  return chart.spot.villainPosition === null && chart.spot.actionSequence === null;
}

/** Bewertet ein Chart gegen die Anfrage. */
function score(chart: ChartSummary, query: SpotQuery, tolerance: number): SpotMatch | undefined {
  const matched: string[] = [];
  const missed: string[] = [];
  let earned = 0;
  let possible = 0;

  if (query.heroPosition !== undefined) {
    possible += WEIGHT.heroPosition;
    if (chart.spot.heroPosition === query.heroPosition) {
      earned += WEIGHT.heroPosition;
      matched.push(`Position ${query.heroPosition}`);
    } else {
      // Die Position ist der Spot. Passt sie nicht, ist das Chart kein
      // Treffer - egal, wie gut der Rest sitzt.
      return undefined;
    }
  }

  if (query.villainPosition !== undefined) {
    possible += WEIGHT.villainPosition;
    if (chart.spot.villainPosition === query.villainPosition) {
      earned += WEIGHT.villainPosition;
      matched.push(`gegen ${query.villainPosition}`);
    } else {
      missed.push(
        chart.spot.villainPosition === null
          ? 'keine Gegenposition in der Unterschrift'
          : `Gegenposition ${chart.spot.villainPosition} statt ${query.villainPosition}`,
      );
    }
  }

  if (query.stackDepthBb !== undefined) {
    possible += WEIGHT.stackDepthBb;
    const depth = chart.spot.stackDepthBb;
    if (depth === null) {
      missed.push('keine Stacktiefe in der Unterschrift');
    } else {
      const distance = Math.abs(depth - query.stackDepthBb);
      if (distance > tolerance) return undefined;
      // Innerhalb der Toleranz linear abfallend: exakt = voll, am Rand = halb.
      earned += WEIGHT.stackDepthBb * (1 - (distance / tolerance) * 0.5);
      matched.push(distance === 0 ? `${depth}bb (exakt)` : `${depth}bb (${distance}bb daneben)`);
    }
  }

  if (query.action !== undefined) {
    possible += WEIGHT.action;
    const unopened = /^unopened$|^rfi$|^open$/i.test(query.action.trim());
    const hit = unopened ? isUnopened(chart) : actionMatches(chart, query.action);
    if (hit) {
      earned += WEIGHT.action;
      matched.push(unopened ? 'unopened (Eröffnung)' : `Aktion „${query.action}"`);
    } else {
      missed.push(`Aktion „${query.action}" nicht in der Unterschrift`);
    }
  }

  if (query.format !== undefined) {
    possible += WEIGHT.format;
    if (chart.spot.format === query.format) {
      earned += WEIGHT.format;
      matched.push(`Spielform ${query.format}`);
    } else {
      missed.push(
        chart.spot.format === null
          ? 'keine Spielform in der Unterschrift'
          : `Spielform ${chart.spot.format} statt ${query.format}`,
      );
    }
  }

  if (possible === 0) return { chart, score: 1, matched: ['keine Einschränkung'], missed: [] };
  return { chart, score: Number((earned / possible).toFixed(4)), matched, missed };
}

/**
 * Erklärt, warum nichts (oder wenig) gefunden wurde.
 *
 * Die Reihenfolge der Prüfungen ist die Reihenfolge der wahrscheinlichsten
 * Ursachen. Es wird nur genannt, was nachweislich am Bestand scheitert.
 */
function explain(
  query: SpotQuery,
  tolerance: number,
  coverage: SpotCoverage,
  matches: readonly SpotMatch[],
): string {
  if (matches.length > 0) {
    const head = `${matches.length} von ${coverage.chartsSearched} freigegebenen Charts passen zur Anfrage.`;
    const best = matches[0] as SpotMatch;
    if (best.score >= 0.75) return head;

    // Treffer, aber nur schwache. Das ist kein Erfolg, den man unkommentiert
    // stehen laesst - wer hier blind den ersten Treffer nimmt, unterrichtet
    // womoeglich den falschen Spot.
    return (
      `${head} Der beste Treffer erreicht nur ${Math.round(best.score * 100)} % ` +
      `Übereinstimmung: ${best.missed.join('; ')}. ` +
      `Die Bildunterschriften des Buchs nennen nicht zu jedem Chart alle Angaben — ` +
      `vor der Verwendung die Spot-Metadaten des Treffers prüfen.`
    );
  }

  if (coverage.chartsSearched === 0) {
    return (
      'Es ist noch kein Chart freigegeben. Die Digitalisierung (T3.3) und die ' +
      'Freigabe (T3.4) müssen erst laufen — die Suche hat nichts zu durchsuchen.'
    );
  }

  const reasons: string[] = [];

  if (query.heroPosition !== undefined && !coverage.heroPositions.includes(query.heroPosition)) {
    reasons.push(
      `Für die Position ${query.heroPosition} ist kein Chart freigegeben. Vorhanden: ` +
        `${coverage.heroPositions.join(', ') || 'keine'}.`,
    );
  }

  if (query.stackDepthBb !== undefined) {
    const { min, max } = coverage.stackDepthBb;
    if (min === null || max === null) {
      reasons.push('Keines der freigegebenen Charts nennt eine Stacktiefe.');
    } else if (query.stackDepthBb + tolerance < min || query.stackDepthBb - tolerance > max) {
      reasons.push(
        `${query.stackDepthBb}bb (±${tolerance}) liegt außerhalb des abgedeckten Bereichs ` +
          `von ${min} bis ${max} bb.`,
      );
    }
  }

  if (
    query.villainPosition !== undefined &&
    !coverage.villainPositions.includes(query.villainPosition)
  ) {
    reasons.push(
      `Gegen ${query.villainPosition} ist kein Chart freigegeben. Vorhanden: ` +
        `${coverage.villainPositions.join(', ') || 'keine'}.`,
    );
  }

  if (query.format !== undefined && !coverage.formats.includes(query.format)) {
    reasons.push(
      `Für die Spielform ${query.format} ist kein Chart freigegeben. Vorhanden: ` +
        `${coverage.formats.join(', ') || 'keine'}.`,
    );
  }

  if (reasons.length === 0) {
    reasons.push(
      'Jedes Kriterium für sich kommt im Bestand vor, aber kein Chart erfüllt sie ' +
        'gemeinsam. Weniger Kriterien angeben oder die Stacktiefen-Toleranz erhöhen.',
    );
  }

  return reasons.join(' ');
}

/** Sucht Charts zu einem Spot. */
export async function searchSpots(
  db: Database,
  query: SpotQuery,
  options: { readonly includeUnapproved?: boolean; readonly limit?: number } = {},
): Promise<SpotSearchResponse> {
  const tolerance = query.stackToleranceBb ?? SPOT_STACK_TOLERANCE_BB;
  const charts = await approvedSummaries(db, options.includeUnapproved === true);
  const coverage = coverageOf(charts);

  const matches = charts
    .map((chart) => score(chart, query, tolerance))
    .filter((match): match is SpotMatch => match !== undefined)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.chart.captionNumber ?? Number.MAX_SAFE_INTEGER) -
          (b.chart.captionNumber ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, options.limit ?? 25);

  return {
    matches,
    query: {
      heroPosition: query.heroPosition ?? null,
      villainPosition: query.villainPosition ?? null,
      stackDepthBb: query.stackDepthBb ?? null,
      stackToleranceBb: tolerance,
      action: query.action ?? null,
      format: query.format ?? null,
    },
    coverage,
    explanation: explain(query, tolerance, coverage, matches),
  };
}
