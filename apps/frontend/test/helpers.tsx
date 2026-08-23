import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AppRoutes } from '../src/App.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeProvider.js';

/** Antwortbaustein fuer den gemockten `fetch`. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly credentials: string | undefined;
}

export interface MockFetch {
  /** Alle beobachteten Aufrufe, in Reihenfolge. */
  readonly calls: FetchCall[];
  /** Letzter Aufruf auf einen Pfad. */
  lastCallTo(path: string): FetchCall | undefined;
}

export interface MockFetchOptions {
  /** Antwort auf `GET /api/auth/me`. */
  readonly me?: () => Response;
  /** Antwort auf `POST /api/auth/login`. */
  readonly login?: () => Response;
  /** Antwort auf `POST /api/auth/logout`. */
  readonly logout?: () => Response;
  /** Setzt beim CSRF-Aufruf ein Cookie, wie es das Backend tut. */
  readonly csrfToken?: string;
  /** Antwort auf `GET/PUT /api/llm/settings` und den Ping. */
  readonly llmSettings?: () => Response;
}

/** Antwort, die das Backend fuer nicht gesetzte Einstellungen liefert. */
export const DEFAULT_LLM_SETTINGS = {
  settings: {
    provider: 'cli',
    model: 'claude-sonnet-5',
    timeoutMs: 120000,
    maxConcurrency: 2,
    maxAttempts: 3,
  },
  origin: {
    provider: 'default',
    model: 'default',
    timeoutMs: 'default',
    maxConcurrency: 'default',
    maxAttempts: 'default',
  },
  modelChoices: [
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  ranges: {
    timeoutMs: { min: 5000, max: 600000 },
    maxConcurrency: { min: 1, max: 8 },
    maxAttempts: { min: 1, max: 10 },
  },
  apiKeyConfigured: false,
} as const;

/**
 * Ersetzt `globalThis.fetch` durch eine Attrappe, die das dokumentierte
 * Backend-Verhalten nachbildet (inklusive `gto_csrf`-Cookie).
 */
export function mockFetch(options: MockFetchOptions = {}): MockFetch {
  const calls: FetchCall[] = [];
  const csrfToken = options.csrfToken ?? 'test-csrf-token';

  const implementation = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    calls.push({
      url,
      method,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: typeof init?.body === 'string' ? init.body : undefined,
      credentials: init?.credentials,
    });

    if (url.endsWith('/api/auth/csrf')) {
      // Das echte Backend setzt hier das lesbare Cookie.
      document.cookie = `gto_csrf=${encodeURIComponent(csrfToken)}; path=/`;
      return jsonResponse(200, { csrfToken });
    }

    if (url.endsWith('/api/auth/me')) {
      return (
        options.me?.() ??
        jsonResponse(401, { error: 'unauthenticated', message: 'Keine gueltige Session.' })
      );
    }

    if (url.endsWith('/api/auth/login')) {
      return (
        options.login?.() ??
        jsonResponse(401, {
          error: 'invalid_credentials',
          message: 'Benutzername oder Passwort ist falsch.',
        })
      );
    }

    if (url.endsWith('/api/auth/logout')) {
      return options.logout?.() ?? jsonResponse(200, { loggedOut: true });
    }

    // Einstellungen des LLM-Gateways (AP2.T2.6). Die Seite laedt sie beim
    // Oeffnen; ohne Antwort wuerde jede Seitenpruefung eine Fehlermeldung sehen.
    if (url.includes('/api/llm/settings')) {
      return options.llmSettings?.() ?? jsonResponse(200, DEFAULT_LLM_SETTINGS);
    }

    return jsonResponse(404, { error: 'invalid_request', message: 'Unbekannt.' });
  };

  vi.stubGlobal('fetch', vi.fn(implementation));

  return {
    calls,
    lastCallTo: (path: string) => [...calls].reverse().find((call) => call.url.endsWith(path)),
  };
}

/** Antwort einer erfolgreichen Sessionpruefung. */
export const AUTHENTICATED_ME = (): Response =>
  jsonResponse(200, { user: { id: 'user-1', username: 'testnutzer' } });

/** Rendert die App mit Providern ab einer bestimmten Route. */
export function renderApp(initialPath = '/'): RenderResult {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}
