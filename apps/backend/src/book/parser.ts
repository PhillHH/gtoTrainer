import type { BookAssetConfidence, BookAssetType, BookCaption } from '@gto/shared';
import { isCaptionLine, parseCaption } from './caption.js';
import { classifyAsset } from './classify.js';
import type { ClassificationRule } from './classify.js';
import { parseImageFileName } from './source.js';

/**
 * Markdown-Parser der Buchquelle (AP3.T3.1, Subtasks 3-5).
 *
 * Deterministisch, ohne jeden KI-Aufruf. Der Parser kennt drei Bauteile der
 * Quelle:
 *
 * - Seitenmarker  `<!-- page 306 -->`
 * - Überschriften `# 01 POKER FUNDAMENTALS`, `## …`, `### …`
 * - Bildbezug     `![Seite 306, Abbildung 1](<verzeichnis>/p0306_01.jpeg)`
 *
 * **Kapitel werden über das Inhaltsverzeichnis des Buches bestimmt**, nicht
 * über die Überschriften allein: Im Fließtext sind zwei der vierzehn Kapitel
 * unnummeriert und vier über zwei Überschriftszeilen umbrochen. Das
 * Inhaltsverzeichnis nennt dagegen Teile und Kapitel vollständig - es ist die
 * einzige Stelle in der Quelle, an der die Sollstruktur steht.
 */

/** Erwartete Struktur laut AP03.md (14 Kapitel in 3 Teilen). */
export const EXPECTED_PART_COUNT = 3;
export const EXPECTED_CHAPTER_COUNT = 14;

const PAGE_MARKER = /^<!--\s*page\s+(\d+)\s*-->$/i;
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const IMAGE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const TOC_PART = /^\*\*PART\s+(\d+)\)\s*(.+?)\*\*$/i;
const TOC_CHAPTER = /^\*\*(\d{1,2})\s+(.+?)\*\*$/;
const NUMBERED_HEADING = /^(\d{1,2})\s+(.*\S)$/;

export interface ParsedPart {
  readonly number: number;
  readonly title: string;
}

export interface ParsedChapter {
  readonly number: number;
  readonly title: string;
  readonly partNumber: number;
  readonly partTitle: string;
  readonly ordinal: number;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
}

export interface ParsedSection {
  /** Stabiler fachlicher Schlüssel, siehe {@link sectionKey}. */
  readonly key: string;
  readonly chapterNumber: number;
  readonly title: string;
  /** Überschriftsebene 1-6 wie in der Quelle. */
  readonly level: number;
  readonly ordinal: number;
  readonly body: string;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
}

export interface ParsedAsset {
  /** Pfad relativ zur Wurzel der Buchquelle - zugleich fachlicher Schlüssel. */
  readonly relativePath: string;
  readonly fileName: string;
  readonly sectionKey: string | null;
  readonly chapterNumber: number | null;
  readonly page: number | null;
  readonly indexOnPage: number | null;
  readonly caption: BookCaption | null;
  readonly assetType: BookAssetType;
  readonly confidence: BookAssetConfidence;
  readonly rule: ClassificationRule;
  readonly ordinal: number;
}

/** Auffälligkeit, die im Import-Report sichtbar wird. */
export interface ParseIssue {
  readonly kind: string;
  readonly detail: string;
}

export interface ParsedBook {
  readonly parts: readonly ParsedPart[];
  readonly chapters: readonly ParsedChapter[];
  readonly sections: readonly ParsedSection[];
  readonly assets: readonly ParsedAsset[];
  readonly issues: readonly ParseIssue[];
}

/** Vergleichsform für Titel: Groß, ohne Mehrfach-Leerzeichen, ohne Schlusszeichen. */
function normalizeTitle(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:,;]+$/, '')
    .toUpperCase();
}

/** URL-taugliche Kurzform eines Titels. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'abschnitt'
  );
}

/**
 * Fachlicher Schlüssel einer Sektion: Kapitelnummer, Titel-Slug und - nur bei
 * Namensgleichheit innerhalb desselben Kapitels - ein Zähler. Bewusst **ohne**
 * laufende Nummer, damit ein eingeschobener Abschnitt nicht die Schlüssel aller
 * folgenden Sektionen verschiebt und dadurch beim Re-Import alles neu anlegt.
 */
function sectionKey(chapterNumber: number, title: string, duplicate: number): string {
  const base = `ch${String(chapterNumber).padStart(2, '0')}/${slugify(title)}`;
  return duplicate === 0 ? base : `${base}~${duplicate + 1}`;
}

