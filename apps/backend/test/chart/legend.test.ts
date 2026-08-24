import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHART_HANDS } from '@gto/shared';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { bookAsset, chartFinding, rangeChart } from '../../src/db/schema.js';
import { legendTotalsOf } from '../../src/chart/spot.js';
import { readExtraction, readLegendValues } from '../../src/jobs/handlers/chart-digitize.js';
import { CHART_DIGITIZE_JOB } from '../../src/jobs/handlers/chart-digitize.js';
import { CHART_LEGEND_JOB } from '../../src/jobs/handlers/chart-legend.js';
import { enqueueJob } from '../../src/jobs/queue.js';
import { validateAndStore, validationProgress } from '../../src/chart/validation-store.js';
import { TEST_DATABASE_URL, prepareTestDatabase } from '../db/setup.js';
import { clearAll, createChartRuntime, fullFoldResponse, seedAssets } from './helpers.js';

/**
 * Gedruckte Legende und die vierte Prüfung (AP3.T3.6-fix).
 *
 * Der Kern dieser Datei ist eine Zusicherung: Die Legendenwerte sind eine
 * **unabhängige Beobachtung**. Sie kommen aus der Modellantwort und werden
 * nirgends aus der Matrix hergeleitet — sonst prüfte die Validierung sich
 * selbst, und der Befund aus T3.6 wiederholte sich unbemerkt.
 */

let handle: DbHandle;

beforeAll(async () => {
  await prepareTestDatabase();
  handle = createDb(TEST_DATABASE_URL, { max: 2 });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await clearAll(handle.db);
});

/** Eine Antwort mit Matrix **und** gedruckter Legende. */
function responseWithLegend(options: {
  aggressive: (hand: string) => boolean;
  kind: string;
  legend: { art: string; prozent: number; beschriftung: string }[];
}): Record<string, unknown> {
  return {
    zellen: CHART_HANDS.map((hand) => ({
      hand,
      aktionen: options.aggressive(hand)
        ? [{ art: options.kind, prozent: 100 }]
        : [{ art: 'fold', prozent: 100 }],
    })),
    unsicher: [],
    legende: ['rot = ' + options.kind],
    legendenwerte: options.legend,
    legendenwerte_vorhanden: options.legend.length > 0,
  };
}

async function digitize(json: unknown): Promise<string> {
  const assets = await seedAssets(handle.db);
  const runtime = createChartRuntime(handle.db, json);
  await enqueueJob(handle.db, {
    jobType: CHART_DIGITIZE_JOB,
    payload: { assetId: assets.handRange, runId: 'run-legend-test' },
  });
  await runtime.worker.runOnce();
  const [chart] = await handle.db.select().from(rangeChart);
  return (chart as { id: string }).id;
}

describe('Legenden-Ablesung im Digitalisierungslauf', () => {
  it('erfasst Matrix und gedruckte Legende im selben Aufruf', async () => {
    // Nur Paare: 78 von 1326 Combos = 5,88 %. Die Legende nennt genau das.
    const runtime = createChartRuntime(
      handle.db,
      responseWithLegend({
        aggressive: (hand) => hand.length === 2,
        kind: 'raise',
        legend: [
          { art: 'raise', prozent: 5.88, beschriftung: 'Raise 2.5x' },
          { art: 'fold', prozent: 94.12, beschriftung: 'Off Range' },
        ],
      }),
    );
    const assets = await seedAssets(handle.db);
    await enqueueJob(handle.db, {
      jobType: CHART_DIGITIZE_JOB,
      payload: { assetId: assets.handRange, runId: 'run-legend-test' },
    });
    await runtime.worker.runOnce();

    // **Ein** Provider-Aufruf fuer beides - alles andere wuerde den
    // Kontingentbedarf des Vollausbaus verdoppeln.
    expect(runtime.provider.calls).toHaveLength(1);

    const [chart] = await handle.db.select().from(rangeChart);
    expect(chart?.cellCount).toBe(169);
    expect(chart?.legendPresent).toBe(true);
    expect(chart?.legendTotals).toEqual({ raise: 5.88, fold: 94.12 });
    expect(chart?.legendLabels).toEqual(['Raise 2.5x = 5.88 %', 'Off Range = 94.12 %']);
  });

  it('vermerkt ein Bild ohne gedruckte Legende als solches, statt zu schaetzen', async () => {
    const chartId = await digitize(fullFoldResponse());
    const [chart] = await handle.db.select().from(rangeChart).where(eq(rangeChart.id, chartId));
    expect(chart?.legendPresent).toBe(false);
    expect(chart?.legendTotals).toEqual({});
  });

  it('glaubt einem "vorhanden" ohne Werte nicht', () => {
    const parsed = readExtraction({
      zellen: [],
      unsicher: [],
      legende: [],
      legendenwerte: [],
      legendenwerte_vorhanden: true,
    });
    expect(parsed.legendenwerteVorhanden).toBe(false);
  });

  it('verwirft Legendeneintraege ohne brauchbare Zahl', () => {
    const values = readLegendValues([
      { art: 'raise', prozent: 31.2, beschriftung: 'Raise' },
      { art: 'call', prozent: 'viel', beschriftung: 'Call' },
      { art: 'quatsch', prozent: 10, beschriftung: 'Quatsch' },
      'kein Objekt',
    ]);
    // Die kaputte Zahl faellt weg, die unbekannte Aktionsart bleibt zunaechst
    // erhalten und wird erst bei der Zuordnung verworfen.
    expect(values.map((entry) => entry.art)).toEqual(['raise', 'quatsch']);

    const { totals, labels } = legendTotalsOf(values);
    expect(totals).toEqual({ raise: 31.2 });
    // Die unzuordenbare Zeile bleibt als Beschriftung sichtbar - eine Luecke,
    // die man sehen kann, ist besser als eine, die verschwindet.
    expect(labels).toEqual(['Raise = 31.2 %', 'Quatsch = 10 %']);
  });

  it('leitet die Legende NIE aus der Matrix ab', () => {
    // Die Matrix sagt 5,88 % raise, die Legende behauptet 40 %. Wuerde
    // irgendwo gerechnet statt abgelesen, staende hier 5,88.
    const { totals } = legendTotalsOf([
      { art: 'raise', prozent: 40, beschriftung: 'Raise', sizing: null },
      { art: 'fold', prozent: 60, beschriftung: 'Fold', sizing: null },
    ]);
    expect(totals).toEqual({ raise: 40, fold: 60 });
  });
});

