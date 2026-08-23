import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright-Konfiguration fuer den Smoke-E2E-Test aus AP1.T1.6.
 *
 * Bewusst schlank: ein Browser (Chromium), ein Test (Login -> Dashboard).
 * Breite E2E-Abdeckung ist ausdruecklich NICHT Teil dieses Tasks.
 *
 * Backend und Frontend werden ueber `webServer` automatisch gestartet, damit
 * der Lauf ohne manuelle Vorbereitung funktioniert. Alle Ports sind
 * konfigurierbar - auf dem Zielhost sind 3000, 3001, 5173 und weitere durch
 * fremde Dienste belegt, und 3010/55434 gehoeren dem laufenden Deployment.
 */

const BACKEND_PORT = process.env['E2E_BACKEND_PORT'] ?? '3020';
const FRONTEND_PORT = process.env['E2E_FRONTEND_PORT'] ?? '5180';
const BASE_URL = `http://localhost:${FRONTEND_PORT}`;

/**
 * Datenbank fuer den E2E-Lauf. Faellt auf DATABASE_URL zurueck; in der CI ist
 * das ohnehin eine frische Service-Instanz.
 */
const DATABASE_URL = process.env['E2E_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';

export default defineConfig({
  testDir: './e2e',
  // Der Benutzer wird hier reproduzierbar angelegt (Passwort-CLI aus T1.3).
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'pnpm --filter @gto/backend dev',
      url: `http://127.0.0.1:${BACKEND_PORT}/healthz`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'development',
        PORT: BACKEND_PORT,
        HOST: '127.0.0.1',
        DATABASE_URL,
        // Ohne HTTPS wuerde der Browser ein Secure-Cookie verwerfen.
        COOKIE_SECURE: 'false',
        // Rate-Limit im Test nicht in die Quere kommen lassen.
        LOGIN_RATE_LIMIT_MAX_ATTEMPTS: '50',
      },
    },
    {
      command: 'pnpm --filter @gto/frontend dev',
      url: BASE_URL,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        FRONTEND_PORT,
        // Der Vite-Proxy reicht /api und /healthz an das Backend weiter.
        BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}`,
      },
    },
  ],
});
