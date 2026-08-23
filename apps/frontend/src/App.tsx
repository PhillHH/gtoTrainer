import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.js';
import { RequireAuth } from './auth/RequireAuth.js';
import { ThemeProvider } from './theme/ThemeProvider.js';
import { AppLayout } from './layout/AppLayout.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { PlaceholderPage } from './pages/PlaceholderPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

/**
 * Routenbaum.
 *
 * Alles unterhalb von <RequireAuth> ist geschuetzt. Eine neue geschuetzte
 * Seite wird dort als weitere <Route> ergaenzt und braucht selbst keine
 * Zugriffspruefung.
 */
export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      {/* Oeffentlich */}
      <Route path="/login" element={<LoginPage />} />

      {/* Geschuetzt - genau ein Guard fuer alle Kind-Routen */}
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route index element={<DashboardPage />} />
          <Route
            path="/lernen"
            element={
              <PlaceholderPage
                title="Lernen"
                plannedIn="AP5"
                description="Geführte Lerneinheiten auf Basis der Buchinhalte aus AP3."
              />
            }
          />
          <Route
            path="/drills"
            element={
              <PlaceholderPage
                title="Drills"
                plannedIn="AP6"
                description="Wiederholtes Üben einzelner Spots inklusive Auswertung."
              />
            }
          />
          <Route
            path="/turniere"
            element={
              <PlaceholderPage
                title="Turniere"
                plannedIn="AP7"
                description="Turnierspezifische Themen wie ICM und Stack-Tiefen."
              />
            }
          />
          <Route
            path="/material"
            element={
              <PlaceholderPage
                title="Material"
                plannedIn="AP8"
                description="Nachschlagewerk mit Charts und Textstellen aus der Buchquelle."
              />
            }
          />
          {/* Seit AP2.T2.5 echte Inhalte: die Ansicht "letzte KI-Aufrufe". */}
          <Route path="/einstellungen" element={<SettingsPage />} />
        </Route>
      </Route>

      {/* Bequemlichkeit: /dashboard zeigt auf die Startseite */}
      <Route path="/dashboard" element={<Navigate to="/" replace />} />

      {/* Unbekannte Pfade */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

/** Wurzelkomponente: Provider plus Routen. */
export function App(): JSX.Element {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeProvider>
  );
}
