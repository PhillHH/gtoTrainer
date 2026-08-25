import { asc, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import {
  CONCEPT_LEVELS as SCHEMA_LEVELS,
  CONCEPT_STATES as SCHEMA_STATES,
  CONCEPT_TABLES,
  CONCEPT_TOPIC_AREAS as SCHEMA_TOPICS,
  concept,
  conceptChart,
  conceptPrerequisite,
  conceptSection,
} from '../../src/db/schema.js';
import { CONCEPT_LEVELS, CONCEPT_STATES, CONCEPT_TOPIC_AREA_IDS } from '@gto/shared';
import { normalizeSuggestions } from '../../src/concept/normalize.js';
import {
  assignChartsBySection,
  collectIssues,
  persistConcepts,
  planChapterParts,
  replacePrerequisites,
} from '../../src/concept/store.js';
import { TEST_DATABASE_URL, prepareTestDatabase } from '../db/setup.js';
import { clearAll, seedBook } from './helpers.js';

let handle: DbHandle;

beforeAll(async () => {
  await prepareTestDatabase();
  handle = createDb(TEST_DATABASE_URL, { max: 2 });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await clearAll(handle.db);
});

function suggestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    titel: 'Pot Odds',
    kurzdefinition: 'Verhaeltnis von Einsatz zu moeglichem Gewinn, an dem sich ein Call misst.',
    themenbereich: 'grundlagen-mathematik',
    ab_level: 'einsteiger',
    voraussetzungen: [],
    sektionen: ['ch01/grundbegriffe'],
    ...overrides,
  };
}

async function persist(chapterNumber: number, raw: readonly Record<string, unknown>[]) {
  const index = await handle.db.select({ slug: concept.slug }).from(concept);
  const normalized = normalizeSuggestions(raw as never, new Set(index.map((row) => row.slug)));
  return persistConcepts(handle.db, chapterNumber, normalized.concepts);
}

describe('Schema des Konzept-Graphen', () => {
  it('haelt die Wertelisten deckungsgleich mit packages/shared', () => {
    expect([...SCHEMA_TOPICS]).toEqual([...CONCEPT_TOPIC_AREA_IDS]);
    expect([...SCHEMA_LEVELS]).toEqual([...CONCEPT_LEVELS]);
    expect([...SCHEMA_STATES]).toEqual([...CONCEPT_STATES]);
  });

  it('legt die vier Tabellen an', async () => {
    const result = await handle.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = result.rows.map((row) => (row as { table_name: string }).table_name);
    for (const table of CONCEPT_TABLES) expect(names).toContain(table);
  });

  it('weist einen unbekannten Themenbereich ab', async () => {
    const book = await seedBook(handle.db);
    const error = await failing(sql`
      insert into concept (chapter_id, slug, title, summary, topic_area, min_level, ordinal)
      values (${book.chapterIds[1]}, 'x', 'X', 'Y', 'gibt-es-nicht', 'einsteiger', 0)
    `);
    expect(error).toContain('concept_topic_area_check');
  });

  it('weist eine Voraussetzungskante auf sich selbst ab', async () => {
    const book = await seedBook(handle.db);
    const [row] = await handle.db
      .insert(concept)
      .values({
        chapterId: book.chapterIds[1] as string,
        slug: 'selbstverweis',
        title: 'Selbstverweis',
        summary: 'Test',
        topicArea: 'spieltheorie',
        minLevel: 'einsteiger',
        ordinal: 0,
      })
      .returning({ id: concept.id });
    const id = (row as { id: string }).id;

    const error = await failing(sql`
      insert into concept_prerequisite (concept_id, prerequisite_id) values (${id}, ${id})
    `);
    expect(error).toContain('concept_prerequisite_no_self_check');
  });
});

describe('Kapitel in Teillaeufe schneiden', () => {
  it('haelt jede Gruppe unter dem Budget und zerschneidet keine Sektion', () => {
    const sections = Array.from({ length: 5 }, (_, index) => ({
      id: `s${index}`,
      sectionKey: `ch01/s${index}`,
      title: 'T',
      body: 'x'.repeat(40),
    }));
    const parts = planChapterParts(sections, 100);
    expect(parts.map((part) => part.length)).toEqual([2, 2, 1]);
    expect(parts.flat()).toHaveLength(5);
  });

  it('liefert fuer ein leeres Kapitel keine Teile', () => {
    expect(planChapterParts([], 100)).toEqual([]);
  });
});

