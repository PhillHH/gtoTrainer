import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AUTHENTICATED_ME, jsonResponse, mockFetch, renderApp } from './helpers.js';

describe('Login-Formular', () => {
  it('sendet die Eingaben an den erwarteten Endpunkt und zeigt bei Fehler die Meldung an', async () => {
    const fetchMock = mockFetch({
      login: () =>
        jsonResponse(401, {
          error: 'invalid_credentials',
          message: 'Benutzername oder Passwort ist falsch.',
        }),
    });
    const user = userEvent.setup();
    renderApp('/login');

    await user.type(await screen.findByLabelText('Benutzername'), 'testnutzer');
    await user.type(screen.getByLabelText('Passwort'), 'falsches-passwort');
    await user.click(screen.getByRole('button', { name: 'Anmelden' }));

    // Fehlermeldung erscheint ...
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Benutzername oder Passwort ist falsch.',
    );

    // ... und der Request ging an den richtigen Endpunkt mit den Eingaben.
    const call = fetchMock.lastCallTo('/api/auth/login');
    expect(call).toBeDefined();
    expect(call!.method).toBe('POST');
    expect(JSON.parse(call!.body!)).toEqual({
      username: 'testnutzer',
      password: 'falsches-passwort',
    });
  });

  it('zeigt bei 429 die spezifische Rate-Limit-Meldung', async () => {
    mockFetch({
      login: () =>
        jsonResponse(429, {
          error: 'rate_limited',
          message: 'Zu viele Fehlversuche. Bitte in 900 Sekunden erneut versuchen.',
        }),
    });
    const user = userEvent.setup();
    renderApp('/login');

    await user.type(await screen.findByLabelText('Benutzername'), 'testnutzer');
    await user.type(screen.getByLabelText('Passwort'), 'egal');
    await user.click(screen.getByRole('button', { name: 'Anmelden' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Zu viele Fehlversuche/);
    // Deutlich unterscheidbar von der Meldung bei falschen Zugangsdaten.
    expect(alert).not.toHaveTextContent(/Passwort ist falsch/);
  });

  it('sendet mit der Enter-Taste ab', async () => {
    const fetchMock = mockFetch({ login: AUTHENTICATED_ME });
    const user = userEvent.setup();
    renderApp('/login');

    await user.type(await screen.findByLabelText('Benutzername'), 'testnutzer');
    await user.type(screen.getByLabelText('Passwort'), 'passwort{Enter}');

    await waitFor(() => {
      expect(fetchMock.lastCallTo('/api/auth/login')).toBeDefined();
    });
  });

  it('fuehrt nach erfolgreichem Login auf das urspruenglich angefragte Ziel', async () => {
    // /material ist geschuetzt -> Umleitung auf /login, danach zurueck.
    mockFetch({ login: AUTHENTICATED_ME });
    const user = userEvent.setup();
    renderApp('/material');

    await user.type(await screen.findByLabelText('Benutzername'), 'testnutzer');
    await user.type(screen.getByLabelText('Passwort'), 'passwort');
    await user.click(screen.getByRole('button', { name: 'Anmelden' }));

    expect(await screen.findByRole('heading', { name: 'Material' })).toBeInTheDocument();
  });
});
