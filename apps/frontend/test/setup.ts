import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Gemeinsame Testvorbereitung.
 *
 * Das Netzwerk ist durchgehend gemockt - die Frontend-Tests brauchen kein
 * laufendes Backend.
 */

beforeEach(() => {
  // jsdom kennt matchMedia nicht; der ThemeProvider fragt es ab.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  window.localStorage.clear();
  // Cookies zwischen Tests zuruecksetzen.
  document.cookie.split(';').forEach((entry) => {
    const name = entry.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; path=/`;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