interface Heading {
  readonly line: number;
  readonly level: number;
  readonly text: string;
}

/** Liest das Inhaltsverzeichnis: Teile und Kapitel mit Nummer und Titel. */
function parseTableOfContents(lines: readonly string[]): {
  parts: ParsedPart[];
  chapters: { number: number; title: string; partNumber: number }[];
  endLine: number;
} {
  const parts: ParsedPart[] = [];
  const chapters: { number: number; title: string; partNumber: number }[] = [];

  const start = lines.findIndex(
    (line) =>
      HEADING.test(line) &&
      normalizeTitle((HEADING.exec(line) as RegExpExecArray)[2] as string) === 'CONTENTS',
  );
  if (start < 0) return { parts, chapters, endLine: -1 };

  let currentPart = 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = (lines[i] as string).trim();
    const heading = HEADING.exec(trimmed);
    // Die nächste Überschrift beendet das Verzeichnis.
    if (heading) {
      end = i;
      break;
    }
    const part = TOC_PART.exec(trimmed);
    if (part) {
      currentPart = Number(part[1]);
      parts.push({ number: currentPart, title: (part[2] as string).trim() });
      continue;
    }
    const chapter = TOC_CHAPTER.exec(trimmed);
    if (chapter) {
      chapters.push({
        number: Number(chapter[1]),
        title: (chapter[2] as string).trim(),
        partNumber: currentPart,
      });
    }
  }

  return { parts, chapters, endLine: end };
}

/**
 * Sucht die Überschrift, an der ein Kapitel im Fließtext beginnt, und fügt
 * über mehrere Zeilen umbrochene Kapiteltitel wieder zusammen.
 */
function findChapterAnchor(
  headings: readonly Heading[],
  fromIndex: number,
  expected: { number: number; title: string },
): { headingIndex: number; lastHeadingIndex: number } | undefined {
  const wanted = normalizeTitle(expected.title);

  for (let i = fromIndex; i < headings.length; i++) {
    const heading = headings[i] as Heading;
    if (heading.level !== 1) continue;

    const numbered = NUMBERED_HEADING.exec(heading.text);
    const matchesNumber = numbered !== null && Number(numbered[1]) === expected.number;
    const rest = numbered ? (numbered[2] as string) : heading.text;
    if (!matchesNumber && normalizeTitle(heading.text) !== wanted) continue;

    // Titelfortsetzung einsammeln, solange das bisher Gelesene ein echter
    // Präfix des Solltitels ist (`# 06 THE THEORY OF` + `# TOURNAMENT PLAY`).
    let accumulated = normalizeTitle(rest);
    let last = i;
    while (accumulated !== wanted && wanted.startsWith(`${accumulated} `)) {
      const next = headings[last + 1];
      if (!next || next.level !== 1) break;
      const merged = normalizeTitle(`${accumulated} ${next.text}`);
      if (merged !== wanted && !wanted.startsWith(`${merged} `)) break;
      accumulated = merged;
      last += 1;
    }
    return { headingIndex: i, lastHeadingIndex: last };
  }
  return undefined;
}

