import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmCallDetail, LlmCallSummary } from '@gto/shared';
import { AUTHENTICATED_ME, jsonResponse, mockFetch, renderApp } from './helpers.js';

/**
 * Ansicht "letzte KI-Aufrufe" unter Einstellungen (AP2.T2.5).
 *
 * Das Netzwerk ist gemockt - der Test prueft die Oberflaeche, nicht das
 * Backend.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const ERFOLG: LlmCallSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'cli',
  model: 'claude-haiku-4-5',
  status: 'success',
  durationMs: 2884,
  totalTokens: 321,
  createdAt: '2026-08-23T20:00:00.000Z',
  error: null,
};

const FEHLER: LlmCallSummary = {
  id: '22222222-2222-4222-8222-222222222222',
  provider: 'api',
  model: 'claude-sonnet-5',
  status: 'error',
  durationMs: 120,
  totalTokens: null,
  createdAt: '2026-08-23T20:05:00.000Z',
  error: 'rate_limit: Kontingent erschoepft',
};

const DETAIL: LlmCallDetail = {
  ...FEHLER,
  prompt: '[system]\nDu bist Lehrer …',
  response: null,
  promptTokens: null,
  completionTokens: null,
};

/** Ergaenzt den Standard-Mock um die Endpunkte des Aufruf-Protokolls. */
function mockCalls(options: { calls?: readonly LlmCallSummary[] } = {}): { urls: string[] } {
  const urls: string[] = [];
  const all = options.calls ?? [FEHLER, ERFOLG];

  mockFetch({ me: AUTHENTICATED_ME });
  const base = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

  const withLog = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);

    if (url.includes('/api/llm/calls/')) {
      return jsonResponse(200, { call: DETAIL });
    }
    if (url.includes('/api/llm/calls')) {
      const status = new URL(url, 'http://test').searchParams.get('status');
      const filtered = status === null ? all : all.filter((call) => call.status === status);
      return jsonResponse(200, { calls: filtered });
    }
    return base(input, init) as Promise<Response>;
  });

  vi.stubGlobal('fetch', withLog);
  return { urls };
}

describe('Einstellungen: letzte KI-Aufrufe', () => {
  it('rendert die Liste mit Provider, Modell, Dauer und Status', async () => {
    mockCalls();
    renderApp('/einstellungen');

    expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Letzte KI-Aufrufe' })).toBeInTheDocument();

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    // Kopfzeile plus zwei Eintraege.
    expect(rows).toHaveLength(3);

    expect(within(table).getByText('claude-haiku-4-5')).toBeInTheDocument();
    expect(within(table).getByText('2884 ms')).toBeInTheDocument();
    expect(within(table).getByText('Erfolg')).toBeInTheDocument();
    expect(within(table).getByText('Fehler')).toBeInTheDocument();
  });

  it('zeigt einen Hinweis, solange nichts protokolliert ist', async () => {
    mockCalls({ calls: [] });
    renderApp('/einstellungen');

    expect(await screen.findByText('Noch keine Aufrufe protokolliert.')).toBeInTheDocument();
  });

  it('filtert nach Status - der Filter erreicht auch das Backend', async () => {
    const { urls } = mockCalls();
    const user = userEvent.setup();
    renderApp('/einstellungen');

    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Fehler' }));

    // Die Anfrage traegt den Filter ...
    expect(urls.some((url) => url.includes('status=error'))).toBe(true);

    // ... und die Liste zeigt nur noch den Fehlschlag.
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).queryByText('claude-haiku-4-5')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fehler' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('oeffnet die Detailansicht mit Prompt und Antwort', async () => {
    mockCalls();
    const user = userEvent.setup();
    renderApp('/einstellungen');

    const table = await screen.findByRole('table');
    await user.click(within(table).getAllByRole('button', { name: 'Details' })[0] as HTMLElement);

    const detail = await screen.findByTestId('call-detail');
    expect(within(detail).getByText(/Du bist Lehrer/)).toBeInTheDocument();
    expect(within(detail).getByText('(noch keine Antwort)')).toBeInTheDocument();
    expect(within(detail).getByText(/rate_limit: Kontingent erschoepft/)).toBeInTheDocument();

    await user.click(within(detail).getByRole('button', { name: 'Schließen' }));
    expect(screen.queryByTestId('call-detail')).not.toBeInTheDocument();
  });

  it('meldet einen Serverfehler, statt eine leere Liste vorzutaeuschen', async () => {
    mockFetch({ me: AUTHENTICATED_ME });
    const base = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/llm/calls')) return jsonResponse(500, {});
        return base(input, init) as Promise<Response>;
      }),
    );

    renderApp('/einstellungen');
    expect(await screen.findByRole('alert')).toHaveTextContent(/Server/);
  });
});
