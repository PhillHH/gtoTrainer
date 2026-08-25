import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BookSourceError, parseImageFileName, resolveBookSource } from '../../src/book/source.js';
import { copyFixture, emptyDir, FLAT_BOOK, MINI_BOOK } from './fixtures.js';

/**
 * Vorbedingung aus AP03.md: Ohne Buchquellen bricht T3.1 planmaessig ab -
 * sauber, mit einer Meldung, die benennt was fehlt und wohin es gehoert.
 * Keine Teilverarbeitung, kein leerer Import.
 */
describe('Buchquellen-Vorbedingung', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('bricht ab, wenn das Verzeichnis fehlt', () => {
    const missing = join(emptyRegistered(), 'gibt-es-nicht');
    expect(() => resolveBookSource(missing)).toThrowError(BookSourceError);
    expect(() => resolveBookSource(missing)).toThrowError(/Buchquellen-Verzeichnis fehlt/);
  });

  it('bricht ab, wenn das Verzeichnis leer ist', () => {
    const dir = emptyRegistered();
    expect(() => resolveBookSource(dir)).toThrowError(/Buchquellen-Verzeichnis ist leer/);
  });

  it('bricht ab, wenn die Markdown-Datei fehlt', () => {
    const { dir, cleanup } = copyFixture(MINI_BOOK);
    cleanups.push(cleanup);
    rmSync(join(dir, 'book.md'));
    expect(() => resolveBookSource(dir)).toThrowError(/Buch-Markdown fehlt/);
  });

  it('bricht ab, wenn keine Bilddateien vorliegen', () => {
    const { dir, cleanup } = copyFixture(MINI_BOOK);
    cleanups.push(cleanup);
    rmSync(join(dir, 'bilder'), { recursive: true });
    expect(() => resolveBookSource(dir)).toThrowError(/Bilddateien fehlen/);
  });

  it('nennt in der Fehlermeldung Pfad und erwarteten Inhalt', () => {
    const dir = emptyRegistered();
    try {
      resolveBookSource(dir);
      expect.unreachable('resolveBookSource haette werfen muessen');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(dir);
      expect(message).toContain('pXXXX_YY.jpeg');
      expect(message).toContain('README.md');
    }
  });

  it('erkennt Bilder in einem Unterverzeichnis', () => {
    const source = resolveBookSource(MINI_BOOK);
    expect(source.layout).toBe('subdirectory');
    expect(source.imageDirRelative).toBe('bilder');
    expect(source.markdownFile).toBe('book.md');
    expect(source.imageFiles).toContain('p0003_01.jpeg');
  });

  it('erkennt flach abgelegte Bilder', () => {
    const source = resolveBookSource(FLAT_BOOK);
    expect(source.layout).toBe('flat');
    expect(source.imageDirRelative).toBe('.');
    expect(source.imageFiles).toEqual(['p0001_01.jpeg']);
  });

  it('bricht bei mehreren Markdown-Dateien ab', () => {
    const { dir, cleanup } = copyFixture(MINI_BOOK);
    cleanups.push(cleanup);
    writeFileSync(join(dir, 'zweites-buch.md'), '# Zweites Buch\n', 'utf8');
    expect(() => resolveBookSource(dir)).toThrowError(/Mehrdeutige Buchquelle/);
  });

  it('liest Seite und Zaehler aus dem Dateinamen', () => {
    expect(parseImageFileName('p0306_02.jpeg')).toEqual({ page: 306, indexOnPage: 2 });
    expect(parseImageFileName('bilder/p0001_01.jpeg')).toEqual({ page: 1, indexOnPage: 1 });
    expect(parseImageFileName('cover.jpeg')).toBeUndefined();
  });

  function emptyRegistered(): string {
    const { dir, cleanup } = emptyDir();
    cleanups.push(cleanup);
    return dir;
  }
});
