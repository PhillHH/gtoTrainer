import { readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { findRepoRoot } from '../config/env.js';

/**
 * Vorbedingungsprüfung für die Buchquellen (AP3.T3.1, Subtask 1).
 *
 * `data/book-source/` ist git-ignorierter Pflicht-Input des Nutzers. Fehlt er,
 * bricht der Import **vor jeder Verarbeitung** ab - keine Teilverarbeitung,
 * kein leerer Import. Die Meldung benennt, was fehlt und wohin es gehört.
 *
 * Die Struktur wird **tolerant** erkannt: Die Bilder dürfen flach im
 * Verzeichnis liegen oder in genau einem Unterverzeichnis (so liefert es der
 * verwendete PDF-nach-Markdown-Export). Welche Form vorliegt, steht im
 * Import-Report.
 */

/** Fehler bei fehlenden oder unbrauchbaren Buchquellen. */
export class BookSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookSourceError';
  }
}

/** Verzeichnisname der Buchquellen, relativ zur Repo-Wurzel. */
export const BOOK_SOURCE_DIR = 'data/book-source';

/**
 * Absoluter Pfad der Buchquellen, wenn er nicht aus der Repo-Wurzel folgt.
 *
 * Im Container gibt es keine Repo-Wurzel; die Buchbilder werden dort
 * read-only unter `/app/data/book-source` eingehaengt (siehe
 * docker-compose.yml). Ohne diese Variable koennte der Job-Worker die
 * Chart-Bilder aus T3.3 nicht lesen.
 */
export function configuredBookSourceDir(): string | undefined {
  const raw = process.env['BOOK_SOURCE_DIR'];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

/** Dateiendungen, die als Buchbild gelten. */
const IMAGE_EXTENSIONS = ['.jpeg', '.jpg', '.png'] as const;

/** Wo die Bilder tatsächlich liegen. */
export type BookImageLayout = 'flat' | 'subdirectory';

export interface BookSource {
  /** Absoluter Pfad des Quellverzeichnisses. */
  readonly rootDir: string;
  /** Absoluter Pfad der Buch-Markdown-Datei. */
  readonly markdownPath: string;
  /** Dateiname der Buch-Markdown-Datei. */
  readonly markdownFile: string;
  /** Absoluter Pfad des Verzeichnisses mit den Bildern. */
  readonly imageDir: string;
  /** Bildverzeichnis relativ zu {@link rootDir} (`.` bei flacher Ablage). */
  readonly imageDirRelative: string;
  /** Erkannte Ablageform. */
  readonly layout: BookImageLayout;
  /** Dateinamen aller gefundenen Bilder, sortiert. */
  readonly imageFiles: readonly string[];
}

function isImage(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function hint(rootDir: string): string {
  return (
    `Erwartet werden dort die Buch-Markdown-Datei (*.md) und sämtliche ` +
    `Bilddateien (pXXXX_YY.jpeg), siehe ${join(rootDir, 'README.md')}. ` +
    `Die Buchquellen sind git-ignorierter Pflicht-Input und werden vom Nutzer ` +
    `abgelegt (docs/ap/AP03.md, Abschnitt "Umgebung").`
  );
}

/**
 * Prüft die Buchquellen und liefert die erkannte Struktur.
 * Wirft {@link BookSourceError}, sobald etwas fehlt.
 */
export function resolveBookSource(sourceDir?: string): BookSource {
  const configured = configuredBookSourceDir();
  const rootDir = sourceDir
    ? resolve(sourceDir)
    : configured
      ? resolve(configured)
      : resolve(findRepoRoot(), ...BOOK_SOURCE_DIR.split('/'));

  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    throw new BookSourceError(
      `Buchquellen-Verzeichnis fehlt: ${rootDir} existiert nicht. ${hint(rootDir)}`,
    );
  }

  // Die versionierte README zählt nicht als Inhalt - sonst gälte ein frisch
  // ausgechecktes Repo als befülltes Quellverzeichnis.
  const payload = entries.filter((entry) => entry !== 'README.md' && !entry.startsWith('.'));
  if (payload.length === 0) {
    throw new BookSourceError(
      `Buchquellen-Verzeichnis ist leer: ${rootDir} enthält außer der README nichts. ${hint(rootDir)}`,
    );
  }

  const markdownFiles = payload.filter(
    (entry) => entry.toLowerCase().endsWith('.md') && isFile(rootDir, entry),
  );
  if (markdownFiles.length === 0) {
    throw new BookSourceError(
      `Buch-Markdown fehlt: in ${rootDir} liegt keine *.md-Datei (außer der README). ${hint(rootDir)}`,
    );
  }
  if (markdownFiles.length > 1) {
    throw new BookSourceError(
      `Mehrdeutige Buchquelle: in ${rootDir} liegen ${markdownFiles.length} Markdown-Dateien ` +
        `(${markdownFiles.join(', ')}). Erwartet wird genau eine Buch-Markdown-Datei.`,
    );
  }
  const markdownFile = markdownFiles[0] as string;

  const flatImages = payload.filter((entry) => isImage(entry) && isFile(rootDir, entry)).sort();
  if (flatImages.length > 0) {
    return {
      rootDir,
      markdownPath: join(rootDir, markdownFile),
      markdownFile,
      imageDir: rootDir,
      imageDirRelative: '.',
      layout: 'flat',
      imageFiles: flatImages,
    };
  }

  // Kein Bild flach im Verzeichnis - dann muss genau ein Unterverzeichnis die
  // Bilder tragen. Mehrere Kandidaten wären eine Struktur, auf die sich der
  // Parser nicht festlegen darf.
  const candidates = payload
    .filter((entry) => !isFile(rootDir, entry))
    .map((entry) => ({
      name: entry,
      files: readdirSync(join(rootDir, entry))
        .filter((file) => isImage(file) && isFile(join(rootDir, entry), file))
        .sort(),
    }))
    .filter((candidate) => candidate.files.length > 0);

  if (candidates.length === 0) {
    throw new BookSourceError(
      `Bilddateien fehlen: weder in ${rootDir} noch in einem Unterverzeichnis liegen ` +
        `Bilder (${IMAGE_EXTENSIONS.join(', ')}). ${hint(rootDir)}`,
    );
  }
  if (candidates.length > 1) {
    throw new BookSourceError(
      `Mehrdeutige Bildablage: ${candidates.length} Unterverzeichnisse in ${rootDir} enthalten ` +
        `Bilder (${candidates.map((candidate) => candidate.name).join(', ')}). ` +
        `Erwartet wird genau ein Bildverzeichnis oder flache Ablage.`,
    );
  }

  const chosen = candidates[0] as { name: string; files: string[] };
  const imageDir = join(rootDir, chosen.name);
  return {
    rootDir,
    markdownPath: join(rootDir, markdownFile),
    markdownFile,
    imageDir,
    imageDirRelative: relative(rootDir, imageDir),
    layout: 'subdirectory',
    imageFiles: chosen.files,
  };
}

function isFile(dir: string, entry: string): boolean {
  try {
    return statSync(join(dir, entry)).isFile();
  } catch {
    return false;
  }
}

/** Seitenzahl und Zähler aus einem Dateinamen `pXXXX_YY.jpeg`. */
export function parseImageFileName(
  fileName: string,
): { page: number; indexOnPage: number } | undefined {
  const match = /^p(\d{4})_(\d{2})\.(?:jpeg|jpg|png)$/i.exec(basename(fileName));
  if (!match) return undefined;
  return { page: Number(match[1]), indexOnPage: Number(match[2]) };
}
