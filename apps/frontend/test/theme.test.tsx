import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AUTHENTICATED_ME, mockFetch, renderApp } from './helpers.js';

describe('Dark-Mode', () => {
  it('setzt data-theme am Wurzelelement und schaltet in beide Richtungen um', async () => {
    mockFetch({ me: AUTHENTICATED_ME });
    const user = userEvent.setup();
    renderApp('/');

    await screen.findByRole('heading', { name: /Willkommen zurück/ });

    // Ohne gespeicherte Wahl und mit matchMedia=false gilt der helle Modus.
    expect(document.documentElement.dataset['theme']).toBe('light');

    const toggle = screen.getByRole('button', { name: /Dunkel/ });
    await user.click(toggle);
    expect(document.documentElement.dataset['theme']).toBe('dark');

    await user.click(screen.getByRole('button', { name: /Hell/ }));
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('merkt sich die manuelle Wahl in localStorage', async () => {
    mockFetch({ me: AUTHENTICATED_ME });
    const user = userEvent.setup();
    renderApp('/');

    await screen.findByRole('heading', { name: /Willkommen zurück/ });
    await user.click(screen.getByRole('button', { name: /Dunkel/ }));

    expect(window.localStorage.getItem('gto.theme')).toBe('dark');
  });
});
