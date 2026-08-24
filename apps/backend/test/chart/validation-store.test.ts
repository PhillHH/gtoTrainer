import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHART_HANDS } from '@gto/shared';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { chartFinding, chartRecheck, rangeChart, rangeChartCell } from '../../src/db/schema.js';
import { CHART_DIGITIZE_JOB } from '../../src/jobs/handlers/chart-digitize.js';
import { CHART_RECHECK_JOB } from '../../src/jobs/handlers/chart-recheck.js';
import { enqueueJob, findJob } from '../../src/jobs/queue.js';
import {
  ApprovalRefused,
  approveAllValidated,
  approveChart,
  chartsWithErrors,
  correctCells,
  markUnusable,
  validateAndStore,
  validationProgress,
} from '../../src/chart/validation-store.js';
import { TEST_DATABASE_URL, prepareTestDatabase } from '../db/setup.js';
import { clearAll, createChartRuntime, fullFoldResponse, seedAssets } from './helpers.js';

/**
 * Zustandsübergänge, Zweitdurchlauf und manuelle Korrektur (AP3.T3.4).
 * Der Provider ist eine Attrappe; Datenbank und Queue sind echt.
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

/**
 * Legt ein digitalisiertes Chart an.
 *
 * Die Caption des Fixture-Assets nennt All-in 23,7 / Limp 61,5 / Fold 14,8 -
 * eine reine Fold-Matrix fällt damit am Caption-Abgleich durch. Genau das
 * braucht der Test für den beanstandeten Fall.
 */
async function digitize(json: unknown = fullFoldResponse()): Promise<string> {
  const assets = await seedAssets(handle.db);
  const runtime = createChartRuntime(handle.db, json);
  await enqueueJob(handle.db, {
    jobType: CHART_DIGITIZE_JOB,
    payload: { assetId: assets.handRange, runId: 'run-test' },
  });
  await runtime.worker.runOnce();
  const [chart] = await handle.db.select().from(rangeChart);
  return (chart as { id: string }).id;
}

/** Eine Antwort, die zur Caption des Fixtures passt (All-in / Limp / Fold). */
function matchingResponse(): ReturnType<typeof fullFoldResponse> {
  // Ziel: all_in 23,7 %, limp 61,5 %, fold 14,8 % combo-gewichtet. Der
  // einfachste Weg: jede Zelle traegt dieselbe Mischung.
  return {
    zellen: CHART_HANDS.map((hand) => ({
      hand,
      aktionen: [
        { art: 'all_in', prozent: 23.7 },
        { art: 'limp', prozent: 61.5 },
        { art: 'fold', prozent: 14.8 },
      ],
    })),
    unsicher: [],
    legende: ['gemischt'],
  };
}

