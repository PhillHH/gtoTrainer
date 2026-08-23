import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';
import { findRepoRoot, loadConfig } from '../config/env.js';

/** Verzeichnis der versionierten SQL-Migrationen (apps/backend/drizzle). */
export const MIGRATIONS_FOLDER = resolve(findRepoRoot(), 'apps/backend/drizzle');

/**
 * Spielt alle noch nicht angewandten Migrationen gegen die angegebene
 * Datenbank ein. Drizzle fuehrt dazu die Tabelle `drizzle.__drizzle_migrations`
 * und ueberspringt bereits eingespielte Dateien - der Aufruf ist idempotent.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}

/** CLI-Einstieg: `pnpm db:migrate`. */
export async function main(): Promise<void> {
  const { databaseUrl } = loadConfig();
  console.error(`[migrate] Migriere ${redact(databaseUrl)} ...`);
  await runMigrations(databaseUrl);
  console.error('[migrate] Fertig.');
}

/** Entfernt das Passwort aus einer Verbindungs-URL fuer die Log-Ausgabe. */
export function redact(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<ungueltige URL>';
  }
}
