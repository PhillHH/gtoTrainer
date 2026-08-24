import { BOOK_ASSET_CONFIDENCES, BOOK_ASSET_TYPES } from '@gto/shared';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BOOK_ASSET_CONFIDENCES as SCHEMA_CONFIDENCES,
  BOOK_ASSET_TYPES as SCHEMA_TYPES,
  BOOK_TABLES,
} from '../../src/db/schema.js';
import { createDb } from '../../src/db/client.js';
import { TEST_DATABASE_URL } from '../db/setup.js';

const handle = createDb(TEST_DATABASE_URL, { max: 1 });

afterAll(async () => {
  await handle.close();
});

describe('Schema der Buch-Wissensbasis', () => {
  it('haelt die Werteliste deckungsgleich mit dem Vertrag in packages/shared', () => {
    // Die Liste steht in schema.ts dupliziert, weil drizzle-kit das
    // Workspace-Paket beim Buendeln nicht aufloest. Dieser Test verhindert,
    // dass die beiden Stellen auseinanderlaufen.
    expect([...SCHEMA_TYPES]).toEqual([...BOOK_ASSET_TYPES]);
    expect([...SCHEMA_CONFIDENCES]).toEqual([...BOOK_ASSET_CONFIDENCES]);
  });

  it('legt die drei Tabellen an', async () => {
    const result = await handle.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = result.rows.map((row) => (row as { table_name: string }).table_name);
    for (const table of BOOK_TABLES) expect(names).toContain(table);
  });

  it('weist unbekannte Assettypen ab', async () => {
    const error = await failingQuery(sql`
      insert into book_asset
        (relative_path, file_name, asset_type, classification_confidence,
         classification_rule, ordinal, content_hash)
      values ('x/ungueltig.jpeg', 'ungueltig.jpeg', 'kein_typ', 'certain', 'test', 0, 'h')
    `);
    expect(error).toContain('book_asset_type_check');
  });

  it('erzwingt eindeutige fachliche Schluessel', async () => {
    await handle.db.execute(sql`
      insert into book_chapter
        (part_number, part_title, chapter_number, title, ordinal, content_hash)
      values (1, 'T', 99, 'Eindeutigkeitstest', 0, 'h')
    `);
    const error = await failingQuery(sql`
      insert into book_chapter
        (part_number, part_title, chapter_number, title, ordinal, content_hash)
      values (1, 'T', 99, 'Nochmal', 1, 'h')
    `);
    expect(error).toContain('book_chapter_number_key');
    await handle.db.execute(sql`delete from book_chapter where chapter_number = 99`);
  });
});

/**
 * Fuehrt eine Abfrage aus, die scheitern muss, und liefert die Meldung des
 * Datenbanktreibers. Drizzle verpackt den Originalfehler in `cause` - ohne
 * Auspacken bliebe der Constraint-Name unsichtbar.
 */
async function failingQuery(query: Parameters<typeof handle.db.execute>[0]): Promise<string> {
  try {
    await handle.db.execute(query);
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  throw new Error('Die Abfrage haette scheitern muessen.');
}
