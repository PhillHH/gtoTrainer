import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewChartDetail, ReviewListResponse } from '@gto/shared';
import { AUTHENTICATED_ME, jsonResponse, mockFetch, renderApp } from './helpers.js';

/**
 * Review-Ansicht der Chart-Validierung (AP3.T3.4). Das Netzwerk ist gemockt -
 * geprueft wird die Oberflaeche, nicht das Backend.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Ein Chart mit einem beanstandeten Blatt (AA) und einem sauberen (KK). */
const DETAIL: ReviewChartDetail = {
  id: 'chart-1',
  captionNumber: 7,
  captionRaw: 'Hand Range 7: SB vs BB (15bb)',
  state: 'raw',
  model: 'claude-sonnet-5',
  cellCount: 169,
  errorCount: 1,
  warningCount: 0,
  manualCells: 0,
  recheckCount: 0,
  unusableReason: null,
  spot: { hero: 'SB', villain: 'BB' },
  actions: [
    { kind: 'all_in', sizing: null },
    { kind: 'fold', sizing: null },
  ],
  cells: [
    {
      hand: 'AA',
      actions: [{ kind: 'all_in', sizing: null, percent: 60 }],
      source: 'model',
      correctedAt: null,
      flagged: true,
    },
    {
      hand: 'KK',
      actions: [{ kind: 'all_in', sizing: null, percent: 100 }],
      source: 'model',
      correctedAt: null,
      flagged: false,
    },
  ],
  findings: [
    {
      check: 'frequency-sum',
      kind: 'frequency-sum-off',
      severity: 'error',
      hand: 'AA',
      actionKind: null,
      measured: 60,
      expected: 100,
      detail: 'Zelle AA: Frequenzen ergeben 60.0 % statt 100 % (Toleranz ±2 pp).',
    },
  ],
  weightedTotals: { all_in: 23.1, fold: 76.9 },
  captionTotals: { all_in: 23.7, fold: 76.3 },
  imageUrl: '/api/charts/chart-1/image',
};

function listResponse(overrides: Partial<ReviewListResponse['totals']> = {}): ReviewListResponse {
  return {
    charts: [
      {
        id: DETAIL.id,
        captionNumber: DETAIL.captionNumber,
        captionRaw: DETAIL.captionRaw,
        state: DETAIL.state,
        model: DETAIL.model,
        cellCount: DETAIL.cellCount,
        errorCount: DETAIL.errorCount,
        warningCount: DETAIL.warningCount,
        manualCells: DETAIL.manualCells,
        recheckCount: DETAIL.recheckCount,
        unusableReason: null,
      },
    ],
    totals: {
      handRangeAssets: 2,
      digitized: 1,
      raw: 1,
      validated: 0,
      approved: 0,
      failed: 0,
      unusable: 0,
      approvedShare: 0,
      ...overrides,
    },
    findingsByCheck: { 'frequency-sum': 1 },
  };
}

interface ChartMock {
  readonly calls: { url: string; method: string; body: string | undefined }[];
}

/** Erweitert den Standard-Mock um die Chart-Endpunkte. */
function mockCharts(options: { approveStatus?: number; approveBody?: unknown } = {}): ChartMock {
  const calls: ChartMock['calls'] = [];
  let list = listResponse();
  let detail = DETAIL;

  mockFetch({ me: AUTHENTICATED_ME });
  const base = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const original = base.getMockImplementation() as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;

  base.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!url.includes('/api/charts')) return original(input, init);

    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });

    if (url.endsWith('/cells') && method === 'PATCH') {
      // Das Backend liefert nach der Korrektur den neuen Stand.
      detail = {
        ...detail,
        manualCells: 1,
        errorCount: 0,
        findings: [],
        cells: [
          {
            hand: 'AA',
            actions: [{ kind: 'all_in', sizing: null, percent: 100 }],
            source: 'manual',
            correctedAt: '2026-08-24T12:00:00.000Z',
            flagged: false,
          },
          detail.cells[1] as ReviewChartDetail['cells'][number],
        ],
        state: 'validated',
      };
      list = listResponse({ raw: 0, validated: 1 });
      return jsonResponse(200, detail);
    }

    if (url.endsWith('/approve') && method === 'POST') {
      if (options.approveStatus !== undefined && options.approveStatus >= 400) {
        return jsonResponse(options.approveStatus, options.approveBody);
      }
      detail = { ...detail, state: 'approved' };
      list = listResponse({ raw: 0, validated: 0, approved: 1, approvedShare: 0.5 });
      return jsonResponse(200, { approved: 1 });
    }

    if (url.endsWith('/api/charts/chart-1')) return jsonResponse(200, detail);
    if (url.endsWith('/api/charts')) return jsonResponse(200, list);
    return jsonResponse(404, { error: 'invalid_request', message: 'Unbekannt.' });
  });

  return { calls };
}

