import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { user } from '../../src/db/schema.js';
import {
  AssetPathError,
  isAssetProblem,
  loadAssetFile,
  mediaTypeOf,
  safeAssetPath,
} from '../../src/content/assets.js';
import { createTestContext, createTestUser, login } from '../auth/helpers.js';
import type { TestContext } from '../auth/helpers.js';
import { MINI_BOOK } from '../book/fixtures.js';
import { clearAll, seedContent, setAssetPath } from './helpers.js';
import type { SeededContent } from './helpers.js';

/**
 * Asset-Serving der Content-API (AP3.T3.5, Subtask 6).
 *
 * Buchbilder sind urheberrechtlich geschuetzt. Zwei Dinge muessen deshalb
 * stimmen: Es kommt niemand ohne Session heran, und niemand kommt an etwas
 * ausserhalb des Bildverzeichnisses heran.
 */

const USERNAME = 'content-asset-user';
const PASSWORD = 'content-asset-passwort-lang';

let context: TestContext;
let cookieHeader: string;
let seeded: SeededContent;

beforeAll(async () => {
  context = await createTestContext(undefined, { bookSourceDir: MINI_BOOK });
  await createTestUser(context, USERNAME, PASSWORD);
  cookieHeader = (await login(context.app, USERNAME, PASSWORD)).cookieHeader;
});

afterAll(async () => {
  await context.handle.db.delete(user).where(eq(user.username, USERNAME));
  await context.close();
});

beforeEach(async () => {
  await clearAll(context.handle.db);
  seeded = await seedContent(context.handle.db);
});

function imageUrl(file = 'p0003_01.jpeg'): string {
  return `/api/content/assets/${seeded.assetIds[file]}/image`;
}

async function get(path: string, headers: Record<string, string> = {}) {
  return context.app.inject({
    method: 'GET',
    url: path,
    headers: { cookie: cookieHeader, ...headers },
  });
}

describe('Pfad-Sicherheit', () => {
  it('weist jeden Pfad ab, der das Bildverzeichnis verlaesst', async () => {
    const boese = [
      '../../etc/passwd',
      'bilder/../../etc/passwd',
      '/etc/passwd',
      'bilder/../../../root/.ssh/id_rsa',
      'C:\\Windows\\system32\\config\\sam',
      'bilder/gut.jpeg\0/etc/passwd',
    ];
    for (const path of boese) {
      expect(() => safeAssetPath('/srv/buch', path), path).toThrowError(AssetPathError);
    }
  });

  it('laesst einen Pfad, der nur mit dem Wurzelnamen anfaengt, nicht durch', () => {
    // "/srv/buch-geheim" faengt mit "/srv/buch" an, liegt aber nicht darin.
    expect(() => safeAssetPath('/srv/buch', '../buch-geheim/datei.jpeg')).toThrowError(
      AssetPathError,
    );
  });

  it('laesst gewoehnliche Pfade innerhalb des Verzeichnisses durch', () => {
    expect(safeAssetPath('/srv/buch', 'bilder/p0003_01.jpeg')).toBe(
      '/srv/buch/bilder/p0003_01.jpeg',
    );
    expect(safeAssetPath('/srv/buch', './bilder/p0003_01.jpeg')).toBe(
      '/srv/buch/bilder/p0003_01.jpeg',
    );
  });

  it('liefert ueber die Route nichts aus, wenn der hinterlegte Pfad ausbricht', async () => {
    // Selbst wenn ein manipulierter Pfad in der Datenbank steht: Die Route
    // prueft ihn noch einmal.
    await setAssetPath(
      context.handle.db,
      seeded.assetIds['p0003_01.jpeg'] as string,
      '../../etc/passwd',
    );
    const response = await get(imageUrl());
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
    expect(response.body).not.toContain('root:');
  });

  it('liefert kein Bild fuer eine Datei mit unbekannter Endung', async () => {
    await setAssetPath(context.handle.db, seeded.assetIds['p0003_01.jpeg'] as string, 'book.md');
    const response = await get(imageUrl());
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('CONTENTS');
  });

  it('erkennt Medientypen nur an bekannten Endungen', () => {
    expect(mediaTypeOf('bilder/x.jpeg')).toBe('image/jpeg');
    expect(mediaTypeOf('bilder/x.PNG')).toBe('image/png');
    expect(mediaTypeOf('bilder/x.md')).toBeUndefined();
    expect(mediaTypeOf('ohnepunkt')).toBeUndefined();
  });
});

