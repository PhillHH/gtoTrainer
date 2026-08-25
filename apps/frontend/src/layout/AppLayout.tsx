import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.js';
import { ThemeToggle } from '../components/ThemeToggle.js';
import './AppLayout.css';

/** Die fuenf Bereiche der Seitenleiste - Reihenfolge laut Kanon. */
export const NAV_ITEMS: ReadonlyArray<{ to: string; label: string }> = [
  { to: '/lernen', label: 'Lernen' },
  { to: '/konzepte', label: 'Konzepte' },
  { to: '/charts', label: 'Charts' },
  { to: '/drills', label: 'Drills' },
  { to: '/turniere', label: 'Turniere' },
  { to: '/material', label: 'Material' },
  { to: '/einstellungen', label: 'Einstellungen' },
];

/** Rahmen des geschuetzten Bereichs: Seitenleiste, Kopfzeile, Inhalt. */
export function AppLayout(): JSX.Element {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout(): Promise<void> {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="layout">
      <aside className="layout__sidebar">
        <NavLink to="/" className="layout__brand">
          GTO Trainer
        </NavLink>

        <nav className="layout__nav" aria-label="Hauptnavigation">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                isActive ? 'layout__link layout__link--active' : 'layout__link'
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="layout__main">
        <header className="layout__header">
          <span className="muted layout__user">
            Angemeldet als <strong>{user?.username ?? '—'}</strong>
          </span>
          <div className="layout__actions">
            <ThemeToggle />
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void handleLogout()}
            >
              Abmelden
            </button>
          </div>
        </header>

        <main className="layout__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