describe('Zustandsübergänge', () => {
  it('setzt ein Chart ohne Fehlerbefund auf validated', async () => {
    const chartId = await digitize(matchingResponse());
    const outcome = await validateAndStore(handle.db, chartId);
    expect(outcome?.passed).toBe(true);
    expect(outcome?.state).toBe('validated');
    expect(outcome?.errors).toBe(0);
  });

  it('laesst ein Chart mit Fehlerbefund auf raw und speichert die Befunde', async () => {
    const chartId = await digitize(); // reine Fold-Matrix, passt nicht zur Caption
    const outcome = await validateAndStore(handle.db, chartId);
    expect(outcome?.passed).toBe(false);
    expect(outcome?.state).toBe('raw');
    expect(outcome?.errors).toBeGreaterThan(0);

    const findings = await handle.db.select().from(chartFinding);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((entry) => entry.check === 'caption-match')).toBe(true);
  });

  it('kann ein Chart mit offenem Befund NICHT automatisch auf approved setzen', async () => {
    const chartId = await digitize();
    await validateAndStore(handle.db, chartId);

    await expect(approveChart(handle.db, chartId)).rejects.toThrowError(ApprovalRefused);
    await expect(approveChart(handle.db, chartId)).rejects.toThrowError(
      /Chart im Zustand "raw" kann nicht freigegeben werden: \d+ offene Fehlerbefunde/,
    );

    const [chart] = await handle.db.select().from(rangeChart);
    expect(chart?.state).toBe('raw');
  });

  it('gibt ein validiertes Chart frei', async () => {
    const chartId = await digitize(matchingResponse());
    await validateAndStore(handle.db, chartId);
    await approveChart(handle.db, chartId);

    const [chart] = await handle.db.select().from(rangeChart);
    expect(chart?.state).toBe('approved');
    expect(chart?.approvedAt).not.toBeNull();
  });

  it('nimmt eine Freigabe durch einen erneuten Lauf nicht zurueck', async () => {
    const chartId = await digitize(matchingResponse());
    await validateAndStore(handle.db, chartId);
    await approveChart(handle.db, chartId);

    const outcome = await validateAndStore(handle.db, chartId);
    expect(outcome?.state).toBe('approved');
  });

  it('gibt alle validierten Charts als Sammelaktion frei', async () => {
    const chartId = await digitize(matchingResponse());
    await validateAndStore(handle.db, chartId);
    expect(await approveAllValidated(handle.db)).toBe(1);
    expect(await approveAllValidated(handle.db)).toBe(0);
  });

  it('verwirft ein Chart nur mit Begruendung', async () => {
    const chartId = await digitize();
    await expect(markUnusable(handle.db, chartId, '  ')).rejects.toThrowError(
      /Begründung ist Pflicht/,
    );
    await markUnusable(handle.db, chartId, 'Bild unscharf, Farben nicht unterscheidbar.');
    const [chart] = await handle.db.select().from(rangeChart);
    expect(chart?.state).toBe('unusable');
    expect(chart?.unusableReason).toContain('unscharf');
  });
});

describe('Manuelle Korrektur', () => {
  it('kennzeichnet korrigierte Zellen als manuell und ueberschreibt den Wert', async () => {
    const chartId = await digitize();
    await correctCells(handle.db, chartId, [
      { hand: 'AA', actions: [{ kind: 'all_in', percent: 100 }] },
    ]);

    const cells = await handle.db
      .select()
      .from(rangeChartCell)
      .where(eq(rangeChartCell.hand, 'AA'));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ actionKind: 'all_in', percent: 100, source: 'manual' });
    expect(cells[0]?.correctedAt).not.toBeNull();
  });

  it('ueberschreibt eine manuelle Korrektur bei einem erneuten Validierungslauf nicht', async () => {
    const chartId = await digitize();
    await correctCells(handle.db, chartId, [
      { hand: 'AA', actions: [{ kind: 'all_in', percent: 100 }] },
    ]);

    await validateAndStore(handle.db, chartId);
    await validateAndStore(handle.db, chartId);

    const cells = await handle.db
      .select()
      .from(rangeChartCell)
      .where(eq(rangeChartCell.hand, 'AA'));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ actionKind: 'all_in', percent: 100, source: 'manual' });
  });
});

