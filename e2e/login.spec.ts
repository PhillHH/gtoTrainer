import { expect, test } from '@playwright/test';
import { E2E_USERNAME, requirePassword } from './credentials.js';

/**
 * Smoke-E2E aus AP1.T1.6: Login -> Dashboard erreichbar.
 *
 * Bewusst genau EIN Test. Breite E2E-Abdeckung ist AP10/T10.2 und gehoert
 * ausdruecklich nicht hierher.
 */
test('Login fuehrt zum Dashboard', async ({ page }) => {
  // Zugangsdaten kommen aus der Umgebung, nicht aus dem Code.
  const password = requirePassword();

  await page.goto('/login');

  // Ausgangslage: der Login-Screen ist da, das Dashboard nicht.
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();

  await page.getByLabel('Benutzername').fill(E2E_USERNAME);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();

  // --- Nachweis, dass das Dashboard wirklich gerendert ist -----------------
  // Geprueft werden Merkmale, die es NUR im angemeldeten Zustand gibt - die
  // URL allein waere kein Beleg.
  await expect(
    page.getByRole('heading', { name: `Willkommen zurück, ${E2E_USERNAME}` }),
  ).toBeVisible();

  // Die Kopfzeile nennt den angemeldeten Benutzer ...
  await expect(page.getByText('Angemeldet als')).toContainText(E2E_USERNAME);
  // ... es gibt einen Abmelden-Knopf ...
  await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();
  // ... und die Seitenleiste mit allen fuenf Bereichen.
  for (const bereich of ['Lernen', 'Drills', 'Turniere', 'Material', 'Einstellungen']) {
    await expect(page.getByRole('link', { name: bereich })).toBeVisible();
  }

  // Der Login-Screen ist verschwunden.
  await expect(page.getByRole('button', { name: 'Anmelden' })).toHaveCount(0);
});
