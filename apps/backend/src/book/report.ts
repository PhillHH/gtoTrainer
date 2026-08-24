import { BOOK_ASSET_TYPES } from '@gto/shared';
import type { BookAssetType } from '@gto/shared';
import type { ImportResult, UpsertCounts } from './import.js';
import type { ParsedAsset } from './parser.js';

/**
 * Import-Report (AP3.T3.1, Subtask 7).
 *
 * Grundlage der Abnahme in T3.6. Er soll **ehrlich** sein, nicht schoen:
 * Zaehlstaende je Kategorie, und daneben alles, was nicht aufgeht - fehlende
 * Bilddateien, verwaiste Bilddateien, unsichere Klassifikationen, Luecken in
 * der Nummerierung der Unterschriften und Abweichungen von der erwarteten
 * Kapitelstruktur.
 */

export interface ReportNumbering {
  readonly label: string;
  readonly count: number;
  readonly max: number;
  /** Nummern, die zwischen 1 und `max` fehlen. */
  readonly missing: readonly number[];
}

export interface ImportReport {
  readonly source: {
    readonly rootDir: string;
    readonly markdownFile: string;
    readonly imageDirRelative: string;
    readonly layout: string;
    readonly imageFileCount: number;
  };
  readonly dryRun: boolean;
  readonly parts: number;
  readonly chapters: number;
  readonly sections: number;
  readonly assets: number;
  readonly assetsByType: Readonly<Record<BookAssetType, number>>;
  /** Assets mit Unterschrift, aus der Prozentwerte gelesen wurden. */
  readonly captionsWithPercentages: number;
  /** Als `hand_range` klassifizierte Assets mit Prozentwerten. */
  readonly handRangeCaptionsWithPercentages: number;
  /** Unterschriften ohne erkennbare Struktur (kein Etikett). */
  readonly unstructuredCaptions: number;
  /** Assets ganz ohne Unterschrift. */
  readonly assetsWithoutCaption: number;
  /** Assets mit `classification_confidence = 'uncertain'`. */
  readonly uncertainClassifications: number;
  readonly byRule: Readonly<Record<string, number>>;
  readonly numbering: readonly ReportNumbering[];
  readonly missingImageFiles: readonly string[];
  readonly orphanImageFiles: readonly string[];
  readonly issues: readonly { kind: string; detail: string }[];
  readonly chapterList: readonly {
    partNumber: number;
    number: number;
    title: string;
    sections: number;
  }[];
  readonly counts: {
    readonly chapters: UpsertCounts;
    readonly sections: UpsertCounts;
    readonly assets: UpsertCounts;
  };
}

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

/** Luecken in der Nummerierung je Unterschrift-Etikett. */
function numbering(assets: readonly ParsedAsset[]): ReportNumbering[] {
  const byLabel = new Map<string, Set<number>>();
  for (const asset of assets) {
    const label = asset.caption?.label;
    const number = asset.caption?.number;
    if (!label || number === null || number === undefined) continue;
    const bucket = byLabel.get(label) ?? new Set<number>();
    bucket.add(number);
    byLabel.set(label, bucket);
  }

  return [...byLabel.entries()]
    .map(([label, numbers]) => {
      const max = Math.max(...numbers);
      const missing: number[] = [];
      for (let n = 1; n <= max; n++) if (!numbers.has(n)) missing.push(n);
      return { label, count: numbers.size, max, missing };
    })
    .sort((a, b) => b.count - a.count);
}