describe('Vierte Prüfung am Datensatz', () => {
  it('beanstandet ein Chart, dessen Matrix der Legende widerspricht', async () => {
    // Legende: 40 % raise. Matrix: nur Paare, also 5,88 %. Differenz 34 pp.
    const chartId = await digitize(
      responseWithLegend({
        aggressive: (hand) => hand.length === 2,
        kind: 'raise',
        legend: [
          { art: 'raise', prozent: 40, beschriftung: 'Raise 2.5x' },
          { art: 'fold', prozent: 60, beschriftung: 'Off Range' },
        ],
      }),
    );
    const outcome = await validateAndStore(handle.db, chartId);
    expect(outcome?.passed).toBe(false);

    const findings = await handle.db
      .select()
      .from(chartFinding)
      .where(eq(chartFinding.chartId, chartId));
    const legend = findings.filter((entry) => entry.check === 'legend-match');
    expect(legend.length).toBeGreaterThan(0);
    expect(legend.every((entry) => entry.severity === 'error')).toBe(true);
    expect(legend.some((entry) => entry.detail.includes('Legende im Bild'))).toBe(true);
  });

  it('nimmt ein Chart an, dessen Matrix zur Legende passt', async () => {
    const chartId = await digitize(
      responseWithLegend({
        aggressive: (hand) => hand.length === 2,
        kind: 'all_in',
        legend: [
          { art: 'all_in', prozent: 5.88, beschriftung: 'All-in' },
          { art: 'fold', prozent: 94.12, beschriftung: 'Fold' },
        ],
      }),
    );
    const outcome = await validateAndStore(handle.db, chartId);
    const legend = outcome?.result.findings.filter((entry) => entry.check === 'legend-match') ?? [];
    expect(legend.filter((entry) => entry.severity === 'error')).toEqual([]);
  });

  it('faengt ein Chart, das der Caption-Abgleich nicht sehen kann', async () => {
    // Ein Chart, dessen Bildunterschrift keine Prozente nennt - im echten
    // Bestand der Regelfall (19 von 25 lesbaren Charts). Dort ist die Legende
    // die einzige externe Wahrheit.
    const assets = await seedAssets(handle.db);
    await handle.db
      .update(bookAsset)
      .set({ captionActions: [] })
      .where(eq(bookAsset.id, assets.handRange));

    const runtime = createChartRuntime(
      handle.db,
      responseWithLegend({
        aggressive: (hand) => hand.length === 2,
        kind: 'raise',
        legend: [
          { art: 'raise', prozent: 40, beschriftung: 'Raise' },
          { art: 'fold', prozent: 60, beschriftung: 'Fold' },
        ],
      }),
    );
    await enqueueJob(handle.db, {
      jobType: CHART_DIGITIZE_JOB,
      payload: { assetId: assets.handRange, runId: 'run-legend-test' },
    });
    await runtime.worker.runOnce();

    const [chart] = await handle.db.select().from(rangeChart);
    const outcome = await validateAndStore(handle.db, (chart as { id: string }).id);

    const kinds = outcome?.result.findings.map((entry) => entry.kind) ?? [];
    // Der Caption-Abgleich kapituliert ...
    expect(kinds).toContain('caption-not-checkable');
    // ... der Legenden-Abgleich nicht.
    expect(kinds).toContain('legend-mismatch');
    expect(outcome?.passed).toBe(false);
  });

  it('weist die Abdeckung beider Gegenproben aus', async () => {
    await digitize(
      responseWithLegend({
        aggressive: (hand) => hand.length === 2,
        kind: 'raise',
        legend: [{ art: 'raise', prozent: 5.88, beschriftung: 'Raise' }],
      }),
    );
    const progress = await validationProgress(handle.db);
    expect(progress.chartsWithLegend).toBe(1);
    expect(progress.chartsWithCaptionPercents).toBe(1);
  });
});

