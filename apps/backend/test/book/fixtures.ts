import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Verzeichnis der Buch-Fixtures. */
export const FIXTURE_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));

/** Kleines Buch mit Bildern in einem Unterverzeichnis (wie die echte Quelle). */
export const MINI_BOOK = join(FIXTURE_DIR, 'mini-book');

/** Kleines Buch mit flach abgelegten Bildern (Ablageform laut README aus T1.1). */
export const FLAT_BOOK = join(FIXTURE_DIR, 'flat-book');

/**
 * Kopiert ein Fixture in ein temporaeres Verzeichnis, damit ein Test es
 * veraendern darf. Die Fixtures im Repo bleiben unangetastet - der Parser darf
 * Quelldateien ohnehin nie schreiben.
 */
export function copyFixture(source: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gto-book-'));
  cpSync(source, dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Legt ein leeres temporaeres Verzeichnis an. */
export function emptyDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gto-book-empty-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