/** Baut den Report aus dem Importergebnis. */
export function buildReport(result: ImportResult): ImportReport {
  const { parsed, source } = result;

  const byType = countBy(parsed.assets.map((asset) => asset.assetType));
  const assetsByType = Object.fromEntries(
    BOOK_ASSET_TYPES.map((type) => [type, byType[type] ?? 0]),
  ) as Record<BookAssetType, number>;

  const withPercentages = parsed.assets.filter((asset) => (asset.caption?.actions.length ?? 0) > 0);

  return {
    source: {
      rootDir: source.rootDir,
      markdownFile: source.markdownFile,
      imageDirRelative: source.imageDirRelative,
      layout: source.layout,
      imageFileCount: source.imageFiles.length,
    },
    dryRun: result.dryRun,
    parts: new Set(parsed.chapters.map((chapter) => chapter.partNumber)).size,
    chapters: parsed.chapters.length,
    sections: parsed.sections.length,
    assets: parsed.assets.length,
    assetsByType,
    captionsWithPercentages: withPercentages.length,
    handRangeCaptionsWithPercentages: withPercentages.filter(
      (asset) => asset.assetType === 'hand_range',
    ).length,
    unstructuredCaptions: parsed.assets.filter(
      (asset) => asset.caption !== null && asset.caption.label === null,
    ).length,
    assetsWithoutCaption: parsed.assets.filter((asset) => asset.caption === null).length,
    uncertainClassifications: parsed.assets.filter((asset) => asset.confidence === 'uncertain')
      .length,
    byRule: countBy(parsed.assets.map((asset) => asset.rule)),
    numbering: numbering(parsed.assets),
    missingImageFiles: result.missingImageFiles,
    orphanImageFiles: result.orphanImageFiles,
    issues: result.issues.map((issue) => ({ kind: issue.kind, detail: issue.detail })),
    chapterList: parsed.chapters.map((chapter) => ({
      partNumber: chapter.partNumber,
      number: chapter.number,
      title: chapter.title,
      sections: parsed.sections.filter((section) => section.chapterNumber === chapter.number)
        .length,
    })),
    counts: result.counts,
  };
}

function upsertLine(label: string, counts: UpsertCounts): string {
  return (
    `| ${label} | ${counts.inserted} | ${counts.updated} | ${counts.unchanged} | ` +
    `${counts.revived} | ${counts.removed} |`
  );
}

function list(title: string, entries: readonly string[], limit = 20): string[] {
  const lines = [`### ${title} (${entries.length})`, ''];
  if (entries.length === 0) {
    lines.push('keine', '');
    return lines;
  }
  for (const entry of entries.slice(0, limit)) lines.push(`- \`${entry}\``);
  if (entries.length > limit) lines.push(`- … und ${entries.length - limit} weitere`);
  lines.push('');
  return lines;
}

/**
 * Formatiert den Report als Markdown.
 *
 * Achtung: Der Report enthaelt Kapitel- und Sektionstitel aus dem Buch. Er wird
 * deshalb nach `data/` geschrieben und ist git-ignoriert.
 */
