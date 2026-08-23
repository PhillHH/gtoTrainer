import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AUTHENTICATED_ME, mockFetch, renderApp } from './helpers.js';

describe('Geschuetzte Routen', () => {
  it('leitet ohne Session auf /login um', async () => {
    mockFetch(); // /api/auth/me antwortet mit 401

    renderApp('/');

    expect(await screen.findByRole('button', { name: 'Anmelden' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Willkommen zurück/ })).not.toBeInTheDocument();
  });

  it('rendert mit gueltiger Session das Dashboard, ohne den Login-Screen zu zeigen', async () => {
    mockFetch({ me: AUTHENTICATED_ME });

    renderApp('/');

    // Waehrend der Pruefung laeuft, erscheint der Ladezustand ...
    expect(screen.getByRole('status')).toHaveTextContent('Sitzung wird geprueft');
    // ... aber niemals das Login-Formular.
    expect(screen.queryByRole('button', { name: 'Anmelden' })).not.toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: /Willkommen zurück/ })).toBeInTheDocument();
    // Der Benutzername steht in der Kopfzeile - genau einmal geprueft,
    // weil er auch in der Begruessung vorkommt.
    expect(screen.getByText('Angemeldet als', { exact: false })).toHaveTextContent('testnutzer');
    // Auch nach dem Rendern ist der Login-Screen nie aufgetaucht.
    expect(screen.queryByRole('button', { name: 'Anmelden' })).not.toBeInTheDocument();
  });

  it('macht alle fuenf Sidebar-Bereiche erreichbar', async () => {
    mockFetch({ me: AUTHENTICATED_ME });
    const user = userEvent.setup();
    renderApp('/');

    await screen.findByRole('heading', { name: /Willkommen zurück/ });

    for (const label of ['Lernen', 'Drills', 'Turniere', 'Material', 'Einstellungen']) {
      await user.click(screen.getByRole('link', { name: label }));
      expect(await screen.findByRole('heading', { name: label })).toBeInTheDocument();
    }
  });

  it('markiert den aktiven Sidebar-Eintrag', async () => {
    mockFetch({ me: AUTHENTICATED_ME });
    const user = userEvent.setup();
    renderApp('/');

    await screen.findByRole('heading', { name: /Willkommen zurück/ });
    await user.click(screen.getByRole('link', { name: 'Drills' }));

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Drills' })).toHaveClass('layout__link--active');
    });
    expect(screen.getByRole('link', { name: 'Lernen' })).not.toHaveClass('layout__link--active');
  });

  it('zeigt fuer unbekannte Pfade die 404-Seite', async () => {
    mockFetch({ me: AUTHENTICATED_ME });
    renderApp('/gibt-es-nicht');

    expect(
      await screen.findByRole('heading', { name: 'Seite nicht gefunden' }),
    ).toBeInTheDocument();
  });
});

describe('Logout', () => {
  it('raeumt den Zustand auf und leitet auf /login', async () => {
    const fetchMock = mockFetch({ me: AUTHENTICATED_ME });
    const user = userEvent.setup();
    renderApp('/');

    await screen.findByRole('heading', { name: /Willkommen zurück/ });
    await user.click(screen.getByRole('button', { name: 'Abmelden' }));

    // Login-Screen ist da, Dashboard weg.
    expect(await screen.findByRole('button', { name: 'Anmelden' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Willkommen zurück/ })).not.toBeInTheDocument();

    // Und der Backend-Endpunkt wurde tatsaechlich gerufen.
    expect(fetchMock.lastCallTo('/api/auth/logout')).toBeDefined();
  });
});