describe('Gezielter Zweitdurchlauf', () => {
  it('waehlt ausschliesslich beanstandete Charts aus', async () => {
    const chartId = await digitize();
    await validateAndStore(handle.db, chartId);

    const beanstandet = await chartsWithErrors(handle.db);
    expect(beanstandet.map((entry) => entry.chartId)).toEqual([chartId]);

    // Nach einer Korrektur, die den Befund behebt, faellt das Chart aus der
    // Auswahl - der Zweitdurchlauf kostet dann kein Kontingent mehr.
    await handle.db.delete(chartFinding).where(eq(chartFinding.chartId, chartId));
    await handle.db
      .update(rangeChart)
      .set({ state: 'validated' })
      .where(eq(rangeChart.id, chartId));
    expect(await chartsWithErrors(handle.db)).toEqual([]);
  });

  it('lehnt einen Zweitdurchlauf auf ein unbeanstandetes Chart ab, ohne Provider-Aufruf', async () => {
    const chartId = await digitize(matchingResponse());
    await validateAndStore(handle.db, chartId);

    const runtime = createChartRuntime(handle.db, matchingResponse());
    const before = runtime.provider.calls.length;
    const job = await enqueueJob(handle.db, {
      jobType: CHART_RECHECK_JOB,
      payload: { chartId, runId: 'recheck-test' },
    });
    const outcome = await runtime.worker.runOnce();

    expect(outcome?.status).toBe('dead');
    expect(outcome?.error).toContain('verarbeitet ausschliesslich beanstandete Charts');
    expect(runtime.provider.calls).toHaveLength(before);
    expect((await findJob(handle.db, job.id))?.status).toBe('dead');
  });

  it('haelt die zweite Ablesung gegen die erste und protokolliert die Entscheidung', async () => {
    const chartId = await digitize();
    await validateAndStore(handle.db, chartId);

    // Der zweite Durchlauf liest die Matrix passend zur Caption.
    const runtime = createChartRuntime(handle.db, matchingResponse());
    await enqueueJob(handle.db, {
      jobType: CHART_RECHECK_JOB,
      payload: { chartId, runId: 'recheck-test' },
    });
    const outcome = await runtime.worker.runOnce();
    expect(outcome?.status).toBe('done');
    expect(runtime.provider.calls).toHaveLength(1);

    const [recheck] = await handle.db.select().from(chartRecheck);
    expect(recheck?.cellsCompared).toBe(169);
    expect(recheck?.cellsChanged).toBe(169);
    expect(recheck?.decision).toContain('weicht in 169 Zellen ab');

    // Nach dem Zweitdurchlauf laufen die Pruefungen erneut - das Chart ist
    // jetzt sauber.
    const [chart] = await handle.db.select().from(rangeChart);
    expect(chart?.state).toBe('validated');
  });

  it('laesst von Hand korrigierte Zellen im Zweitdurchlauf unangetastet', async () => {
    const chartId = await digitize();
    await validateAndStore(handle.db, chartId);
    await correctCells(handle.db, chartId, [
      { hand: 'AA', actions: [{ kind: 'check', percent: 100 }] },
    ]);
    await validateAndStore(handle.db, chartId);

    const runtime = createChartRuntime(handle.db, matchingResponse());
    await enqueueJob(handle.db, {
      jobType: CHART_RECHECK_JOB,
      payload: { chartId, runId: 'recheck-test' },
    });
    await runtime.worker.runOnce();

    const cells = await handle.db
      .select()
      .from(rangeChartCell)
      .where(eq(rangeChartCell.hand, 'AA'));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ actionKind: 'check', percent: 100, source: 'manual' });

    const [recheck] = await handle.db.select().from(chartRecheck);
    expect(recheck?.cellsProtected).toBe(1);
    expect(recheck?.decision).toContain('unangetastet');
  });

  it('haelt fest, wenn beide Durchlaeufe uebereinstimmen', async () => {
    const chartId = await digitize();
    await validateAndStore(handle.db, chartId);

    // Der zweite Durchlauf liest dasselbe wie der erste.
    const runtime = createChartRuntime(handle.db, fullFoldResponse());
    await enqueueJob(handle.db, {
      jobType: CHART_RECHECK_JOB,
      payload: { chartId, runId: 'recheck-test' },
    });
    await runtime.worker.runOnce();

    const [recheck] = await handle.db.select().from(chartRecheck);
    expect(recheck?.cellsChanged).toBe(0);
    expect(recheck?.cellsAgreed).toBe(169);
    expect(recheck?.decision).toContain('Befund ist vermutlich echt');

    // Und das Chart bleibt beanstandet.
    const [chart] = await handle.db.select().from(rangeChart);
    expect(chart?.state).toBe('raw');
  });
});

describe('Zaehlstaende', () => {
  it('weist die Approved-Quote gegen alle hand_range-Assets aus', async () => {
    const chartId = await digitize(matchingResponse());
    await validateAndStore(handle.db, chartId);
    await approveChart(handle.db, chartId);

    const progress = await validationProgress(handle.db);
    // Ein Asset ist sicher klassifiziert, eines unsicher - die Quote bezieht
    // sich auf die sicheren.
    expect(progress.handRangeAssets).toBe(1);
    expect(progress.byState['approved']).toBe(1);
    expect(progress.approvedShare).toBe(1);
  });

  it('zaehlt Befunde je Pruefart', async () => {
    const chartId = await digitize();
    await validateAndStore(handle.db, chartId);
    const progress = await validationProgress(handle.db);
    expect(progress.findingsByCheck['caption-match']).toBeGreaterThan(0);
    const [total] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(chartFinding);
    expect(total?.n).toBeGreaterThan(0);
  });
});
