import { defineConfig } from 'drizzle-kit';
import { loadConfig } from './src/config/env.js';

/**
 * Konfiguration fuer drizzle-kit (Migrations-Generierung).
 *
 * Migrationen werden zur ENTWICKLUNGSZEIT erzeugt (`pnpm db:generate`) und als
 * SQL-Dateien unter `apps/backend/drizzle/` versioniert. Zur Laufzeit wird
 * nichts generiert - `pnpm db:migrate` spielt nur vorhandene Dateien ein.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: loadConfig().databaseUrl,
  },
  strict: true,
  verbose: true,
});
