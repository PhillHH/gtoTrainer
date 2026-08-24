import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from '@gto/shared';
import type { ReviewChartDetail, ReviewListResponse } from '@gto/shared';
import { rangeChart, rangeChartCell, user } from '../../src/db/schema.js';
import { validateAndStore } from '../../src/chart/validation-store.js';
import { createTestContext, createTestUser, login } from '../auth/helpers.js';
import type { TestContext } from '../auth/helpers.js';
import { MINI_BOOK } from '../book/fixtures.js';
import { clearAll, seedAssets } from './helpers.js';

/**
 * Review-Endpunkte der Chart-Validierung (AP3.T3.4, Subtask 6).
 *
 * Alle Routen sind auth-geschuetzt - insbesondere das Bild: Buchinhalte
 * bleiben auf dem Server und gehen nur an den angemeldeten Pruefer.
 */

const USERNAME = 'chart-review-user';
const PASSWORD = 'chart-review-passwort-lang';

let context: TestContext;
let cookieHeader: string;
let csrfToken: string;
let chartId: string;

beforeAll(async () => {
  context = await createTestContext(undefined, { bookSourceDir: MINI_BOOK });
  await createTestUser(context, USERNAME, PASSWORD);
  const session = await login(context.app, USERNAME, PASSWORD);
  cookieHeader = session.cookieHeader;
  csrfToken = session.csrfToken;
});

afterAll(async () => {
  await context.handle.db.delete(user).where(eq(user.username, USERNAME));
  await context.close();
});

beforeEach(async () => {
  await clearAll(context.handle.db);
  const assets = await seedAssets(context.handle.db);

  // Ein Chart, das zur Caption des Fixtures passt (All-in 23,7 / Limp 61,5 /
  // Fold 14,8): jede Zelle traegt dieselbe Mischung.
  const [row] = await context.handle.db
    .insert(rangeChart)
    .values({
      assetId: assets.handRange,
      model: 'claude-sonnet-5',
      runId: 'run-review-test',
      actions: [
        { kind: 'all_in', sizing: null },
        { kind: 'limp', sizing: null },
      ],
      cellCount: 169,
    })
    .returning({ id: rangeChart.id });
  chartId = (row as { id: string }).id;

  const { CHART_HANDS } = await import('@gto/shared');
  await context.handle.db.insert(rangeChartCell).values(
    CHART_HANDS.flatMap((hand) => [
      { chartId, hand, actionKind: 'all_in', sizing: '', percent: 23.7 },
      { chartId, hand, actionKind: 'limp', sizing: '', percent: 61.5 },
      { chartId, hand, actionKind: 'fold', sizing: '', percent: 14.8 },
    ]),
  );
  await validateAndStore(context.handle.db, chartId);
});

/** Ein GET mit Session. */
async function get(
  path: string,
): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
  const response = await context.app.inject({
    method: 'GET',
    url: path,
    headers: { cookie: cookieHeader },
  });
  return {
    statusCode: response.statusCode,
    body: response.body,
    headers: response.headers as Record<string, unknown>,
  };
}

/** Ein schreibender Aufruf mit Session und CSRF-Token. */
async function send(
  method: 'POST' | 'PATCH',
  path: string,
  payload?: unknown,
): Promise<{ statusCode: number; json: () => unknown }> {
  const response = await context.app.inject({
    method,
    url: path,
    headers: { cookie: cookieHeader, [CSRF_HEADER_NAME]: csrfToken },
    ...(payload === undefined ? {} : { payload }),
  });
  return { statusCode: response.statusCode, json: () => response.json() };
}

describe('Auth-Schutz', () => {
  it('gibt ohne Session weder Liste noch Bild heraus', async () => {
    for (const path of ['/api/charts', `/api/charts/${chartId}`, `/api/charts/${chartId}/image`]) {
      const response = await context.app.inject({ method: 'GET', url: path });
      expect(response.statusCode, path).toBe(401);
    }
  });

  it('liefert das Bild nur an den angemeldeten Pruefer und ohne Zwischenspeicher', async () => {
    const response = await get(`/api/charts/${chartId}/image`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('Lesepfad', () => {
  it('liefert Liste samt Zaehlstaenden', async () => {
    const response = await get('/api/charts');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as ReviewListResponse;
    expect(body.charts).toHaveLength(1);
    expect(body.totals.digitized).toBe(1);
    expect(body.totals.handRangeAssets).toBe(1);
  });

  it('liefert im Detail Matrix, Befunde und beide Gesamtfrequenzen', async () => {
    const response = await get(`/api/charts/${chartId}`);
    const detail = JSON.parse(response.body) as ReviewChartDetail;
    expect(detail.cells).toHaveLength(169);
    expect(detail.imageUrl).toBe(`/api/charts/${chartId}/image`);
    // Die Gegenprobe aus T3.1 steht neben der Rechnung aus der Matrix.
    expect(detail.captionTotals['all_in']).toBeCloseTo(23.7, 5);
    expect(detail.weightedTotals['all_in']).toBeCloseTo(23.7, 1);
    expect(detail.state).toBe('validated');
  });
});

describe('Schreibpfad', () => {
  it('weist eine Aktionsart zurueck, die es nicht gibt', async () => {
    const response = await send('PATCH', `/api/charts/${chartId}/cells`, {
      cells: [{ hand: 'AA', actions: [{ kind: 'kaffeepause', percent: 100 }] }],
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('unbekannte Aktionsart');
  });

  it('weist eine Frequenz ausserhalb 0-100 zurueck', async () => {
    const response = await send('PATCH', `/api/charts/${chartId}/cells`, {
      cells: [{ hand: 'AA', actions: [{ kind: 'fold', percent: 140 }] }],
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('außerhalb 0-100');
  });

  it('nimmt eine Korrektur an und kennzeichnet sie als manuell', async () => {
    const response = await send('PATCH', `/api/charts/${chartId}/cells`, {
      cells: [{ hand: 'AA', actions: [{ kind: 'all_in', percent: 100 }] }],
    });
    expect(response.statusCode).toBe(200);
    const detail = response.json() as ReviewChartDetail;
    const cell = detail.cells.find((entry) => entry.hand === 'AA');
    expect(cell?.source).toBe('manual');
    expect(cell?.correctedAt).not.toBeNull();
    expect(detail.manualCells).toBe(1);
  });

  it('gibt ein geprueftes Chart frei und verwirft es mit Begruendung', async () => {
    const approve = await send('POST', `/api/charts/${chartId}/approve`);
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toEqual({ approved: 1 });

    const [after] = await context.handle.db.select().from(rangeChart);
    expect(after?.state).toBe('approved');

    const unusable = await send('POST', `/api/charts/${chartId}/unusable`, {
      reason: 'Bild unscharf, Farben nicht unterscheidbar.',
    });
    expect(unusable.statusCode).toBe(200);
    expect((unusable.json() as ReviewChartDetail).state).toBe('unusable');
  });

  it('verlangt fuer "unbrauchbar" eine Begruendung', async () => {
    const response = await send('POST', `/api/charts/${chartId}/unusable`, { reason: '   ' });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('Begründung fehlt');
  });

  it('gibt alle geprueften Charts als Sammelaktion frei', async () => {
    const response = await send('POST', '/api/charts/approve-validated');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ approved: 1 });
  });
});
