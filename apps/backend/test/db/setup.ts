import pg from 'pg';
import { loadTestDatabaseUrl } from '../../src/config/env.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Vorbereitung der Integrationstests.
 *
 * Die Tests laufen gegen eine echte Postgres-Instanz - nichts ist gemockt.
 * Damit sie ohne manuelle Vorbereitung starten, wird die Testdatenbank hier
 * bei Bedarf angelegt, geleert und migriert. Voraussetzung ist allein ein
 * laufender Postgres-Container (`pnpm db:up`).
 */

/** Verbindungs-URL der Testdatenbank. */
export const TEST_DATABASE_URL = loadTestDatabaseUrl();

/** Name der Testdatenbank, aus der URL abgeleitet. */
function testDatabaseName(url: string): string {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name) throw new Error('TEST_DATABASE_URL enthaelt keinen Datenbanknamen.');
  return name;
}

/** URL derselben Instanz, aber auf die Wartungsdatenbank `postgres` zeigend. */
function maintenanceUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

/**
 * Legt die Testdatenbank an, falls sie fehlt. `CREATE DATABASE` laesst sich
 * nicht in eine Transaktion packen, deshalb eine eigene, kurzlebige Verbindung.
 */
async function ensureTestDatabaseExists(): Promise<void> {
  const dbName = testDatabaseName(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: maintenanceUrl(TEST_DATABASE_URL) });

  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Postgres ist nicht erreichbar. Laeuft der Container? Start mit "pnpm db:up". ` +
        `Ursprungsfehler: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const existing = await client.query('select 1 from pg_database where datname = $1', [dbName]);
    if (existing.rowCount === 0) {
      // Identifier lassen sich nicht parametrisieren; dbName stammt aus der
      // eigenen Konfiguration und wird zusaetzlich validiert.
      if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
        throw new Error(`Unzulaessiger Testdatenbankname: "${dbName}".`);
      }
      await client.query(`create database "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

/** Verwirft das Schema der Testdatenbank, damit jeder Lauf leer startet. */
async function dropTestSchema(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('drop schema if exists public cascade');
    await client.query('drop schema if exists drizzle cascade');
    await client.query('create schema public');
  } finally {
    await client.end();
  }
}

/**
 * Bringt die Testdatenbank auf einen definierten Ausgangszustand:
 * vorhanden, leer, migriert. Wird von den Testdateien in `beforeAll` genutzt.
 */
export async function prepareTestDatabase(): Promise<void> {
  await ensureTestDatabaseExists();
  await dropTestSchema();
  await runMigrations(TEST_DATABASE_URL);
}
