import { describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from '@gto/shared';
import { ApiError, apiClient } from '../src/api/client.js';
import { jsonResponse, mockFetch } from './helpers.js';

describe('API-Client', () => {
  it('haengt bei einem zustandsaendernden Request den CSRF-Wert an', async () => {
    const fetchMock = mockFetch({
      login: () => jsonResponse(200, { user: { id: 'user-1', username: 'testnutzer' } }),
      csrfToken: 'token-aus-dem-cookie',
    });

    await apiClient.login({ username: 'testnutzer', password: 'passwort' });

    // Ohne vorhandenes Cookie holt der Client den Token zuerst ab ...
    expect(fetchMock.lastCallTo('/api/auth/csrf')).toBeDefined();

    // ... und spiegelt ihn dann im Header, genau wie in INTERFACES.md gefordert.
    const loginCall = fetchMock.lastCallTo('/api/auth/login');
    expect(loginCall).toBeDefined();
    expect(loginCall!.headers[CSRF_HEADER_NAME]).toBe('token-aus-dem-cookie');
    expect(loginCall!.headers['content-type']).toBe('application/json');
  });

  it('sendet alle Requests mit credentials: include', async () => {
    const fetchMock = mockFetch({
      me: () => jsonResponse(200, { user: { id: 'user-1', username: 'testnutzer' } }),
    });

    await apiClient.fetchMe();

    expect(fetchMock.lastCallTo('/api/auth/me')!.credentials).toBe('include');
  });

  it('haengt bei lesenden Requests keinen CSRF-Header an', async () => {
    const fetchMock = mockFetch({
      me: () => jsonResponse(200, { user: { id: 'user-1', username: 'testnutzer' } }),
    });

    await apiClient.fetchMe();

    expect(fetchMock.lastCallTo('/api/auth/me')!.headers[CSRF_HEADER_NAME]).toBeUndefined();
  });

  it('uebersetzt 401 in einen ApiError mit kind "unauthenticated"', async () => {
    mockFetch();

    await expect(apiClient.fetchMe()).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'unauthenticated',
      status: 401,
      code: 'unauthenticated',
    });
  });

  it('uebersetzt 429 in einen ApiError mit kind "rate_limited"', async () => {
    mockFetch({
      login: () => jsonResponse(429, { error: 'rate_limited', message: 'Zu viele Versuche.' }),
    });

    await expect(apiClient.login({ username: 'a', password: 'b' })).rejects.toMatchObject({
      kind: 'rate_limited',
      status: 429,
    });
  });

  it('uebersetzt einen Netzwerkfehler in kind "network"', async () => {
    const { vi } = await import('vitest');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const error = await apiClient.fetchMe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('network');
  });

  it('uebersetzt 5xx in kind "server"', async () => {
    const { vi } = await import('vitest');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(503, { irgendwas: true }))),
    );

    await expect(apiClient.fetchMe()).rejects.toMatchObject({ kind: 'server', status: 503 });
  });
});
