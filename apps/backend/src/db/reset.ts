import { createDb } from './client.js';
import { loadConfig } from '../config/env.js';
import { runMigrations, redact } from './migrate.js';

/**
 * ENTWICKLUNGSWERKZEUG. Verwirft das komplette Schema und migriert neu.
 * Niemals gegen eine produktive Datenbank ausfuehren.
 */

/** Fehler, wenn eine Schutzbedingung den Reset verhindert. */
export class ResetBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetBlockedError';
  }
}

export interface ResetGuardInput {
  readonly nodeEnv: string | undefined;
  readonly confirm: string | undefined;
}

/**
 * Doppelter Schutz gegen versehentliche Ausfuehrung:
 *
 * 1. `NODE_ENV=production` blockiert immer. Auf dem Zielhost steht NODE_ENV
 *    laut AP1.T1.1-Statusbericht haeufig auf `production` - der Reset ist dort
 *    also von sich aus gesperrt.
 * 2. Zusaetzlich muss `DB_RESET_CONFIRM=yes` explizit gesetzt sein. Eine
 *    fehlende oder abweichende Bestaetigung blockiert ebenfalls.
 *
 * Wirft `ResetBlockedError` mit einer erklaerenden Meldung, statt still
 * weiterzulaufen.
 */
export function assertResetAllowed(input: ResetGuardInput): void {
  if (input.nodeEnv === 'production') {
    throw new ResetBlockedError(
      'db:reset ist blockiert: NODE_ENV=production. ' +
        'Dieses Skript ist ausschliesslich fuer die Entwicklung gedacht und ' +
        'loescht das komplette Schema. Zum Ausfuehren NODE_ENV auf development setzen.',
    );
  }

  if (input.confirm !== 'yes') {
    throw new ResetBlockedError(
      'db:reset ist blockiert: Bestaetigung fehlt. ' +
        'Setze DB_RESET_CONFIRM=yes, um das komplette Schema zu verwerfen und neu zu migrieren.',
    );
  }
}

/**
 * Verwirft `public` und das Drizzle-Migrations-Schema und legt `public` neu an.
 * Bewusst kein DROP DATABASE: Das wuerde eine Verbindung zu einer anderen
 * Datenbank erfordern und schlaegt fehl, solange noch Sitzungen offen sind.
 */
export async function dropSchema(databaseUrl: string): Promise<void> {
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    await handle.pool.query('drop schema if exists public cascade');
    await handle.pool.query('drop schema if exists drizzle cascade');
    await handle.pool.query('create schema public');
  } finally {
    await handle.close();
  }
}

/** CLI-Einstieg: `pnpm db:reset`. */
export async function main(): Promise<void> {
  assertResetAllowed({
    nodeEnv: process.env['NODE_ENV'],
    confirm: process.env['DB_RESET_CONFIRM'],
  });

  const { databaseUrl } = loadConfig();
  console.error(`[reset] Verwerfe Schema in ${redact(databaseUrl)} ...`);
  await dropSchema(databaseUrl);
  console.error('[reset] Schema verworfen. Migriere neu ...');
  await runMigrations(databaseUrl);
  console.error('[reset] Fertig. Datenbank steht auf dem aktuellen Migrationsstand.');
}
