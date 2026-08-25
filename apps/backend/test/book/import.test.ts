import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { analyzeBook, importBook } from '../../src/book/import.js';
import { buildReport } from '../../src/book/report.js';
import { BookSourceError } from '../../src/book/source.js';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { bookAsset, bookChapter, bookSection } from '../../src/db/schema.js';
import { copyFixture, emptyDir, MINI_BOOK } from './fixtures.js';
import { TEST_DATABASE_URL } from '../db/setup.js';

const handle: DbHandle = createDb(TEST_DATABASE_URL, { max: 2 });

afterAll(async () => {
  await handle.close();
});

async function counts(): Promise<{ chapters: number; sections: number; assets: number }> {
  const [chapters] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(bookChapter);
  const [sections] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(bookSection);
  const [assets] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(bookAsset);
  return { chapters: chapters?.n ?? 0, sections: sections?.n ?? 0, assets: assets?.n ?? 0 };
}

async function truncate(): Promise<void> {
  await handle.db.execute(sql`truncate table book_asset, book_section, book_chapter cascade`);
}

describe('Buchimport in die Datenbank', () => {
  beforeEach(async () => {
    await truncate();
  });

  it('legt Kapitel, Sektionen und Assets an', async () => {
    const result = await importBook(handle.db, { sourceDir: MINI_BOOK });
    expect(result.counts.chapters.inserted).toBe(3);
    expect(result.counts.sections.inserted).toBe(4);
    expect(result.counts.assets.inserted).toBe(8);
    expect(await counts()).toEqual({ chapters: 3, sections: 4, assets: 8 });
  });

  it('haengt Assets an ihre Sektion', async () => {
    await importBook(handle.db, { sourceDir: MINI_BOOK });
    const rows = await handle.db
      .select({ file: bookAsset.fileName, sectionKey: bookSection.sectionKey })
      .from(bookAsset)
      .leftJoin(bookSection, sql`${bookAsset.sectionId} = ${bookSection.id}`);
    const byFile = Object.fromEntries(rows.map((row) => [row.file, row.sectionKey]));
    expect(byFile['p0003_01.jpeg']).toBe('ch01/ein-abschnitt');
    expect(byFile['p0001_01.jpeg']).toBeNull();
  });

  it('ist idempotent: zweiter Lauf aendert nichts', async () => {
    await importBook(handle.db, { sourceDir: MINI_BOOK });
    const before = await counts();
    const beforeIds = await handle.db
      .select({ id: bookAsset.id, path: bookAsset.relativePath, updatedAt: bookAsset.updatedAt })
      .from(bookAsset)
      .orderBy(bookAsset.relativePath);

    const second = await importBook(handle.db, { sourceDir: MINI_BOOK });
    expect(second.counts.chapters).toMatchObject({ inserted: 0, updated: 0, unchanged: 3 });
    expect(second.counts.sections).toMatchObject({ inserted: 0, updated: 0, unchanged: 4 });
    expect(second.counts.assets).toMatchObject({ inserted: 0, updated: 0, unchanged: 8 });

    expect(await counts()).toEqual(before);
    const afterIds = await handle.db
      .select({ id: bookAsset.id, path: bookAsset.relativePath, updatedAt: bookAsset.updatedAt })
      .from(bookAsset)
      .orderBy(bookAsset.relativePath);
    expect(afterIds).toEqual(beforeIds);
  });

  it('erkennt geaenderte Quellen und behaelt die IDs bei', async () => {
    const { dir, cleanup } = copyFixture(MINI_BOOK);
    try {
      await importBook(handle.db, { sourceDir: dir });
      const [before] = await handle.db
        .select()
        .from(bookAsset)
        .where(sql`${bookAsset.fileName} = 'p0003_01.jpeg'`);

      const markdownPath = join(dir, 'book.md');
      const changed = readFileSync(markdownPath, 'utf8').replace(
        '*Hand Range 1: BN vs BB (25bb)*',
        '*Hand Range 1: BN vs BB (30bb)*',
      );
      writeFileSync(markdownPath, changed, 'utf8');

      const second = await importBook(handle.db, { sourceDir: dir });
      expect(second.counts.assets.updated).toBe(1);
      expect(second.counts.assets.unchanged).toBe(7);

      const [after] = await handle.db
        .select()
        .from(bookAsset)
        .where(sql`${bookAsset.fileName} = 'p0003_01.jpeg'`);
      // Gleiche Zeile, neuer Inhalt - T3.3/T3.4 haengen an dieser ID.
      expect(after?.id).toBe(before?.id);
      expect(after?.captionSpot).toBe('BN vs BB (30bb)');
    } finally {
      cleanup();
    }
  });

  it('markiert entfallene Eintraege, statt sie zu loeschen', async () => {
    const { dir, cleanup } = copyFixture(MINI_BOOK);
    try {
      await importBook(handle.db, { sourceDir: dir });

      const markdownPath = join(dir, 'book.md');
      const shortened = readFileSync(markdownPath, 'utf8').replace(
        '![Seite 4, Abbildung 3](bilder/p0004_03.jpeg)',
        '',
      );
      writeFileSync(markdownPath, shortened, 'utf8');

      const second = await importBook(handle.db, { sourceDir: dir });
      expect(second.counts.assets.removed).toBe(1);
      // Die Zeile bleibt erhalten - nachgelagerte Chart-Daten gehen nicht verloren.
      expect((await counts()).assets).toBe(8);
      const [row] = await handle.db
        .select()
        .from(bookAsset)
        .where(sql`${bookAsset.fileName} = 'p0004_03.jpeg'`);
      expect(row?.removedAt).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('setzt einen wieder aufgetauchten Eintrag zurueck', async () => {
    const { dir, cleanup } = copyFixture(MINI_BOOK);
    try {
      const original = readFileSync(join(dir, 'book.md'), 'utf8');
      writeFileSync(
        join(dir, 'book.md'),
        original.replace('![Seite 4, Abbildung 3](bilder/p0004_03.jpeg)', ''),
        'utf8',
      );
      await importBook(handle.db, { sourceDir: dir });
      writeFileSync(join(dir, 'book.md'), original, 'utf8');

      const second = await importBook(handle.db, { sourceDir: dir });
      expect(second.counts.assets.inserted).toBe(1);
      expect((await counts()).assets).toBe(8);
    } finally {
      cleanup();
    }
  });

  it('setzt waehrend des Imports keinen KI-Aufruf ab', async () => {
    const before = await handle.db.execute(sql`select count(*)::int as n from llm_call_log`);
    await importBook(handle.db, { sourceDir: MINI_BOOK });
    const after = await handle.db.execute(sql`select count(*)::int as n from llm_call_log`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('bricht ohne Quellen ab, bevor irgendetwas geschrieben wird', async () => {
    const { dir, cleanup } = emptyDir();
    try {
      await expect(importBook(handle.db, { sourceDir: dir })).rejects.toThrowError(BookSourceError);
      expect(await counts()).toEqual({ chapters: 0, sections: 0, assets: 0 });
    } finally {
      cleanup();
    }
  });
});

describe('Trockenlauf und Report', () => {
  it('schreibt im Trockenlauf nichts und braucht keine Datenbank', async () => {
    await truncate();
    const result = analyzeBook({ sourceDir: MINI_BOOK });
    expect(result.dryRun).toBe(true);
    expect(result.counts.assets.inserted).toBe(8);
    expect(await counts()).toEqual({ chapters: 0, sections: 0, assets: 0 });
  });

  it('weist fehlende und verwaiste Bilddateien aus', () => {
    const { dir, cleanup } = copyFixture(MINI_BOOK);
    try {
      rmSync(join(dir, 'bilder', 'p0004_02.jpeg'));
      writeFileSync(join(dir, 'bilder', 'p0009_01.jpeg'), 'FIXTURE\n', 'utf8');

      const report = buildReport(analyzeBook({ sourceDir: dir }));
      expect(report.missingImageFiles).toEqual(['bilder/p0004_02.jpeg']);
      expect(report.orphanImageFiles).toEqual(['p0009_01.jpeg']);
    } finally {
      cleanup();
    }
  });

  it('nennt Zaehlstaende je Typ und die unsicheren Faelle', () => {
    const report = buildReport(analyzeBook({ sourceDir: MINI_BOOK }));
    expect(report.assetsByType).toEqual({
      hand_range: 1,
      table: 1,
      diagram: 1,
      formula: 2,
      other: 3,
    });
    expect(report.uncertainClassifications).toBe(2);
    expect(report.unstructuredCaptions).toBe(1);
    expect(report.captionsWithPercentages).toBe(1);
    expect(report.source.layout).toBe('subdirectory');
  });
});
