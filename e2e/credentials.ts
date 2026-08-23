/**
 * Zugangsdaten fuer den E2E-Lauf.
 *
 * Sie kommen ausschliesslich aus Umgebungsvariablen - es stehen KEINE
 * Zugangsdaten im Test oder sonst im Repository. Die Defaults sind reine
 * Testwerte fuer die Wegwerf-Datenbank eines CI-Laufs und taugen fuer nichts
 * anderes.
 */
export const E2E_USERNAME = process.env['E2E_USERNAME'] ?? 'e2e-smoke-user';
export const E2E_PASSWORD = process.env['E2E_PASSWORD'] ?? '';

/** Prueft, dass ein Passwort gesetzt ist, bevor irgendetwas laeuft. */
export function requirePassword(): string {
  if (!E2E_PASSWORD) {
    throw new Error(
      'E2E_PASSWORD ist nicht gesetzt. Beispiel:\n' +
        "  E2E_PASSWORD='ein-langes-testpasswort' pnpm test:e2e",
    );
  }
  return E2E_PASSWORD;
}
