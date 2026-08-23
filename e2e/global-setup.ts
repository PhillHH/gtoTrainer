import { execFileSync } from 'node:child_process';
import { E2E_USERNAME, requirePassword } from './credentials.js';

/**
 * Vorbereitung des E2E-Laufs.
 *
 * Legt den Testbenutzer reproduzierbar an - und zwar ueber genau die Werkzeuge
 * aus den Vorgaenger-Tasks: `db:migrate` aus AP1.T1.2 und das Passwort-CLI aus
 * AP1.T1.3. Damit wird kein zweiter, abweichender Weg gepflegt.
 *
 * Laeuft VOR den `webServer`-Prozessen, deshalb ist die Datenbank hier bereits
 * auf dem aktuellen Migrationsstand, wenn das Backend startet.
 */
export default function globalSetup(): void {
  const password = requirePassword();
  const databaseUrl = process.env['E2E_DATABASE_URL'] ?? process.env['DATABASE_URL'];

  if (!databaseUrl) {
    throw new Error(
      'Weder E2E_DATABASE_URL noch DATABASE_URL gesetzt - ohne Datenbank kein E2E-Lauf.',
    );
  }

  const env = { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'development' };
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}): void => {
    execFileSync('pnpm', args, { stdio: 'inherit', env: { ...env, ...extraEnv } });
  };

  console.info('[e2e] Migriere die Testdatenbank ...');
  run(['db:migrate']);

  console.info(`[e2e] Lege Testbenutzer "${E2E_USERNAME}" an bzw. setze sein Passwort ...`);
  // Das Passwort geht ueber die Umgebung, nie als Argument - es landete sonst
  // in der Prozessliste.
  run(['auth:set-password', E2E_USERNAME], { NEW_PASSWORD: password });
}
