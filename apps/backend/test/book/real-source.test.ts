import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { importBook } from '../../src/book/import.js';
import { buildReport } from '../../src/book/report.js';
import { BOOK_SOURCE_DIR } from '../../src/book/source.js';
import { findRepoRoot } from '../../src/config/env.js';
import { createDb } from '../../src/db/client.js';
import { bookAsset, bookChapter, bookSection } from '../../src/db/schema.js';
import { EXPECTED_CHAPTER_COUNT, EXPECTED_PART_COUNT } from '../../src/book/parser.js';
import { TEST_DATABASE_URL } from '../db/setup.js';

/**
 * Integrationslauf gegen die **echten** Buchquellen (AP3.T3.1, Subtask 9).
 *
 * Die Quellen sind git-ignorierter Pflicht-Input des Nutzers und liegen in der
 * CI nicht vor. Der Block ueberspringt sich dort selbst, statt rot zu werden -
 * er ist an dieser Kennzeichnung als "nur lokal" zu erkennen.
 */
const sourceDir = resolve(findRepoRoot(), ...BOOK_SOURCE_DIR.split('/'));
const available = existsSync(sourceDir);

const handle = createDb(TEST_DATABASE_URL, { max: 2 });

afterAll(async () => {
  await handle.close();
});

describe.skipIf(!available)('Buchimport gegen die echten Buchquellen (nur lokal)', () => {
  it('erzeugt die vollstaendige Struktur und ist beim zweiten Lauf unveraendert', async () => {
    await handle.db.execute(sql`truncate table book_asset, book_section, book_chapter cascade`);

    const first = await importBook(handle.db, { sourceDir });
    const report = buildReport(first);

    expect(report.parts).toBe(EXPECTED_PART_COUNT);
    expect(report.chapters).toBe(EXPECTED_CHAPTER_COUNT);
    expect(report.chapterList.map((chapter) => chapter.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(report.issues).toEqual([]);
    expect(report.assetsByType.hand_range).toBeGreaterThan(0);

    const before = await tableCounts();

    const second = await importBook(handle.db, { sourceDir });
    expect(second.counts.chapters.inserted + second.counts.chapters.updated).toBe(0);
    expect(second.counts.sections.inserted + second.counts.sections.updated).toBe(0);
    expect(second.counts.assets.inserted + second.counts.assets.updated).toBe(0);
    expect(second.counts.assets.removed).toBe(0);
    expect(await tableCounts()).toEqual(before);
  }, 180_000);
});

async function tableCounts(): Promise<Record<string, number>> {
  const [chapters] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(bookChapter);
  const [sections] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(bookSection);
  const [assets] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(bookAsset);
  return { chapters: chapters?.n ?? 0, sections: sections?.n ?? 0, assets: assets?.n ?? 0 };
}
