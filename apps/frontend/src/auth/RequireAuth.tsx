import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext.js';
import { FullScreenLoader } from '../components/FullScreenLoader.js';

/**
 * DIE eine Stelle, die ueber Zugriff auf geschuetzte Routen entscheidet.
 *
 * Neue geschuetzte Seiten werden als Kind-Route unterhalb dieses Elements
 * eingehaengt und brauchen selbst keine Pruefung.
 *
 * Solange der Status `checking` ist, wird ein Ladezustand gezeigt - niemals
 * schon nach /login umgeleitet. Sonst saehen angemeldete Nutzer beim
 * Neuladen kurz den Login-Screen.
 */
export function RequireAuth(): JSX.Element {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'checking') {
    return <FullScreenLoader label="Sitzung wird geprueft …" />;
  }

  if (status === 'anonymous') {
    // Ziel merken, damit nach dem Login dorthin zurueckgesprungen wird.
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