describe('Auslieferung und Caching', () => {
  it('liefert das Bild mit Caching-Headern und ETag', async () => {
    const response = await get(imageUrl());
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(response.headers['etag']).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.headers['last-modified']).toBeTruthy();
    // Ein Zwischenspeicher darf die Antwort nicht ueber Sessions hinweg teilen.
    expect(response.headers['vary']).toBe('Cookie');
    expect(response.rawPayload.byteLength).toBeGreaterThan(0);
  });

  it('beantwortet einen bedingten Abruf mit 304 und ohne Nutzlast', async () => {
    const first = await get(imageUrl());
    const etag = first.headers['etag'] as string;

    const second = await get(imageUrl(), { 'if-none-match': etag });
    expect(second.statusCode).toBe(304);
    expect(second.rawPayload.byteLength).toBe(0);
    expect(second.headers['etag']).toBe(etag);
    expect(second.headers['cache-control']).toBe('private, max-age=31536000, immutable');
  });

  it('erkennt den ETag auch in einer Liste', async () => {
    const etag = (await get(imageUrl())).headers['etag'] as string;
    const response = await get(imageUrl(), { 'if-none-match': `"fremd", ${etag}` });
    expect(response.statusCode).toBe(304);
  });

  it('liefert bei einem anderen ETag die volle Antwort', async () => {
    const response = await get(imageUrl(), { 'if-none-match': '"veraltet"' });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.byteLength).toBeGreaterThan(0);
  });

  it('bildet den ETag aus dem Inhalt, nicht aus Pfad oder Zeitstempel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gto-etag-'));
    try {
      writeFileSync(join(dir, 'a.jpeg'), 'inhalt eins');
      writeFileSync(join(dir, 'b.jpeg'), 'inhalt zwei');
      // Zwei Dateien mit demselben Inhalt - ein Inhalts-ETag ist derselbe.
      writeFileSync(join(dir, 'c.jpeg'), 'inhalt eins');

      const etag = (path: string): string => {
        const loaded = loadAssetFile(dir, path);
        if (isAssetProblem(loaded)) throw new Error(`unerwartet: ${loaded.kind}`);
        return loaded.etag;
      };

      expect(etag('a.jpeg')).not.toBe(etag('b.jpeg'));
      expect(etag('a.jpeg')).toBe(etag('c.jpeg'));

      // Aendert sich der Inhalt, aendert sich der ETag.
      const vorher = etag('a.jpeg');
      writeFileSync(join(dir, 'a.jpeg'), 'inhalt drei');
      expect(etag('a.jpeg')).not.toBe(vorher);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('meldet ein unbekanntes Asset als not_found', async () => {
    const response = await get('/api/content/assets/11111111-1111-1111-1111-111111111111/image');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_found' });
  });

  it('behandelt eine erfundene Asset-Kennung als not_found, nicht als Serverfehler', async () => {
    // Ein Pfad statt einer UUID: Postgres wuerde bei der Abfrage werfen, und
    // das kaeme als 500 heraus. Eine erfundene Kennung ist aber kein Fehler
    // des Servers, sondern schlicht nichts.
    for (const id of ['..%2F..%2Fetc%2Fpasswd', 'nicht-existent', '12345']) {
      const response = await get(`/api/content/assets/${id}/image`);
      expect(response.statusCode, id).toBe(404);
      expect(response.json(), id).toMatchObject({ error: 'not_found' });
    }
  });

  it('erklaert eine fehlende Bilddatei mit dem wahrscheinlichen Grund', async () => {
    await setAssetPath(
      context.handle.db,
      seeded.assetIds['p0003_01.jpeg'] as string,
      'bilder/gibtsnicht.jpeg',
    );
    const response = await get(imageUrl());
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('BOOK_SOURCE_DIR');
  });

  it('gibt ohne Session weder Bild noch ETag heraus', async () => {
    const response = await context.app.inject({ method: 'GET', url: imageUrl() });
    expect(response.statusCode).toBe(401);
    expect(response.headers['etag']).toBeUndefined();
  });
});
