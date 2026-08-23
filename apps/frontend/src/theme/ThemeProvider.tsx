import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Hell-/Dunkel-Umschaltung.
 *
 * Der gewaehlte Modus landet als `data-theme` am <html>-Element; die Tokens in
 * styles/tokens.css haengen daran. Der Startwert folgt der Systemeinstellung
 * (`prefers-color-scheme`), eine manuelle Wahl wird in localStorage gemerkt.
 *
 * Das ist die einzige erlaubte localStorage-Nutzung: eine reine
 * UI-Praeferenz, kein Anwendungszustand und schon gar keine Auth-Daten.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'gto.theme';

export interface ThemeContextValue {
  readonly theme: Theme;
  toggleTheme(): void;
  setTheme(theme: Theme): void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** Liest eine zuvor getroffene manuelle Wahl. */
function readStoredTheme(): Theme | undefined {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : undefined;
  } catch {
    // localStorage kann blockiert sein - dann gilt einfach die Systemwahl.
    return undefined;
  }
}

/** Systemeinstellung des Betriebssystems bzw. Browsers. */
function readSystemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme() ?? readSystemTheme());

  // Attribut am Wurzelelement setzen - daran haengen alle Token-Sets.
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  const setTheme = useCallback((next: Theme): void => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Nicht kritisch: Die Wahl gilt dann nur fuer diese Sitzung.
    }
  }, []);

  const toggleTheme = useCallback((): void => {
    setThemeState((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* siehe oben */
      }
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, toggleTheme, setTheme }),
    [theme, toggleTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme muss innerhalb von <ThemeProvider> verwendet werden.');
  }
  return context;
}
