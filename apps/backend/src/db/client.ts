import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  /** Drizzle-Instanz fuer typisierte Queries. */
  readonly db: Database;
  /** Der darunterliegende Pool - fuer rohes SQL und Shutdown. */
  readonly pool: pg.Pool;
  /** Schliesst den Pool. Mehrfachaufruf ist unschaedlich. */
  close(): Promise<void>;
}

/**
 * Baut einen Connection-Pool samt Drizzle-Instanz auf.
 *
 * Es wird bewusst keine Singleton-Instanz auf Modulebene erzeugt: Tests,
 * Migrations- und Seed-Skripte brauchen jeweils einen eigenen, kontrolliert
 * schliessbaren Pool.
 */
export function createDb(databaseUrl: string, options: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    // Verbindungen nicht unbegrenzt offenhalten - der Host teilt sich Postgres
    // mit anderen Projekten.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // Ohne diesen Listener beendet ein Fehler auf einer idle-Verbindung den
  // gesamten Prozess (unhandled 'error'-Event).
  pool.on('error', (error) => {
    console.error('[db] Unerwarteter Fehler auf einer idle-Verbindung:', error.message);
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await pool.end();
  };

  return { db: drizzle(pool, { schema }), pool, close };
}

/**
 * Prueft, ob die Datenbank erreichbar ist.
 * Gibt niemals einen Fehler weiter - der Aufrufer bekommt ein Ergebnisobjekt.
 */
export async function checkDatabaseConnection(
  handle: DbHandle,
): Promise<{ reachable: true } | { reachable: false; error: string }> {
  try {
    await handle.db.execute(sql`select 1`);
    return { reachable: true };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Registriert sauberes Herunterfahren: Bei SIGTERM/SIGINT wird der Pool
 * geschlossen, bevor der Prozess endet. Gibt eine Abmelde-Funktion zurueck,
 * damit Tests die Listener wieder loesen koennen.
 */
export function registerShutdownHandlers(
  handle: DbHandle,
  onShutdown?: () => Promise<void>,
): () => void {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

  const handler = (signal: NodeJS.Signals): void => {
    void (async () => {
      console.error(`[db] ${signal} empfangen - fahre herunter.`);
      try {
        await onShutdown?.();
        await handle.close();
      } catch (error) {
        console.error('[db] Fehler beim Herunterfahren:', error);
        process.exitCode = 1;
      }
      process.exit(process.exitCode ?? 0);
    })();
  };

  for (const signal of signals) {
    process.on(signal, handler);
  }

  return () => {
    for (const signal of signals) {
      process.off(signal, handler);
    }
  };
}
