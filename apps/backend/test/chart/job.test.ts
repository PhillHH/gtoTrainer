import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHART_HANDS } from '@gto/shared';
import { LlmError } from '../../src/llm/errors.js';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { jobQueue, rangeChart, rangeChartCell } from '../../src/db/schema.js';
import { CHART_DIGITIZE_JOB } from '../../src/jobs/handlers/chart-digitize.js';
import { enqueueJob, findJob } from '../../src/jobs/queue.js';
import { chartProgress, selectCandidates } from '../../src/chart/store.js';
import { TEST_DATABASE_URL, prepareTestDatabase } from '../db/setup.js';
import { clearAll, createChartRuntime, fullFoldResponse, seedAssets } from './helpers.js';

/**
 * Durchlauf der Chart-Pipeline gegen einen **gemockten** Provider. Kein Test
 * setzt einen echten Vision-Aufruf ab; Queue, Protokoll, Ereignisbus und
 * Datenbank sind echt.
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

async function enqueue(assetId: string, runId = 'run-test'): Promise<string> {
  const job = await enqueueJob(handle.db, {
    jobType: CHART_DIGITIZE_JOB,
    payload: { assetId, runId },
  });
  return job.id;
}

describe('Job "chart.digitize"', () => {
  it('persistiert die Matrix im Zustand raw und vermerkt das Modell', async () => {
    const assets = await seedAssets(handle.db);
    const runtime = createChartRuntime(handle.db, fullFoldResponse());
    const jobId = await enqueue(assets.handRange);

    const outcome = await runtime.worker.runOnce();
    expect(outcome).toMatchObject({ jobId, status: 'done' });

    const [chart] = await handle.db.select().from(rangeChart);
    expect(chart).toMatchObject({
      state: 'raw',
      model: 'claude-sonnet-5',
      runId: 'run-test',
      cellCount: 169,
      failureReason: null,
    });

    const cells = await handle.db.select().from(rangeChartCell);
    expect(cells).toHaveLength(169);
    expect(cells.every((cell) => cell.actionKind === 'fold' && cell.percent === 100)).toBe(true);
  });

  it('schickt Bild und Bildunterschrift an den Provider', async () => {
    const assets = await seedAssets(handle.db);
    const runtime = createChartRuntime(handle.db, fullFoldResponse());
    await enqueue(assets.handRange);
    await runtime.worker.runOnce();

    const content = runtime.provider.calls[0]?.messages[0]?.content ?? [];
    expect(content.some((block) => block.type === 'image')).toBe(true);

    const text = content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text).toContain('Hand Range 1: SB vs BB (15bb)');
    // Der deterministisch gelesene Spot geht als Kontext mit.
    expect(text).toContain('Position: SB');
    expect(text).toContain('Stacktiefe: 15bb');
    expect(text).toContain('`all_in`');
  });

  it('speichert den Spot deterministisch aus der Unterschrift', async () => {
    const assets = await seedAssets(handle.db);
    const runtime = createChartRuntime(handle.db, fullFoldResponse());
    await enqueue(assets.handRange);
    await runtime.worker.runOnce();

    const [chart] = await handle.db.select().from(rangeChart);
    expect(chart?.spot).toMatchObject({
      heroPosition: 'SB',
      villainPosition: 'BB',
      stackDepthBb: 15,
    });
  });

  it('unterscheidet ein Bild ohne Aktionsraster von einem Modellfehler', async () => {
    const assets = await seedAssets(handle.db);
    const runtime = createChartRuntime(handle.db, {
      zellen: [],
      unsicher: ['Das Bild zeigt ein Strukturraster ohne Aktionsfarben.'],
      legende: [],
    });
    await enqueue(assets.handRange);
    await runtime.worker.runOnce();

    const [chart] = await handle.db.select().from(rangeChart);
    expect(chart?.state).toBe('failed');
    expect(chart?.cellCount).toBe(0);
    expect(chart?.failureReason).toContain('Kein Aktionsraster im Bild erkannt');
    expect(chart?.failureReason).toContain('Strukturraster');
  });

  it('markiert eine unvollstaendige Matrix als failed statt sie durchzuwinken', async () => {
    const assets = await seedAssets(handle.db);
    const partial = fullFoldResponse();
    partial.zellen = partial.zellen.slice(0, 100);
    const runtime = createChartRuntime(handle.db, partial);
    await enqueue(assets.handRange);
    await runtime.worker.runOnce();

    const [chart] = await handle.db.select().from(rangeChart);
    expect(chart?.state).toBe('failed');
    expect(chart?.cellCount).toBe(100);
    expect(chart?.failureReason).toContain('unvollständig');
  });

  it('setzt kein Chart auf approved', async () => {
    const assets = await seedAssets(handle.db);
    const runtime = createChartRuntime(handle.db, fullFoldResponse());
    await enqueue(assets.handRange);
    await runtime.worker.runOnce();

    const states = await handle.db
      .select({ state: rangeChart.state, n: sql<number>`count(*)::int` })
      .from(rangeChart)
      .groupBy(rangeChart.state);
    expect(states.map((row) => row.state)).not.toContain('approved');
  });
});

describe('Wiederaufnahme', () => {
  it('ueberspringt bereits digitalisierte Charts beim zweiten Lauf', async () => {
    const assets = await seedAssets(handle.db);
    const runtime = createChartRuntime(handle.db, fullFoldResponse());

    // Erster Lauf: ein Kandidat, ein Provider-Aufruf.
    const first = await selectCandidates(handle.db);
    expect(first.map((entry) => entry.assetId)).toEqual([assets.handRange]);
    await enqueue(assets.handRange, 'run-1');
    await runtime.worker.runOnce();
    expect(runtime.provider.calls).toHaveLength(1);

    // Zweiter Lauf: nichts mehr offen, also auch kein Aufruf.
    const second = await selectCandidates(handle.db);
    expect(second).toEqual([]);
    expect(runtime.provider.calls).toHaveLength(1);
  });

  it('verarbeitet mit --redo trotzdem erneut', async () => {
    const assets = await seedAssets(handle.db);
    const runtime = createChartRuntime(handle.db, fullFoldResponse());
    await enqueue(assets.handRange, 'run-1');
    await runtime.worker.runOnce();

    const redo = await selectCandidates(handle.db, { includeDone: true });
    expect(redo.map((entry) => entry.assetId)).toEqual([assets.handRange]);

    await enqueue(assets.handRange, 'run-2');
    await runtime.worker.runOnce();
    expect(runtime.provider.calls).toHaveLength(2);

    // Trotzdem nur ein Datensatz - der Lauf wird ueberschrieben, nicht verdoppelt.
    expect(await handle.db.select().from(rangeChart)).toHaveLength(1);
    const [chart] = await handle.db.select().from(rangeChart);
    expect(chart?.runId).toBe('run-2');
  });
});

describe('Nur hand_range-Assets', () => {
  it('waehlt weder andere Assettypen noch unsicher klassifizierte aus', async () => {
    const assets = await seedAssets(handle.db);
    const candidates = await selectCandidates(handle.db, { includeDone: true });
    expect(candidates.map((entry) => entry.assetId)).toEqual([assets.handRange]);
    expect(candidates.map((entry) => entry.assetId)).not.toContain(assets.table);
    expect(candidates.map((entry) => entry.assetId)).not.toContain(assets.handRangeUncertain);
  });

  it('lehnt einen Job auf eine table sofort ab, ohne Provider-Aufruf', async () => {
    const assets = await seedAssets(handle.db);
    const runtime = createChartRuntime(handle.db, fullFoldResponse());
    const jobId = await enqueue(assets.table);

    const outcome = await runtime.worker.runOnce();
    expect(outcome?.status).toBe('dead');
    expect(outcome?.error).toContain('kein verarbeitbares hand_range-Chart');
    expect(runtime.provider.calls).toHaveLength(0);
    expect((await findJob(handle.db, jobId))?.status).toBe('dead');
  });

  it('zaehlt unsicher klassifizierte Assets getrennt aus', async () => {
    await seedAssets(handle.db);
    const progress = await chartProgress(handle.db);
    expect(progress.handRangeTotal).toBe(1);
    expect(progress.uncertainSkipped).toBe(1);
  });
});

describe('Kontingentgrenze', () => {
  it('legt einen rate_limit-Fehler wieder vor, statt die Charge abzubrechen', async () => {
    const assets = await seedAssets(handle.db);
    const runtime = createChartRuntime(handle.db, fullFoldResponse());
    runtime.provider.nextError = new LlmError({
      kind: 'rate_limit',
      provider: 'api',
      message: 'Wochenlimit der Subscription erreicht.',
    });
    const jobId = await enqueue(assets.handRange);

    const outcome = await runtime.worker.runOnce();
    expect(outcome?.status).toBe('queued');

    const job = await findJob(handle.db, jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    // Nichts geschrieben - der Chart bleibt offen und wird spaeter geholt.
    expect(await handle.db.select().from(rangeChart)).toHaveLength(0);

    // Beim naechsten Anlauf klappt es.
    runtime.provider.nextError = undefined;
    // Der Backoff haette den Job erst spaeter freigegeben; im Test wird die
    // Wartezeit vorgezogen, statt sie abzusitzen.
    await handle.db
      .update(jobQueue)
      .set({ availableAt: new Date(0) })
      .where(eq(jobQueue.id, jobId));
    await runtime.worker.runOnce();
    expect((await findJob(handle.db, jobId))?.status).toBe('done');
  });
});

describe('Fortschritt ueber SSE', () => {
  it('meldet running und done ueber den Ereignisbus', async () => {
    const assets = await seedAssets(handle.db);
    const runtime = createChartRuntime(handle.db, fullFoldResponse());
    await enqueue(assets.handRange);
    await runtime.worker.runOnce();

    expect(runtime.received).toEqual([
      { jobType: CHART_DIGITIZE_JOB, status: 'running' },
      { jobType: CHART_DIGITIZE_JOB, status: 'done' },
    ]);
  });
});

describe('Zellen sind einzeln abfragbar', () => {
  it('findet eine einzelne Hand ohne das ganze Chart zu laden', async () => {
    const assets = await seedAssets(handle.db);
    const response = fullFoldResponse();
    // AA wird zu 70 % geraist und zu 30 % gefoldet.
    response.zellen[0] = {
      hand: 'AA',
      aktionen: [
        { art: 'raise', prozent: 70 },
        { art: 'fold', prozent: 30 },
      ],
    };
    const runtime = createChartRuntime(handle.db, response);
    await enqueue(assets.handRange);
    await runtime.worker.runOnce();

    const rows = await handle.db
      .select({ kind: rangeChartCell.actionKind, percent: rangeChartCell.percent })
      .from(rangeChartCell)
      .where(eq(rangeChartCell.hand, 'AA'));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.kind === 'raise')?.percent).toBe(70);
    expect(CHART_HANDS).toContain('AA');
  });
});