describe('Vorschlaege persistieren', () => {
  it('legt Konzepte als draft an und verknuepft die Sektion', async () => {
    await seedBook(handle.db);
    const result = await persist(1, [suggestion()]);

    expect(result.inserted).toBe(1);
    const rows = await handle.db.select().from(concept);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'draft', origin: 'ai', slug: 'pot-odds' });

    const links = await handle.db.select().from(conceptSection);
    expect(links).toHaveLength(1);
  });

  it('loest Voraussetzungen innerhalb desselben Laufs auf', async () => {
    await seedBook(handle.db);
    await persist(1, [
      suggestion(),
      suggestion({
        titel: 'Erwartungswert',
        voraussetzungen: ['Pot Odds'],
        sektionen: ['ch01/kennzahlen'],
      }),
    ]);

    const edges = await handle.db.select().from(conceptPrerequisite);
    expect(edges).toHaveLength(1);
  });

  it('haelt eine nicht aufloesbare Voraussetzung am Konzept fest', async () => {
    await seedBook(handle.db);
    const result = await persist(1, [suggestion({ voraussetzungen: ['Gibt es nicht'] })]);

    expect(result.unresolvedPrerequisites).toBe(1);
    const [row] = await handle.db.select().from(concept);
    expect(row?.unresolvedPrerequisites).toEqual(['Gibt es nicht']);
  });

  it('fuehrt eine Dublette aus einem spaeteren Kapitel mit dem Original zusammen', async () => {
    await seedBook(handle.db);
    await persist(1, [suggestion()]);
    const second = await persist(2, [
      suggestion({ titel: 'Pot Odds (Grundlagen)', sektionen: ['ch02/gleichgewicht'] }),
    ]);

    // Kein zweites Konzept - aber der Sektionsverweis wandert nicht mit, weil
    // der Vorschlag schon in der Normalisierung als Dublette ausscheidet.
    expect(second.inserted).toBe(0);
    expect(await count(concept)).toBe(1);
  });

  it('speichert keine Kante, die einen Zyklus schliessen wuerde', async () => {
    await seedBook(handle.db);
    await persist(1, [
      suggestion({ titel: 'A', voraussetzungen: ['B'] }),
      suggestion({ titel: 'B', voraussetzungen: ['A'], sektionen: ['ch01/kennzahlen'] }),
    ]);

    const issues = await collectIssues(handle.db);
    expect(issues.cycles).toEqual([]);
    expect(await count(conceptPrerequisite)).toBe(1);
  });

  it('zaehlt Konzepte ohne Sektionszuordnung als Befund', async () => {
    await seedBook(handle.db);
    await persist(1, [suggestion({ sektionen: ['ch99/gibt-es-nicht'] })]);

    const issues = await collectIssues(handle.db);
    expect(issues.withoutSection).toHaveLength(1);
  });

  it('meldet Kapitel ohne Konzepte', async () => {
    await seedBook(handle.db);
    await persist(1, [suggestion()]);

    const issues = await collectIssues(handle.db);
    expect(issues.emptyChapters).toEqual([2]);
  });
});

describe('Chart-Zuordnung', () => {
  it('verknuepft hand_range-Assets ueber die gemeinsame Sektion', async () => {
    await seedBook(handle.db);
    await persist(1, [suggestion({ sektionen: ['ch01/kennzahlen'] })]);

    const result = await assignChartsBySection(handle.db);
    expect(result.links).toBe(1);
    expect(await count(conceptChart)).toBe(1);
  });

  it('ist wiederholbar und legt keine Dubletten an', async () => {
    await seedBook(handle.db);
    await persist(1, [suggestion({ sektionen: ['ch01/kennzahlen'] })]);

    await assignChartsBySection(handle.db);
    const second = await assignChartsBySection(handle.db);
    expect(second.links).toBe(0);
    expect(await count(conceptChart)).toBe(1);
  });
});

describe('Voraussetzungen aus der Review-Ansicht setzen', () => {
  it('lehnt eine Kante ab, die einen Zyklus schliesst', async () => {
    await seedBook(handle.db);
    await persist(1, [
      suggestion({ titel: 'A' }),
      suggestion({ titel: 'B', voraussetzungen: ['A'], sektionen: ['ch01/kennzahlen'] }),
    ]);

    const rows = await handle.db.select().from(concept).orderBy(asc(concept.title));
    const a = rows.find((row) => row.title === 'A');
    const b = rows.find((row) => row.title === 'B');

    // A soll jetzt B voraussetzen - das waere der Zyklus A -> B -> A.
    const result = await replacePrerequisites(handle.db, a?.id as string, [b?.id as string]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect((await collectIssues(handle.db)).cycles).toEqual([]);
  });
});

async function count(
  table: typeof concept | typeof conceptPrerequisite | typeof conceptChart | typeof conceptSection,
): Promise<number> {
  const [row] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(table);
  return row?.n ?? 0;
}

async function failing(query: Parameters<typeof handle.db.execute>[0]): Promise<string> {
  try {
    await handle.db.execute(query);
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  throw new Error('Die Abfrage haette scheitern muessen.');
}
