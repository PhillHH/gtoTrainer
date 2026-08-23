import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { LoginRequest, SessionUser } from '@gto/shared';
import { ApiError, apiClient } from '../api/client.js';

/**
 * Zentrale Verwaltung des Anmeldestatus.
 *
 * Einziger Ort, an dem der Benutzer gehalten wird - Komponenten lesen ihn ueber
 * `useAuth()` und halten keine eigene Kopie. Es wird bewusst **nichts** in
 * localStorage abgelegt: Die Session steckt ausschliesslich im
 * HttpOnly-Cookie, der Frontend-Zustand ist nur eine Spiegelung davon.
 */

/**
 * `checking` ist der Startzustand, solange `/api/auth/me` laeuft. Nur so
 * laesst sich verhindern, dass angemeldeten Nutzern kurz der Login-Screen
 * aufblitzt.
 */
export type AuthStatus = 'checking' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  readonly status: AuthStatus;
  readonly user: SessionUser | undefined;
  /** Meldet an; wirft `ApiError` weiter, damit das Formular sie anzeigen kann. */
  login(credentials: LoginRequest): Promise<void>;
  logout(): Promise<void>;
  /** Setzt den Zustand auf "abgemeldet", ohne das Backend zu rufen. */
  clearSession(): void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [user, setUser] = useState<SessionUser | undefined>(undefined);

  // Beim Start pruefen, ob bereits eine gueltige Session existiert.
  useEffect(() => {
    let aborted = false;

    void (async () => {
      try {
        const response = await apiClient.fetchMe();
        if (aborted) return;
        setUser(response.user);
        setStatus('authenticated');
      } catch (error) {
        if (aborted) return;
        // 401 ist hier der Normalfall "nicht angemeldet", kein Fehler.
        if (!(error instanceof ApiError) || error.kind !== 'unauthenticated') {
          console.error('[auth] Sessionpruefung fehlgeschlagen:', error);
        }
        setUser(undefined);
        setStatus('anonymous');
      }
    })();

    return () => {
      aborted = true;
    };
  }, []);

  const login = useCallback(async (credentials: LoginRequest): Promise<void> => {
    const response = await apiClient.login(credentials);
    setUser(response.user);
    setStatus('authenticated');
    // Nach dem Login setzt das Backend ein frisches CSRF-Cookie; der Client
    // liest es beim naechsten Request ohnehin neu aus document.cookie.
  }, []);

  const clearSession = useCallback((): void => {
    setUser(undefined);
    setStatus('anonymous');
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiClient.logout();
    } catch (error) {
      // Auch wenn der Aufruf scheitert, gilt lokal als abgemeldet - sonst
      // bliebe der Nutzer in einem Zustand haengen, aus dem er nicht herauskommt.
      console.error('[auth] Logout am Backend fehlgeschlagen:', error);
    } finally {
      setUser(undefined);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, logout, clearSession }),
    [status, user, login, logout, clearSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Zugriff auf den Auth-Zustand. Wirft ausserhalb des Providers. */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth muss innerhalb von <AuthProvider> verwendet werden.');
  }
  return context;
}