/** Zerlegt die Buch-Markdown-Datei. */
export function parseBook(markdown: string): ParsedBook {
  const lines = markdown.split(/\r?\n/);
  const issues: ParseIssue[] = [];

  // Seitenzahl je Zeile vorberechnen - Sektionen und Bilder greifen darauf zu.
  const pageAt: (number | null)[] = new Array<number | null>(lines.length).fill(null);
  {
    let page: number | null = null;
    for (let i = 0; i < lines.length; i++) {
      const marker = PAGE_MARKER.exec((lines[i] as string).trim());
      if (marker) page = Number(marker[1]);
      pageAt[i] = page;
    }
  }

  /**
   * Seitenzahl am Ende eines Bereichs. Bewusst nicht `pageAt[to]`: Auf der
   * letzten Zeile eines Kapitels steht haeufig schon der Seitenmarker der
   * Folgeseite, auf der das naechste Kapitel beginnt.
   */
  const pageEndOf = (from: number, to: number): number | null => {
    for (let i = to; i >= from; i--) {
      const trimmed = (lines[i] as string).trim();
      if (trimmed === '' || PAGE_MARKER.test(trimmed)) continue;
      return pageAt[i] ?? null;
    }
    return pageAt[from] ?? null;
  };

  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING.exec(lines[i] as string);
    if (match)
      headings.push({ line: i, level: (match[1] as string).length, text: match[2] as string });
  }

  const toc = parseTableOfContents(lines);
  let parts: ParsedPart[] = toc.parts;
  let expectedChapters = toc.chapters;

  if (expectedChapters.length === 0) {
    // Rückfallebene ohne Inhaltsverzeichnis: nummerierte Überschriften. Für die
    // echte Buchquelle greift sie nicht - dort ist das Verzeichnis vorhanden.
    issues.push({
      kind: 'toc-missing',
      detail:
        'Kein Inhaltsverzeichnis gefunden; Kapitel wurden aus nummerierten Überschriften abgeleitet.',
    });
    expectedChapters = headings
      .filter((heading) => heading.level === 1 && NUMBERED_HEADING.test(heading.text))
      .map((heading) => {
        const numbered = NUMBERED_HEADING.exec(heading.text) as RegExpExecArray;
        return { number: Number(numbered[1]), title: numbered[2] as string, partNumber: 1 };
      });
    parts = expectedChapters.length > 0 ? [{ number: 1, title: 'Ohne Teilangabe' }] : [];
  }

  const partTitles = new Map(parts.map((part) => [part.number, part.title]));

  // Kapitel im Fließtext verankern.
  const anchors: {
    chapter: (typeof expectedChapters)[number];
    start: number;
    contentFrom: number;
  }[] = [];
  let searchFrom =
    toc.endLine >= 0 ? headings.findIndex((heading) => heading.line >= toc.endLine) : 0;
  if (searchFrom < 0) searchFrom = headings.length;

  for (const expected of expectedChapters) {
    const anchor = findChapterAnchor(headings, Math.max(searchFrom, 0), expected);
    if (!anchor) {
      issues.push({
        kind: 'chapter-not-found',
        detail: `Kapitel ${expected.number} ("${expected.title}") steht im Inhaltsverzeichnis, wurde im Fließtext aber nicht gefunden.`,
      });
      continue;
    }
    anchors.push({
      chapter: expected,
      start: (headings[anchor.headingIndex] as Heading).line,
      contentFrom: anchor.lastHeadingIndex + 1,
    });
    searchFrom = anchor.lastHeadingIndex + 1;
  }

  const chapters: ParsedChapter[] = [];
  const sections: ParsedSection[] = [];
  /** Zeilennummer der Überschrift je Sektion - fuer die Zuordnung der Bilder. */
  const sectionAnchors: SectionAnchor[] = [];

  for (let index = 0; index < anchors.length; index++) {
    const anchor = anchors[index] as (typeof anchors)[number];
    const next = anchors[index + 1];
    const endLine = next ? next.start - 1 : lines.length - 1;

    chapters.push({
      number: anchor.chapter.number,
      title: anchor.chapter.title,
      partNumber: anchor.chapter.partNumber,
      partTitle: partTitles.get(anchor.chapter.partNumber) ?? '',
      ordinal: index,
      pageStart: pageAt[anchor.start] ?? null,
      pageEnd: pageEndOf(anchor.start, endLine),
    });

    // Sektionen des Kapitels: alle Überschriften nach dem (ggf. umbrochenen)
    // Kapiteltitel bis zum Kapitelende.
    const used = new Map<string, number>();
    const inChapter = headings.filter(
      (heading, headingIndex) =>
        headingIndex >= anchor.contentFrom &&
        heading.line > anchor.start &&
        heading.line <= endLine,
    );

    for (let s = 0; s < inChapter.length; s++) {
      const heading = inChapter[s] as Heading;
      const nextHeading = inChapter[s + 1];
      const sectionEnd = nextHeading ? nextHeading.line - 1 : endLine;
      const duplicate = used.get(heading.text) ?? 0;
      used.set(heading.text, duplicate + 1);

      const key = sectionKey(anchor.chapter.number, heading.text, duplicate);
      sectionAnchors.push({ key, chapterNumber: anchor.chapter.number, line: heading.line });
      sections.push({
        key,
        chapterNumber: anchor.chapter.number,
        title: heading.text,
        level: heading.level,
        ordinal: s,
        body: lines
          .slice(heading.line + 1, sectionEnd + 1)
          .join('\n')
          .trim(),
        pageStart: pageAt[heading.line] ?? null,
        pageEnd: pageEndOf(heading.line, sectionEnd),
      });
    }
  }

  if (chapters.length !== EXPECTED_CHAPTER_COUNT) {
    issues.push({
      kind: 'chapter-count',
      detail: `Erwartet werden ${EXPECTED_CHAPTER_COUNT} Kapitel, gefunden wurden ${chapters.length}.`,
    });
  }
  const distinctParts = new Set(chapters.map((chapter) => chapter.partNumber));
  if (distinctParts.size !== EXPECTED_PART_COUNT) {
    issues.push({
      kind: 'part-count',
      detail: `Erwartet werden ${EXPECTED_PART_COUNT} Teile, gefunden wurden ${distinctParts.size}.`,
    });
  }

  const firstChapterLine = anchors.length > 0 ? (anchors[0] as { start: number }).start : Infinity;
  const assets = parseAssets(lines, pageAt, sectionAnchors, firstChapterLine, issues);

  return { parts, chapters, sections, assets, issues };
}