describe('Legenden-Nachzug als eigener Job', () => {
  it('liest nur die Legende und laesst die Matrix unangetastet', async () => {
    const chartId = await digitize(fullFoldResponse());
    const [vorher] = await handle.db.select().from(rangeChart).where(eq(rangeChart.id, chartId));
    expect(vorher?.legendPresent).toBe(false);

    const runtime = createChartRuntime(handle.db, {
      legendenwerte: [{ art: 'fold', prozent: 100, beschriftung: 'Fold' }],
      legendenwerte_vorhanden: true,
      unsicher: [],
    });
    await enqueueJob(handle.db, {
      jobType: CHART_LEGEND_JOB,
      payload: { chartId, runId: 'nachzug' },
    });
    const outcome = await runtime.worker.runOnce();
    expect(outcome?.status).toBe('done');
    expect(runtime.provider.calls).toHaveLength(1);

    const [nachher] = await handle.db.select().from(rangeChart).where(eq(rangeChart.id, chartId));
    expect(nachher?.legendPresent).toBe(true);
    expect(nachher?.legendTotals).toEqual({ fold: 100 });
    // Die Matrix ist dieselbe geblieben.
    expect(nachher?.cellCount).toBe(vorher?.cellCount);
    expect(nachher?.model).toBe(vorher?.model);
  });

  it('kommt mit einer viel kleineren Ausgabegrenze aus als die Digitalisierung', async () => {
    const chartId = await digitize(fullFoldResponse());
    const runtime = createChartRuntime(handle.db, {
      legendenwerte: [{ art: 'fold', prozent: 100, beschriftung: 'Fold' }],
      legendenwerte_vorhanden: true,
      unsicher: [],
    });
    await enqueueJob(handle.db, {
      jobType: CHART_LEGEND_JOB,
      payload: { chartId, runId: 'nachzug' },
    });
    await runtime.worker.runOnce();

    // Der Nachzug schickt keine Blattliste mit - das ist der Sparhebel.
    const prompt = JSON.stringify(runtime.provider.calls[0]);
    expect(prompt).not.toContain('alle 169 Blätter');
    expect(prompt).toContain('Du liest heute nicht das Raster');
  });

  it('verweigert sich bei einem Chart, das schon eine Legende hat', async () => {
    const chartId = await digitize(
      responseWithLegend({
        aggressive: () => false,
        kind: 'fold',
        legend: [{ art: 'fold', prozent: 100, beschriftung: 'Fold' }],
      }),
    );

    const runtime = createChartRuntime(handle.db, {
      legendenwerte: [],
      legendenwerte_vorhanden: false,
      unsicher: [],
    });
    await enqueueJob(handle.db, {
      jobType: CHART_LEGEND_JOB,
      payload: { chartId, runId: 'nachzug' },
    });
    const outcome = await runtime.worker.runOnce();

    expect(outcome?.status).toBe('dead');
    expect(outcome?.error).toContain('bereits eine gelesene Legende');
    // Kein Kontingent fuer Erledigtes.
    expect(runtime.provider.calls).toHaveLength(0);
  });

  it('vermerkt ehrlich, wenn im Bild keine Legende steht', async () => {
    const chartId = await digitize(fullFoldResponse());
    const runtime = createChartRuntime(handle.db, {
      legendenwerte: [],
      legendenwerte_vorhanden: false,
      unsicher: ['Das Bild traegt keinen Legendenkasten.'],
    });
    await enqueueJob(handle.db, {
      jobType: CHART_LEGEND_JOB,
      payload: { chartId, runId: 'nachzug' },
    });
    await runtime.worker.runOnce();

    const [chart] = await handle.db.select().from(rangeChart).where(eq(rangeChart.id, chartId));
    expect(chart?.legendPresent).toBe(false);
    expect(chart?.legendTotals).toEqual({});

    const findings = await handle.db.select().from(chartFinding);
    expect(findings.some((entry) => entry.kind === 'legend-not-checkable')).toBe(true);
  });
});
