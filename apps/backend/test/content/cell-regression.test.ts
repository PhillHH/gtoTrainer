import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHART_HANDS } from '@gto/shared';
import type { CellResponse } from '@gto/shared';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { bookAsset, rangeChart, rangeChartCell } from '../../src/db/schema.js';
import { getCell, getChart } from '../../src/content/chart-queries.js';
import { TEST_DATABASE_URL, prepareTestDatabase } from '../db/setup.js';
import { clearAll, seedContent } from './helpers.js';

/**
 * Regressionsanker fuer den Zellabruf (AP3.T3.5, AK8).
 *
 * Die Sollwerte stammen aus `test/chart/fixtures/calibration-reference.json` -
 * den von Hand aus den Bildern abgelesenen Zellen des Kalibrierungslaufs aus
 * T3.3. Sie sind unabhaengig von jeder Vision-Auswertung und damit der
 * einzige Massstab im Repo, gegen den sich „liefert die API den richtigen
 * Wert?" ueberhaupt pruefen laesst.
 *
 * Geprueft wird der **Weg**, nicht das Modell: Die Anker gehen in die
 * Datenbank, und der Zellabruf muss sie unveraendert wieder herausgeben.
 */

interface ReferenceChart {
  readonly handRange: number;
  readonly file: string;
  /** Fehlt bei Charts, fuer die keine Zelle von Hand abgelesen wurde. */
  readonly cells?: readonly { hand: string; kind: string; percent: number }[];
}

const CHART_FIXTURES = fileURLToPath(new URL('../chart/fixtures/', import.meta.url));

const REFERENCE = JSON.parse(
  readFileSync(join(CHART_FIXTURES, 'calibration-reference.json'), 'utf8'),
) as { charts: readonly ReferenceChart[] };

let handle: DbHandle;

beforeAll(async () => {
  await prepareTestDatabase();
  handle = createDb(TEST_DATABASE_URL, { max: 2 });
});

afterAll(async () => {
  await handle.close();
});

describe('Zellabruf gegen die Regressionsanker aus T3.3', () => {
  it('gibt jede von Hand abgelesene Zelle unveraendert zurueck', async () => {
    await clearAll(handle.db);
    const seeded = await seedContent(handle.db);

    const anchors = REFERENCE.charts
      .map((chart) => ({ ...chart, cells: chart.cells ?? [] }))
      .filter((chart) => chart.cells.length > 0);
    expect(anchors.length, 'die Kalibrierungsdatei traegt Ankerzellen').toBeGreaterThan(0);

    let checked = 0;

    for (const anchor of anchors) {
      // Ein freigegebenes Chart je Ankerdatensatz, an ein freies Asset gehaengt.
      const [asset] = await handle.db
        .insert(bookAsset)
        .values({
          relativePath: `bilder/anker-${anchor.handRange}.jpeg`,
          fileName: `anker-${anchor.handRange}.jpeg`,
          sectionId: seeded.sectionIds['ch01/ein-abschnitt'] as string,
          captionRaw: `*Hand Range ${anchor.handRange}: Regressionsanker*`,
          captionLabel: 'Hand Range',
          captionNumber: 900 + anchor.handRange,
          assetType: 'hand_range',
          classificationConfidence: 'certain',
          classificationRule: 'caption-label',
          ordinal: 900 + anchor.handRange,
          contentHash: `hash-anker-${anchor.handRange}`,
        })
        .returning({ id: bookAsset.id });

      const [chart] = await handle.db
        .insert(rangeChart)
        .values({
          assetId: (asset as { id: string }).id,
          state: 'approved',
          model: 'kalibrierung-von-hand',
          runId: 'anker',
          actions: [],
          spot: {},
          uncertain: [],
          cellCount: CHART_HANDS.length,
          approvedAt: new Date(),
        })
        .returning({ id: rangeChart.id });
      const chartId = (chart as { id: string }).id;

      const anchored = new Map(anchor.cells.map((cell) => [cell.hand, cell]));
      await handle.db.insert(rangeChartCell).values(
        CHART_HANDS.map((hand) => {
          const known = anchored.get(hand);
          return {
            chartId,
            hand,
            actionKind: known?.kind ?? 'fold',
            sizing: '',
            percent: known?.percent ?? 100,
          };
        }),
      );

      for (const cell of anchor.cells) {
        const answer = (await getCell(handle.db, chartId, cell.hand)) as CellResponse;
        expect(answer, `HR ${anchor.handRange} / ${cell.hand}`).toBeDefined();
        expect(answer.hand).toBe(cell.hand);
        expect(answer.actions).toEqual([{ kind: cell.kind, sizing: null, percent: cell.percent }]);
        expect(answer.state).toBe('approved');
        checked += 1;
      }

      // Und der Zellabruf sagt dasselbe wie die vollstaendige Matrix - sonst
      // haette man zwei Wahrheiten fuer dieselbe Zahl.
      const detail = await getChart(handle.db, chartId);
      for (const cell of anchor.cells) {
        const inMatrix = detail?.matrix.find((entry) => entry.hand === cell.hand);
        expect(inMatrix?.actions).toEqual([
          { kind: cell.kind, sizing: null, percent: cell.percent },
        ]);
      }
    }

    // 8 (12 Zellen) + 96 (9) + 99 (10) = 31 von Hand abgelesene Zellen.
    expect(checked, 'geprüfte Ankerzellen').toBe(31);
  });
});
