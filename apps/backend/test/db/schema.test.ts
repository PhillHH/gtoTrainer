import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, checkDatabaseConnection } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { BASE_TABLES, BOOK_TABLES, CONCEPT_TABLES } from '../../src/db/schema.js';
import { TEST_DATABASE_URL } from './setup.js';

/**
 * Integrationstests gegen eine echte Postgres-Instanz - nichts ist gemockt.
 * Die Datenbank wurde vom globalSetup leer angelegt und migriert.
 */
describe('Migration und Verbindung', () => {
  let handle: DbHandle;

  beforeAll(() => {
    handle = createDb(TEST_DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('erzeugt aus leerer Datenbank genau die erwarteten Tabellen', async () => {
    const result = await handle.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
          order by table_name`,
    );

    const tables = result.rows.map((row) => row.table_name);
    // Basisschema aus T1.2, Buch-Wissensbasis aus AP3.T3.1, Konzept-Graph aus
    // AP3.T3.2.
    const expected = [...BASE_TABLES, ...BOOK_TABLES, ...CONCEPT_TABLES];
    expect(tables).toEqual([...expected].sort());
    expect(tables).toHaveLength(expected.length);
  });

  it('legt die Zeitstempel durchgaengig als timestamptz an', async () => {
    const result = await handle.db.execute<{ table_name: string; column_name: string }>(
      sql`select table_name, column_name from information_schema.columns
          where table_schema = 'public'
            and (column_name like '%_at')
            and data_type <> 'timestamp with time zone'`,
    );

    expect(result.rows).toEqual([]);
  });

  it('meldet die Datenbank als erreichbar', async () => {
    const status = await checkDatabaseConnection(handle);
    expect(status).toEqual({ reachable: true });
  });

  it('meldet eine unerreichbare Datenbank als nicht erreichbar', async () => {
    // Port 1 ist garantiert kein Postgres.
    const broken = createDb('postgres://nobody:nobody@127.0.0.1:1/nichts', { max: 1 });
    try {
      const status = await checkDatabaseConnection(broken);
      expect(status.reachable).toBe(false);
    } finally {
      await broken.close();
    }
  });
});
