import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTHENTICATED_ME,
  DEFAULT_LLM_SETTINGS,
  jsonResponse,
  mockFetch,
  renderApp,
} from './helpers.js';

/**
 * Provider- und Modellwahl samt Testaufruf (AP2.T2.6).
 *
 * Das Netzwerk ist gemockt - geprueft wird die Oberflaeche.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

interface MockOptions {
  /** Antwort auf `PUT /api/llm/settings`. */
  readonly put?: () => Response;
  /** Antwort auf den Ping. */
  readonly ping?: () => Response;
}

function mockSettings(options: MockOptions = {}): { requests: { url: string; body?: string }[] } {
  const requests: { url: string; body?: string }[] = [];

  mockFetch({ me: AUTHENTICATED_ME });
  const base = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      requests.push({
        url,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });

      if (url.includes('/api/llm/settings/ping')) {
        return (
          options.ping?.() ??
          jsonResponse(200, {
            ok: true,
            provider: 'cli',
            model: 'claude-haiku-4-5',
            durationMs: 2884,
            text: 'OK',
            callId: 'call-1',
          })
        );
      }
      if (url.includes('/api/llm/settings')) {
        if (method === 'PUT') return options.put?.() ?? jsonResponse(200, DEFAULT_LLM_SETTINGS);
        return jsonResponse(200, DEFAULT_LLM_SETTINGS);
      }
      if (url.includes('/api/llm/calls')) return jsonResponse(200, { calls: [] });
      return base(input, init) as Promise<Response>;
    }),
  );

  return { requests };
}

describe('Einstellungen: Provider und Modell', () => {
  it('laedt die aktuellen Werte in das Formular', async () => {
    mockSettings();
    renderApp('/einstellungen');

    expect(await screen.findByRole('heading', { name: 'Provider und Modell' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Provider')).toHaveValue('cli');
    expect(screen.getByLabelText('Modell')).toHaveValue('claude-sonnet-5');
    expect(screen.getByLabelText(/Timeout je Aufruf/)).toHaveValue(120000);
    expect(screen.getByLabelText(/Gleichzeitige Aufrufe/)).toHaveValue(2);
    expect(screen.getByLabelText(/Versuche je Aufruf/)).toHaveValue(3);
  });

  it('weist darauf hin, dass ein Testaufruf Kontingent verbraucht', async () => {
    mockSettings();
    renderApp('/einstellungen');

    // Auf den geladenen Zustand warten - die Ueberschrift steht auch waehrend
    // des Ladens schon da.
    await screen.findByLabelText('Provider');
    // Exakter Text, damit nur die Hervorhebung trifft und nicht auch der Absatz.
    expect(screen.getByText('Das verbraucht echtes Kontingent bzw. Guthaben.')).toBeInTheDocument();
  });

  it('sendet beim Speichern die geaenderten Werte an das Backend', async () => {
    const { requests } = mockSettings();
    const user = userEvent.setup();
    renderApp('/einstellungen');

    await screen.findByLabelText('Provider');
    await user.selectOptions(screen.getByLabelText('Provider'), 'api');
    await user.selectOptions(screen.getByLabelText('Modell'), 'claude-opus-5');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(await screen.findByText('Gespeichert.')).toBeInTheDocument();

    const put = requests.filter((entry) => entry.body !== undefined).pop();
    const sent = JSON.parse(put?.body ?? '{}') as Record<string, unknown>;
    expect(sent).toMatchObject({
      provider: 'api',
      model: 'claude-opus-5',
      timeoutMs: 120000,
      maxConcurrency: 2,
      maxAttempts: 3,
    });
  });

  it('zeigt einen serverseitigen Feldfehler am jeweiligen Feld an', async () => {
    mockSettings({
      put: () =>
        jsonResponse(400, {
          error: 'invalid_settings',
          message: 'Die Einstellungen wurden abgelehnt: timeoutMs.',
          fields: [
            {
              field: 'timeoutMs',
              message: 'Timeout je Aufruf muss zwischen 5000 und 600000 liegen, ist: 100.',
            },
          ],
        }),
    });
    const user = userEvent.setup();
    renderApp('/einstellungen');

    const timeout = await screen.findByLabelText(/Timeout je Aufruf/);
    await user.clear(timeout);
    await user.type(timeout, '100');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    // Die Meldung haengt am Feld, nicht nur pauschal an der Seite.
    expect(await screen.findByText(/zwischen 5000 und 600000 liegen/)).toBeInTheDocument();
    expect(timeout).toHaveAttribute('aria-invalid', 'true');
    expect(timeout).toHaveAttribute('aria-describedby', 'llm-timeout-error');
    expect(screen.getByText('Bitte die markierten Felder korrigieren.')).toBeInTheDocument();
  });

  it('meldet einen erfolgreichen Testaufruf mit Provider, Modell und Dauer', async () => {
    mockSettings();
    const user = userEvent.setup();
    renderApp('/einstellungen');

    await screen.findByRole('button', { name: 'Testaufruf ausführen' });
    await user.click(screen.getByRole('button', { name: 'Testaufruf ausführen' }));

    const result = await screen.findByTestId('ping-result');
    expect(within(result).getByText(/Erfolgreich/)).toBeInTheDocument();
    expect(within(result).getByText(/cli · claude-haiku-4-5 · 2884 ms/)).toBeInTheDocument();
    expect(within(result).getByText('OK')).toBeInTheDocument();
  });

  it('stellt einen fehlgeschlagenen Testaufruf mit Kategorie und Hinweis dar', async () => {
    mockSettings({
      ping: () =>
        jsonResponse(200, {
          ok: false,
          provider: 'api',
          kind: 'auth',
          message: 'ANTHROPIC_API_KEY fehlt oder ist leer.',
          hint: 'Es ist kein gueltiger ANTHROPIC_API_KEY hinterlegt. Siehe RUNBOOK 9.5.',
          durationMs: 3,
        }),
    });
    const user = userEvent.setup();
    renderApp('/einstellungen');

    await screen.findByRole('button', { name: 'Testaufruf ausführen' });
    await user.click(screen.getByRole('button', { name: 'Testaufruf ausführen' }));

    const result = await screen.findByTestId('ping-result');
    expect(within(result).getByText(/Fehlgeschlagen \(auth\)/)).toBeInTheDocument();
    expect(within(result).getByText(/ANTHROPIC_API_KEY fehlt/)).toBeInTheDocument();
    expect(within(result).getByText(/RUNBOOK 9\.5/)).toBeInTheDocument();
  });

  it('loest den Testaufruf nicht von selbst aus', async () => {
    const { requests } = mockSettings();
    renderApp('/einstellungen');

    await screen.findByRole('button', { name: 'Testaufruf ausführen' });
    expect(requests.some((entry) => entry.url.includes('/ping'))).toBe(false);
  });

  it('zeigt an, ob ein API-Schluessel hinterlegt ist - ohne ihn preiszugeben', async () => {
    mockSettings();
    renderApp('/einstellungen');

    expect(
      await screen.findByText(/Es ist kein Anthropic-API-Schlüssel hinterlegt/),
    ).toBeInTheDocument();
  });
});
