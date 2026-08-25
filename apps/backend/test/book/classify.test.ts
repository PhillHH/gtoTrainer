import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCaption } from '../../src/book/caption.js';
import { classifyAsset } from '../../src/book/classify.js';
import { parseBook } from '../../src/book/parser.js';
import { MINI_BOOK } from './fixtures.js';

/**
 * Scope-Delta 2 aus AP03.md: Jedes Asset wird typisiert, damit T3.3
 * ausschliesslich echte Range-Charts durch die Vision-Pipeline schickt.
 * Regelbasiert, ohne KI-Aufruf.
 */
function classify(options: {
  caption?: string[];
  before?: string;
  after?: string;
  frontMatter?: boolean;
}) {
  return classifyAsset({
    caption: options.caption ? parseCaption(options.caption) : null,
    textBefore: options.before ?? 'Ein gewoehnlicher Absatz',
    textAfter: options.after ?? 'Ein weiterer Absatz',
    isFrontMatter: options.frontMatter ?? false,
  });
}

describe('Asset-Klassifikation', () => {
  it('klassifiziert hand_range anhand des Etiketts', () => {
    expect(classify({ caption: ['*Hand Range 96: SB vs BB (15bb)*'] })).toEqual({
      type: 'hand_range',
      confidence: 'certain',
      rule: 'caption-label',
    });
  });

  it('klassifiziert table anhand des Etiketts', () => {
    expect(classify({ caption: ['*Table 45: SB GTO Action Frequencies*'] })).toEqual({
      type: 'table',
      confidence: 'certain',
      rule: 'caption-label',
    });
  });

  it('klassifiziert diagram anhand des Etiketts', () => {
    expect(classify({ caption: ['*Diagram 2: Poker Suits 4x4 Grid*'] })).toEqual({
      type: 'diagram',
      confidence: 'certain',
      rule: 'caption-label',
    });
  });

  it('ordnet Heatmap dem Typ diagram zu', () => {
    expect(classify({ caption: ['*Heatmap 3: Risk Premium*'] }).type).toBe('diagram');
  });

  it('klassifiziert formula anhand des Doppelpunkt-Vorlaufs', () => {
    expect(classify({ before: 'Die Anzahl der Kombinationen ist:' })).toEqual({
      type: 'formula',
      confidence: 'certain',
      rule: 'formula-lead-in',
    });
  });

  it('klassifiziert formula anhand der nachfolgenden Erlaeuterung', () => {
    expect(classify({ before: 'Ein Absatz', after: 'where X is the number of cards' })).toEqual({
      type: 'formula',
      confidence: 'certain',
      rule: 'formula-where',
    });
  });

  it('klassifiziert den Vorspann des Buches als other', () => {
    expect(classify({ frontMatter: true })).toEqual({
      type: 'other',
      confidence: 'certain',
      rule: 'front-matter',
    });
  });

  it('markiert eine mehrdeutige Unterschrift als unsicher, statt zu raten', () => {
    const result = classify({ caption: ['*Ein Hinweis ohne Systematik.*'] });
    expect(result).toEqual({
      type: 'other',
      confidence: 'uncertain',
      rule: 'caption-without-label',
    });
  });

  it('markiert ein Asset ohne jeden Anhaltspunkt als unsicher', () => {
    expect(classify({})).toEqual({
      type: 'other',
      confidence: 'uncertain',
      rule: 'unclassified',
    });
  });

  it('nimmt Aktions-Prozente als Hinweis auf ein Range-Chart, aber nur unsicher', () => {
    expect(classify({ caption: ['*• Raise 41.5% / • Fold 58.5%*'] })).toEqual({
      type: 'hand_range',
      confidence: 'uncertain',
      rule: 'caption-actions',
    });
  });

  it('typisiert die Assets des Fixtures wie erwartet', () => {
    const parsed = parseBook(readFileSync(join(MINI_BOOK, 'book.md'), 'utf8'));
    const byFile = Object.fromEntries(
      parsed.assets.map((entry) => [entry.fileName, `${entry.assetType}/${entry.confidence}`]),
    );
    expect(byFile).toEqual({
      'p0001_01.jpeg': 'other/certain',
      'p0003_01.jpeg': 'hand_range/certain',
      'p0003_02.jpeg': 'formula/certain',
      'p0004_01.jpeg': 'table/certain',
      'p0004_02.jpeg': 'diagram/certain',
      'p0004_03.jpeg': 'other/uncertain',
      'p0005_02.jpeg': 'formula/certain',
      'p0005_01.jpeg': 'other/uncertain',
    });
  });
});