/** Überschrift einer Sektion mit ihrer Zeilennummer. */
interface SectionAnchor {
  readonly key: string;
  readonly chapterNumber: number;
  readonly line: number;
}

/** Bildbezüge samt Unterschrift, Sektion und Klassifikation einsammeln. */
function parseAssets(
  lines: readonly string[],
  pageAt: readonly (number | null)[],
  sectionAnchors: readonly SectionAnchor[],
  firstChapterLine: number,
  issues: ParseIssue[],
): ParsedAsset[] {
  const assets: ParsedAsset[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const image = IMAGE.exec(lines[i] as string);
    if (!image) continue;

    const relativePath = (image[2] as string).trim();
    const fileName = relativePath.split('/').pop() ?? relativePath;

    // Unterschrift: kursive Zeilen direkt nach dem Bild. Leerzeilen und
    // Seitenmarker dazwischen werden übersprungen - die Quelle setzt den
    // Seitenumbruch gelegentlich zwischen Bild und Unterschrift.
    let j = i + 1;
    while (
      j < lines.length &&
      ((lines[j] as string).trim() === '' || PAGE_MARKER.test((lines[j] as string).trim()))
    ) {
      j++;
    }
    const captionLines: string[] = [];
    while (j < lines.length && isCaptionLine(lines[j] as string)) {
      captionLines.push((lines[j] as string).trim());
      j++;
    }
    const caption = captionLines.length > 0 ? parseCaption(captionLines) : null;

    const classification = classifyAsset({
      caption,
      textBefore: previousParagraph(lines, i),
      textAfter: nextParagraph(lines, j),
      isFrontMatter: i < firstChapterLine,
    });

    // Die Sektionen liegen in Quellreihenfolge vor; das Bild gehoert zur
    // letzten Sektion, deren Ueberschrift davor steht.
    let owner: SectionAnchor | undefined;
    for (const candidate of sectionAnchors) {
      if (candidate.line >= i) break;
      owner = candidate;
    }
    const duplicate = seen.get(relativePath) ?? 0;
    seen.set(relativePath, duplicate + 1);
    if (duplicate > 0) {
      issues.push({
        kind: 'asset-referenced-twice',
        detail: `${relativePath} wird im Markdown mehrfach referenziert (${duplicate + 1}x); gespeichert wird die erste Fundstelle.`,
      });
      continue;
    }

    const fromName = parseImageFileName(fileName);
    assets.push({
      relativePath,
      fileName,
      sectionKey: i < firstChapterLine ? null : (owner?.key ?? null),
      chapterNumber: i < firstChapterLine ? null : (owner?.chapterNumber ?? null),
      page: fromName?.page ?? pageAt[i] ?? null,
      indexOnPage: fromName?.indexOnPage ?? null,
      caption,
      assetType: classification.type,
      confidence: classification.confidence,
      rule: classification.rule,
      ordinal: assets.length,
    });
  }

  return assets;
}

/** Letzte Textzeile vor `index` (ohne Leerzeilen, Seitenmarker, Bilder). */
function previousParagraph(lines: readonly string[], index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    const trimmed = (lines[i] as string).trim();
    if (trimmed === '' || PAGE_MARKER.test(trimmed) || IMAGE.test(trimmed)) continue;
    // Eine Überschrift beendet den Absatz - danach gibt es keinen Vorlauf mehr.
    if (HEADING.test(trimmed)) return '';
    return trimmed.replace(/[*\s]+$/, '');
  }
  return '';
}

/** Erste Textzeile ab `index` (ohne Leerzeilen, Seitenmarker, Bilder). */
function nextParagraph(lines: readonly string[], index: number): string {
  for (let i = index; i < lines.length; i++) {
    const trimmed = (lines[i] as string).trim();
    if (trimmed === '' || PAGE_MARKER.test(trimmed) || IMAGE.test(trimmed)) continue;
    return trimmed.replace(/^[*\s]+/, '');
  }
  return '';
}
