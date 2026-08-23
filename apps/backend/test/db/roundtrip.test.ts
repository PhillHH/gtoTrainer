import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { config, jobQueue } from '../../src/db/schema.js';
import { TEST_DATABASE_URL } from './setup.js';

describe('Insert/Select-Roundtrip', () => {
  let handle: DbHandle;

  beforeAll(() => {
    handle = createDb(TEST_DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('speichert und liest ein verschachteltes JSONB-Objekt in config', async () => {
    const key = 'test.roundtrip.config';
    const value = { provider: 'anthropic', nested: { retries: 3, tags: ['a', 'b'] }, on: true };

    await handle.db.insert(config).values({ key, value });
    const rows = await handle.db.select().from(config).where(eq(config.key, key));

    expect(rows).toHaveLength(1);
    // JSONB kommt als geparstes Objekt zurueck, nicht als String.
    expect(rows[0]?.value).toEqual(value);
    expect(rows[0]?.updatedAt).toBeInstanceOf(Date);

    await handle.db.delete(config).where(eq(config.key, key));
  });

  it('setzt in job_queue die Defaults korrekt', async () => {
    const inserted = await handle.db
      .insert(jobQueue)
      .values({ jobType: 'test.roundtrip.job' })
      .returning();

    const row = inserted[0];
    expect(row).toBeDefined();
    expect(row?.status).toBe('queued');
    expect(row?.attempts).toBe(0);
    expect(row?.maxAttempts).toBe(3);
    expect(row?.payload).toEqual({});
    expect(row?.claimedAt).toBeNull();
    expect(row?.finishedAt).toBeNull();
    expect(row?.availableAt).toBeInstanceOf(Date);
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);

    // Wieder auslesen - der Roundtrip muss dieselben Werte liefern.
    const read = await handle.db.select().from(jobQueue).where(eq(jobQueue.id, row!.id));
    expect(read[0]?.jobType).toBe('test.roundtrip.job');
    expect(read[0]?.payload).toEqual({});

    await handle.db.delete(jobQueue).where(eq(jobQueue.id, row!.id));
  });

  it('weist einen unzulaessigen job_queue-Status durch den CHECK-Constraint ab', async () => {
    // Rohes SQL, weil der Drizzle-Typ den ungueltigen Wert gar nicht zuliesse -
    // geprueft werden soll die Datenbank-Constraint selbst.
    await expect(
      handle.pool.query(`insert into job_queue (job_type, status) values ($1, $2)`, [
        'test.roundtrip.invalid',
        'voellig-unbekannt',
      ]),
    ).rejects.toThrow(/job_queue_status_check/);
  });
});