export function formatReport(report: ImportReport, generatedAt: string): string {
  const lines: string[] = [];

  lines.push('# Buch-Import-Report (AP3.T3.1)', '');
  lines.push(`- Erzeugt: ${generatedAt}`);
  lines.push(`- Modus: ${report.dryRun ? 'Trockenlauf (nichts geschrieben)' : 'Import'}`);
  lines.push(`- Quelle: \`${report.source.rootDir}\``);
  lines.push(`- Markdown: \`${report.source.markdownFile}\``);
  lines.push(
    `- Bildablage: ${report.source.layout === 'flat' ? 'flach im Quellverzeichnis' : `Unterverzeichnis \`${report.source.imageDirRelative}\``}` +
      ` (${report.source.imageFileCount} Dateien)`,
  );
  lines.push('');

  lines.push('## 1. Zählstände', '');
  lines.push('| Größe | Anzahl |', '| --- | ---: |');
  lines.push(`| Teile | ${report.parts} |`);
  lines.push(`| Kapitel | ${report.chapters} |`);
  lines.push(`| Sektionen | ${report.sections} |`);
  lines.push(`| Assets gesamt | ${report.assets} |`);
  lines.push('');

  lines.push('### Assets je Typ', '');
  lines.push('| Typ | Anzahl |', '| --- | ---: |');
  for (const type of BOOK_ASSET_TYPES) lines.push(`| \`${type}\` | ${report.assetsByType[type]} |`);
  lines.push('');
  lines.push(
    `**Für T3.3 entscheidend:** ${report.assetsByType.hand_range} Assets sind als ` +
      '`hand_range` klassifiziert; nur diese gehen durch die Vision-Pipeline.',
    '',
  );

  lines.push('### Unterschriften', '');
  lines.push('| Größe | Anzahl |', '| --- | ---: |');
  lines.push(`| Unterschriften mit Prozentwerten | ${report.captionsWithPercentages} |`);
  lines.push(
    `| davon \`hand_range\` (Gegenprobe für T3.4) | ${report.handRangeCaptionsWithPercentages} |`,
  );
  lines.push(`| Unterschriften ohne erkennbare Struktur | ${report.unstructuredCaptions} |`);
  lines.push(`| Assets ganz ohne Unterschrift | ${report.assetsWithoutCaption} |`);
  lines.push(`| unsichere Klassifikationen | ${report.uncertainClassifications} |`);
  lines.push('');

  lines.push('### Klassifikation je Regel', '');
  lines.push('| Regel | Anzahl |', '| --- | ---: |');
  for (const [rule, count] of Object.entries(report.byRule).sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${rule}\` | ${count} |`);
  }
  lines.push('');

  lines.push('## 2. Datenbank-Wirkung', '');
  lines.push(
    '| Tabelle | neu | geändert | unverändert | reaktiviert | entfallen |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  );
  lines.push(upsertLine('book_chapter', report.counts.chapters));
  lines.push(upsertLine('book_section', report.counts.sections));
  lines.push(upsertLine('book_asset', report.counts.assets));
  lines.push('');
  lines.push(
    '„entfallen" heißt: `removed_at` gesetzt. Es wird nichts gelöscht, damit ' +
      'Chart-Daten aus T3.3/T3.4 nicht mit verschwinden.',
    '',
  );

  lines.push('## 3. Kapitelstruktur', '');
  lines.push('| Teil | Kapitel | Titel | Sektionen |', '| ---: | ---: | --- | ---: |');
  for (const chapter of report.chapterList) {
    lines.push(
      `| ${chapter.partNumber} | ${chapter.number} | ${chapter.title} | ${chapter.sections} |`,
    );
  }
  lines.push('');

  lines.push('## 4. Auffälligkeiten', '');
  lines.push(
    ...list(
      'Fehlende Bilddateien (im Markdown referenziert, Datei fehlt)',
      report.missingImageFiles,
    ),
  );
  lines.push(
    ...list(
      'Verwaiste Bilddateien (Datei vorhanden, im Markdown nicht referenziert)',
      report.orphanImageFiles,
    ),
  );

  lines.push('### Nummerierung der Unterschriften', '');
  if (report.numbering.length === 0) {
    lines.push('keine nummerierten Unterschriften erkannt', '');
  } else {
    lines.push(
      '| Etikett | erkannt | höchste Nummer | fehlende Nummern |',
      '| --- | ---: | ---: | --- |',
    );
    for (const entry of report.numbering) {
      lines.push(
        `| ${entry.label} | ${entry.count} | ${entry.max} | ${entry.missing.length === 0 ? 'keine' : entry.missing.join(', ')} |`,
      );
    }
    lines.push('');
  }

  lines.push(`### Strukturmeldungen (${report.issues.length})`, '');
  if (report.issues.length === 0) lines.push('keine', '');
  else {
    for (const issue of report.issues) lines.push(`- \`${issue.kind}\`: ${issue.detail}`);
    lines.push('');
  }

  return lines.join('\n');
}

/** Kurzfassung für die Terminalausgabe. */
export function formatSummary(report: ImportReport): string {
  const types = BOOK_ASSET_TYPES.map((type) => `${type}=${report.assetsByType[type]}`).join(' ');
  return [
    `Quelle:    ${report.source.rootDir}`,
    `Markdown:  ${report.source.markdownFile}`,
    `Bilder:    ${report.source.imageFileCount} (${report.source.layout === 'flat' ? 'flach' : report.source.imageDirRelative})`,
    `Struktur:  ${report.parts} Teile, ${report.chapters} Kapitel, ${report.sections} Sektionen`,
    `Assets:    ${report.assets} gesamt | ${types}`,
    `Captions:  ${report.captionsWithPercentages} mit Prozentwerten (davon hand_range: ${report.handRangeCaptionsWithPercentages}), ` +
      `${report.unstructuredCaptions} ohne Struktur, ${report.assetsWithoutCaption} ohne Unterschrift`,
    `Unsicher:  ${report.uncertainClassifications} Klassifikationen`,
    `Fehlend:   ${report.missingImageFiles.length} Bilddateien | verwaist: ${report.orphanImageFiles.length}`,
    `Meldungen: ${report.issues.length}`,
  ].join('\n');
}
