import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBook } from '../../src/book/parser.js';
import type { ParsedAsset } from '../../src/book/parser.js';
import { FLAT_BOOK, MINI_BOOK } from './fixtures.js';

const mini = parseBook(readFileSync(join(MINI_BOOK, 'book.md'), 'utf8'));

function asset(mini_: typeof mini, fileName: string): ParsedAsset {
  const found = mini_.assets.find((entry) => entry.fileName === fileName);
  if (!found) throw new Error(`Fixture-Asset ${fileName} nicht gefunden`);
  return found;
}

describe('Markdown-Parser: Kapitel- und Sektionserkennung', () => {
  it('erkennt Teile und Kapitel aus dem Inhaltsverzeichnis', () => {
    expect(mini.parts).toEqual([
      { number: 1, title: 'GRUNDLAGEN' },
      { number: 2, title: 'PRAXIS' },
    ]);
    expect(
      mini.chapters.map((chapter) => [chapter.partNumber, chapter.number, chapter.title]),
    ).toEqual([
      [1, 1, 'Erste Grundlagen'],
      [1, 2, 'Zweiter Teil der Theorie'],
      [2, 3, 'Angewandte Praxis'],
    ]);
  });

  it('setzt einen ueber zwei Ueberschriften umbrochenen Kapiteltitel zusammen', () => {
    // Im Fixture steht "# 02 ZWEITER TEIL DER" gefolgt von "# THEORIE".
    const chapter = mini.chapters.find((entry) => entry.number === 2);
    expect(chapter?.title).toBe('Zweiter Teil der Theorie');
    // Die Fortsetzungszeile darf keine eigene Sektion werden.
    expect(mini.sections.filter((section) => section.title === 'THEORIE')).toEqual([]);
  });

  it('findet ein unnummeriertes Kapitel ueber seinen Titel', () => {
    // Im Fixture steht "# ANGEWANDTE PRAXIS" ohne fuehrende Kapitelnummer.
    const chapter = mini.chapters.find((entry) => entry.number === 3);
    expect(chapter?.title).toBe('Angewandte Praxis');
    expect(chapter?.partNumber).toBe(2);
  });

  it('erkennt Sektionen samt Hierarchieebene und Reihenfolge', () => {
    const chapterOne = mini.sections.filter((section) => section.chapterNumber === 1);
    expect(chapterOne.map((section) => [section.title, section.level, section.ordinal])).toEqual([
      ['Ein Abschnitt', 2, 0],
      ['Ein Unterabschnitt', 3, 1],
    ]);
  });

  it('speichert den Volltext der Sektion', () => {
    const section = mini.sections.find((entry) => entry.title === 'Ein Abschnitt');
    expect(section?.body).toContain('Ein Absatz auf Seite 3.');
    expect(section?.key).toBe('ch01/ein-abschnitt');
  });

  it('meldet eine Abweichung von der erwarteten Struktur, statt sie zu verschweigen', () => {
    // Das Fixture hat 3 Kapitel in 2 Teilen - erwartet werden 14 in 3.
    expect(mini.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(['chapter-count', 'part-count']),
    );
  });

  it('faellt ohne Inhaltsverzeichnis auf nummerierte Ueberschriften zurueck', () => {
    const flat = parseBook(readFileSync(join(FLAT_BOOK, 'book.md'), 'utf8'));
    expect(flat.chapters.map((chapter) => chapter.title)).toEqual(['Nur ein Kapitel']);
    expect(flat.issues.map((issue) => issue.kind)).toContain('toc-missing');
  });
});

describe('Markdown-Parser: Seitenmarker', () => {
  it('ordnet Sektionen ihren Seitenbereich zu', () => {
    const section = mini.sections.find((entry) => entry.title === 'Ein Abschnitt');
    expect(section?.pageStart).toBe(2);
    expect(section?.pageEnd).toBe(3);
  });

  it('ordnet Kapiteln ihren Seitenbereich zu', () => {
    const chapter = mini.chapters.find((entry) => entry.number === 1);
    expect(chapter?.pageStart).toBe(2);
    expect(chapter?.pageEnd).toBe(3);
  });

  it('liest die Seitenzahl eines Assets aus dem Dateinamen', () => {
    expect(asset(mini, 'p0003_01.jpeg').page).toBe(3);
    expect(asset(mini, 'p0003_01.jpeg').indexOnPage).toBe(1);
  });
});

describe('Markdown-Parser: Bildreferenzen und Unterschriften', () => {
  it('erfasst jede Bildreferenz mit ihrer umgebenden Sektion', () => {
    expect(mini.assets).toHaveLength(8);
    expect(asset(mini, 'p0003_01.jpeg').sectionKey).toBe('ch01/ein-abschnitt');
    expect(asset(mini, 'p0003_02.jpeg').sectionKey).toBe('ch01/ein-unterabschnitt');
    // Der Vorspann vor dem ersten Kapitel gehoert zu keiner Sektion.
    expect(asset(mini, 'p0001_01.jpeg').sectionKey).toBeNull();
  });

  it('speichert Unterschriften mit Prozentwerten verlustfrei und strukturiert', () => {
    const caption = asset(mini, 'p0003_01.jpeg').caption;
    expect(caption?.raw).toBe(
      '*Hand Range 1: BN vs BB (25bb)*\n*• Raise 2.2x 41.5% / • Fold 58.5%*',
    );
    expect(caption?.label).toBe('Hand Range');
    expect(caption?.number).toBe(1);
    expect(caption?.spot).toBe('BN vs BB (25bb)');
    expect(caption?.actions).toEqual([
      { action: 'Raise 2.2x', percent: 41.5 },
      { action: 'Fold', percent: 58.5 },
    ]);
  });

  it('verwirft eine Unterschrift ohne erkennbare Struktur nicht', () => {
    const caption = asset(mini, 'p0004_03.jpeg').caption;
    expect(caption?.label).toBeNull();
    expect(caption?.number).toBeNull();
    expect(caption?.raw).toBe('*Ein Hinweis, der keiner Unterschrift-Systematik folgt.*');
  });

  it('laesst Assets ohne Unterschrift als solche stehen', () => {
    expect(asset(mini, 'p0005_01.jpeg').caption).toBeNull();
  });
});
