import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { BASE_CONFIG_ENTRIES, countSeedRows, seedDatabase } from '../../src/db/seed.js';
import { TEST_DATABASE_URL } from './setup.js';

describe('Seed', () => {
  let handle: DbHandle;

  beforeAll(() => {
    handle = createDb(TEST_DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('legt die Basis-Konfigurationseintraege an und ist idempotent', async () => {
    await seedDatabase(handle.db);
    const afterFirst = await countSeedRows(handle.db);

    await seedDatabase(handle.db);
    const afterSecond = await countSeedRows(handle.db);

    // Der zweite Lauf darf weder Duplikate erzeugen noch fehlschlagen.
    expect(afterSecond.config).toBe(afterFirst.config);
    expect(afterSecond.user).toBe(afterFirst.user);
    expect(afterFirst.config).toBeGreaterThanOrEqual(BASE_CONFIG_ENTRIES.length);
  });

  it('legt ohne gesetzte Umgebungsvariablen keinen Benutzer an', async () => {
    delete process.env['SEED_USER_USERNAME'];
    delete process.env['SEED_USER_PASSWORD_HASH'];

    const result = await seedDatabase(handle.db);

    expect(result.userCreated).toBe(false);
    expect(result.userSkippedReason).toContain('SEED_USER_USERNAME');
  });

  it('legt einen Benutzer nur beim ersten Lauf an, wenn die Variablen gesetzt sind', async () => {
    process.env['SEED_USER_USERNAME'] = 'seed-test-user';
    // Kein echtes Passwort - Hashing ist AP1.T1.3, hier zaehlt nur der Ablauf.
    process.env['SEED_USER_PASSWORD_HASH'] = '$argon2id$platzhalter';

    try {
      const first = await seedDatabase(handle.db);
      const second = await seedDatabase(handle.db);
      const counts = await countSeedRows(handle.db);

      expect(first.userCreated).toBe(true);
      expect(second.userCreated).toBe(false);
      expect(second.userSkippedReason).toContain('existiert bereits');
      expect(counts.user).toBe(1);
    } finally {
      delete process.env['SEED_USER_USERNAME'];
      delete process.env['SEED_USER_PASSWORD_HASH'];
    }
  });
});
