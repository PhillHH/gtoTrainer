import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { bookAsset } from '../db/schema.js';
import { resolveBookSource } from '../book/source.js';
import { isUuid } from './book-queries.js';

/**
 * Asset-Serving der Content-API (AP3.T3.5, Subtask 6).
 *
 * Buchinhalt ist urheberrechtlich geschützt und bleibt auf dem privaten
 * Server. Zwei Konsequenzen prägen diese Datei:
 *
 * - **Der Weg führt durch das Backend**, nicht am Host-Nginx vorbei. Nur das
 *   Backend kennt die Session (ADR-0035).
 * - **Kein Pfad kommt vom Aufrufer.** Angefragt wird eine Asset-ID; der Pfad
 *   stammt aus der Datenbank. Trotzdem prüft `safeAssetPath()` das Ergebnis
 *   gegen das Wurzelverzeichnis — ein Pfad aus der Datenbank ist kein Beweis,
 *   sondern nur eine wahrscheinlichere Herkunft.
 */

export class AssetPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetPathError';
  }
}

/**
 * Setzt einen relativen Pfad auf das Wurzelverzeichnis auf und stellt sicher,
 * dass das Ergebnis **innerhalb** davon bleibt.
 *
 * Abgewiesen wird alles, was ausbricht: `../`, absolute Pfade, Null-Bytes und
 * Windows-Laufwerksbuchstaben. Geprüft wird nicht die Zeichenkette, sondern
 * der **aufgelöste** Pfad — `bilder/../../etc/passwd` sieht harmlos aus und
 * ist es nicht.
 */
export function safeAssetPath(rootDir: string, relativePath: string): string {
  if (relativePath.includes('\0')) {
    throw new AssetPathError('Pfad enthält ein Null-Byte.');
  }
  if (isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    throw new AssetPathError('Absolute Pfade sind nicht erlaubt.');
  }

  const root = resolve(rootDir);
  const target = resolve(join(root, relativePath));
  const inside = relative(root, target);

  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new AssetPathError(`Pfad verlässt das Bildverzeichnis: ${relativePath}`);
  }
  // Auch der letzte Segmentvergleich muss sauber sein - `rootDirEvil/` faengt
  // mit `rootDir` an, liegt aber nicht darin.
  if (!target.startsWith(root + sep)) {
    throw new AssetPathError(`Pfad verlässt das Bildverzeichnis: ${relativePath}`);
  }
  return target;
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Medientyp aus der Endung. Unbekannte Endungen werden nicht ausgeliefert. */
export function mediaTypeOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  return MEDIA_TYPES[path.slice(dot).toLowerCase()];
}

export interface LoadedAsset {
  readonly data: Buffer;
  readonly mediaType: string;
  /** Starker ETag aus dem Inhalt — nicht aus Zeitstempel und Größe. */
  readonly etag: string;
  readonly lastModified: string;
  readonly bytes: number;
}

export type AssetProblem =
  | { readonly kind: 'unknown-asset' }
  | { readonly kind: 'unsupported-type'; readonly path: string }
  | { readonly kind: 'unsafe-path'; readonly detail: string }
  | { readonly kind: 'file-missing'; readonly path: string };

/**
 * Lädt ein Bild über seine Asset-ID.
 *
 * Der ETag kommt aus dem **Dateiinhalt**. Buchbilder ändern sich nie, aber ein
 * Inhalts-Hash bleibt auch dann richtig, wenn eine Datei neu kopiert wird und
 * dabei einen neuen Zeitstempel bekommt.
 */
export function loadAssetFile(rootDir: string, relativePath: string): LoadedAsset | AssetProblem {
  const mediaType = mediaTypeOf(relativePath);
  if (mediaType === undefined) {
    return { kind: 'unsupported-type', path: relativePath };
  }

  let absolute: string;
  try {
    absolute = safeAssetPath(rootDir, relativePath);
  } catch (error) {
    return { kind: 'unsafe-path', detail: (error as Error).message };
  }

  try {
    const data = readFileSync(absolute);
    const stat = statSync(absolute);
    return {
      data,
      mediaType,
      etag: `"${createHash('sha256').update(data).digest('hex').slice(0, 32)}"`,
      lastModified: stat.mtime.toUTCString(),
      bytes: data.byteLength,
    };
  } catch {
    return { kind: 'file-missing', path: relativePath };
  }
}

/** Schlägt den Pfad eines Assets nach und lädt die Datei. */
export async function loadAsset(
  db: Database,
  assetId: string,
  sourceDir?: string,
): Promise<LoadedAsset | AssetProblem> {
  // Erst die Form pruefen, dann fragen: Postgres wirft bei einer kaputten UUID
  // einen Fehler, und der wuerde als 500 herauskommen. Ein erfundener Pfad in
  // der URL ist aber kein Serverfehler, sondern schlicht nichts.
  if (!isUuid(assetId)) return { kind: 'unknown-asset' };

  const [row] = await db
    .select({ path: bookAsset.relativePath })
    .from(bookAsset)
    .where(eq(bookAsset.id, assetId));
  if (!row) return { kind: 'unknown-asset' };

  return loadAssetFile(resolveBookSource(sourceDir).rootDir, row.path);
}

/** Ist das Ergebnis ein Problem oder ein Bild? */
export function isAssetProblem(value: LoadedAsset | AssetProblem): value is AssetProblem {
  return 'kind' in value;
}

/**
 * Caching-Vorgabe für Buchbilder.
 *
 * `private`, weil die Auslieferung an eine Session gebunden ist — ein
 * gemeinsamer Zwischenspeicher dürfte das Bild nicht an den Nächsten geben.
 * `immutable` mit einem Jahr, weil ein Buchbild sich nicht ändert: Das Asset
 * ist über seine ID identifiziert, und ein anderes Bild bekäme eine andere ID.
 */
export const ASSET_CACHE_CONTROL = 'private, max-age=31536000, immutable';
