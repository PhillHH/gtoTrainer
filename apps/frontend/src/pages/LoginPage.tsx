import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { ThemeToggle } from '../components/ThemeToggle.js';
import './LoginPage.css';

interface LocationState {
  from?: { pathname?: string };
}

/**
 * Uebersetzt einen API-Fehler in eine anzeigbare Meldung.
 *
 * Wichtig: Bei `invalid_credentials` wird bewusst NICHT unterschieden, ob der
 * Benutzer unbekannt oder das Passwort falsch war - das Backend liefert diese
 * Information absichtlich nicht, und die Oberflaeche darf sie nicht erfinden.
 */
function messageForError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Unerwarteter Fehler bei der Anmeldung.';
  }

  switch (error.kind) {
    case 'rate_limited':
      return 'Zu viele Fehlversuche. Bitte einige Minuten warten und es dann erneut versuchen.';
    case 'unauthenticated':
      return 'Benutzername oder Passwort ist falsch.';
    case 'csrf_failed':
      return 'Die Sicherheitspruefung ist fehlgeschlagen. Bitte die Seite neu laden.';
    case 'network':
      return 'Das Backend ist nicht erreichbar. Laeuft der Server?';
    default:
      return error.message;
  }
}

export function LoginPage(): JSX.Element {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const target = (location.state as LocationState | null)?.from?.pathname ?? '/';

  // Wer bereits angemeldet ist, hat auf dem Login-Screen nichts zu suchen.
  useEffect(() => {
    if (status === 'authenticated') {
      navigate(target, { replace: true });
    }
  }, [status, navigate, target]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      await login({ username, password });
      navigate(target, { replace: true });
    } catch (caught) {
      setError(messageForError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="center-screen">
      <div className="login">
        <div className="login__topbar">
          <ThemeToggle />
        </div>

        <h1 className="login__title">GTO Trainer</h1>
        <p className="muted login__subtitle">Bitte anmelden, um fortzufahren.</p>

        {/* Enter im Feld loest submit aus - Standardverhalten eines <form>. */}
        <form onSubmit={(event) => void handleSubmit(event)} noValidate>
          {error !== undefined && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}

          <div className="field">
            <label className="field__label" htmlFor="username">
              Benutzername
            </label>
            <input
              id="username"
              className="field__input"
              name="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="password">
              Passwort
            </label>
            <input
              id="password"
              className="field__input"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
            />
          </div>

          <button className="button login__submit" type="submit" disabled={submitting}>
            {submitting ? 'Anmeldung laeuft …' : 'Anmelden'}
          </button>
        </form>
      </div>
    </div>
  );
}
