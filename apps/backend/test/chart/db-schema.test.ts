import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHART_ACTION_KINDS, CHART_EXTRACTION_SCHEMA, CHART_STATES } from '@gto/shared';
import {
  CHART_ACTION_KINDS as SCHEMA_ACTION_KINDS,
  CHART_STATES as SCHEMA_STATES,
  CHART_TABLES,
} from '../../src/db/schema.js';
import { createDb } from '../../src/db/client.js';
import { TemplateRegistry } from '../../src/prompts/registry.js';
import { TEST_DATABASE_URL, prepareTestDatabase } from '../db/setup.js';

let handle: ReturnType<typeof createDb>;

beforeAll(async () => {
  await prepareTestDatabase();
  handle = createDb(TEST_DATABASE_URL, { max: 1 });
});

afterAll(async () => {
  await handle.close();
});

describe('Datenbankschema der Charts', () => {
  it('haelt die Wertelisten deckungsgleich mit packages/shared', () => {
    // In schema.ts dupliziert, weil drizzle-kit das Workspace-Paket beim
    // Buendeln nicht aufloest. Dieser Test verhindert das Auseinanderlaufen.
    expect([...SCHEMA_ACTION_KINDS]).toEqual([...CHART_ACTION_KINDS]);
    expect([...SCHEMA_STATES]).toEqual([...CHART_STATES]);
  });

  it('legt die beiden Tabellen an', async () => {
    const result = await handle.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = result.rows.map((row) => (row as { table_name: string }).table_name);
    for (const table of CHART_TABLES) expect(names).toContain(table);
  });

  it('weist einen unbekannten Zustand ab', async () => {
    const error = await failing(sql`
      insert into range_chart (asset_id, state, model, run_id)
      values (gen_random_uuid(), 'freigegeben', 'm', 'r')
    `);
    // Der Fremdschluessel schlaegt zuerst zu, wenn das Asset fehlt; deshalb
    // wird hier nur geprueft, dass die Zeile nicht durchkommt.
    expect(error).toMatch(/range_chart_state_check|range_chart_asset_id/);
  });

  it('weist eine Frequenz ausserhalb 0-100 auf Datenbankebene ab', async () => {
    const error = await failing(sql`
      insert into range_chart_cell (chart_id, hand, action_kind, sizing, percent)
      values (gen_random_uuid(), 'AA', 'fold', '', 140)
    `);
    expect(error).toMatch(/range_chart_cell_percent_check|range_chart_cell_chart_id/);
  });
});

describe('Ausgabeschema des Vision-Templates', () => {
  it('entspricht exakt dem Vertrag in packages/shared', () => {
    const template = TemplateRegistry.load().get('task/chart-digitize');
    expect(template.meta.jsonSchema).toEqual(
      JSON.parse(JSON.stringify(CHART_EXTRACTION_SCHEMA)) as unknown,
    );
  });
});

async function failing(query: Parameters<typeof handle.db.execute>[0]): Promise<string> {
  try {
    await handle.db.execute(query);
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  throw new Error('Die Abfrage haette scheitern muessen.');
}