/** Oeffnet die Seite und waehlt das erste Chart aus. */
async function openChart(): Promise<void> {
  renderApp('/charts');
  const entry = await screen.findByRole('button', { name: /Hand Range 7/ });
  await userEvent.click(entry);
  await screen.findByRole('heading', { name: /Hand Range 7/ });
}

describe('Review-Ansicht der Charts', () => {
  it('rendert Bild und 13x13-Raster nebeneinander', async () => {
    mockCharts();
    await openChart();

    // Links das Original-Bild ...
    const image = screen.getByRole('img', { name: /Original-Chart/ });
    expect(image).toHaveAttribute('src', '/api/charts/chart-1/image');

    // ... rechts das vollstaendige Raster mit 169 Zellen.
    const grid = screen.getByRole('table', { name: 'Gelesene Matrix' });
    expect(within(grid).getAllByRole('button')).toHaveLength(169);
    expect(within(grid).getByRole('button', { name: 'AA' })).toBeInTheDocument();
    expect(within(grid).getByRole('button', { name: '72o' })).toBeInTheDocument();
  });

  it('markiert beanstandete Zellen und zeigt den Befund im Klartext', async () => {
    mockCharts();
    await openChart();

    const grid = screen.getByRole('table', { name: 'Gelesene Matrix' });
    expect(within(grid).getByRole('button', { name: 'AA' }).className).toContain(
      'charts__cell--flagged',
    );
    // Die saubere Zelle traegt die Markierung nicht.
    expect(within(grid).getByRole('button', { name: 'KK' }).className).not.toContain(
      'charts__cell--flagged',
    );

    const findings = screen.getByRole('region', { name: 'Befunde' });
    expect(within(findings).getByText(/Frequenzsumme/)).toBeInTheDocument();
    expect(
      within(findings).getByText(/Zelle AA: Frequenzen ergeben 60\.0 % statt 100 %/),
    ).toBeInTheDocument();

    // Und die Gegenprobe aus der Bildunterschrift steht daneben.
    const totals = screen.getByRole('table', { name: 'Gesamtfrequenzen' });
    expect(within(totals).getByText('23.1 %')).toBeInTheDocument();
    expect(within(totals).getByText('23.7 %')).toBeInTheDocument();
  });

  it('sendet bei einer Korrektur Blatt und Aktionen an das Backend', async () => {
    const mock = mockCharts();
    await openChart();

    const grid = screen.getByRole('table', { name: 'Gelesene Matrix' });
    await userEvent.click(within(grid).getByRole('button', { name: 'AA' }));

    const field = await screen.findByRole('textbox', { name: /Aktionen/ });
    await userEvent.clear(field);
    await userEvent.type(field, 'all_in 100');
    await userEvent.click(screen.getByRole('button', { name: 'Korrektur speichern' }));

    await waitFor(() => {
      expect(mock.calls.some((call) => call.method === 'PATCH')).toBe(true);
    });
    const patch = mock.calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toContain('/api/charts/chart-1/cells');
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({
      cells: [{ hand: 'AA', actions: [{ kind: 'all_in', percent: 100 }] }],
    });

    // Die korrigierte Zelle ist danach als manuell erkennbar.
    await waitFor(() => {
      expect(
        screen
          .getByRole('table', { name: 'Gelesene Matrix' })
          .querySelector('.charts__cell--manual'),
      ).not.toBeNull();
    });
  });

  it('aendert mit der Freigabe den Zustand des Charts', async () => {
    const mock = mockCharts();
    await openChart();

    expect(screen.getAllByText('ungeprüft').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Freigeben' }));

    await waitFor(() => {
      expect(screen.getAllByText('freigegeben').length).toBeGreaterThan(0);
    });
    expect(
      mock.calls.some((call) => call.method === 'POST' && call.url.endsWith('/chart-1/approve')),
    ).toBe(true);
    expect(await screen.findByRole('status')).toHaveTextContent('Chart freigegeben.');
  });

  it('meldet eine abgelehnte Freigabe im Klartext, statt sie zu verschlucken', async () => {
    // Genau die Antwort, die `POST /api/charts/:id/approve` bei einem Chart mit
    // offenem Befund liefert.
    mockCharts({
      approveStatus: 400,
      approveBody: {
        error: 'invalid_chart',
        message: 'Die Freigabe wurde abgelehnt.',
        fields: [
          {
            field: 'state',
            message:
              'Chart im Zustand "raw" kann nicht freigegeben werden: 1 offene Fehlerbefunde.',
          },
        ],
      },
    });
    await openChart();
    await userEvent.click(screen.getByRole('button', { name: 'Freigeben' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Chart im Zustand "raw" kann nicht freigegeben werden',
    );
    // Der Zustand bleibt, was er war.
    expect(screen.getAllByText('ungeprüft').length).toBeGreaterThan(0);
  });

  it('verlangt fuer "unbrauchbar" eine Begruendung', async () => {
    mockCharts();
    await openChart();

    const button = screen.getByRole('button', { name: 'Als unbrauchbar markieren' });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByRole('textbox', { name: /Begründung/ }), 'Bild unscharf.');
    expect(button).toBeEnabled();
  });
});
