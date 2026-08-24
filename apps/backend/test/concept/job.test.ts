import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { concept, conceptPrerequisite, llmCallLog } from '../../src/db/schema.js';
import {
  CONCEPT_EXTRACT_JOB,
  readSuggestions,
  targetConceptCount,
} from '../../src/jobs/handlers/concept-extract.js';
import { enqueueJob, findJob } from '../../src/jobs/queue.js';
import { TEST_DATABASE_URL, prepareTestDatabase } from '../db/setup.js';
import { clearAll, createConceptRuntime, seedBook, suggestionsResponse } from './helpers.js';

/**
 * Durchlauf des Extraktions-Jobs gegen einen **gemockten** Provider. Kein Test
 * setzt einen echten KI-Aufruf ab; Queue, Protokoll und Datenbank sind echt.
 */

let handle: DbHandle;

beforeAll(async () => {
  await prepareTestDatabase();
  handle = createDb(TEST_DATABASE_URL, { max: 2 });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await clearAll(handle.db);
});

const ANTWORT = suggestionsResponse([
  {
    titel: 'Pot Odds',
    kurzdefinition: 'Verhaeltnis von Einsatz zu moeglichem Gewinn, an dem sich ein Call misst.',
    themenbereich: 'grundlagen-mathematik',
    ab_level: 'einsteiger',
    voraussetzungen: [],
    sektionen: ['ch01/grundbegriffe'],
  },
  {
    titel: 'Erwartungswert',
    kurzdefinition: 'Durchschnittlicher Ertrag einer Entscheidung ueber viele Wiederholungen.',
    themenbereich: 'grundlagen-mathematik',
    ab_level: 'einsteiger',
    voraussetzungen: ['Pot Odds'],
    sektionen: ['ch01/kennzahlen'],
  },
]);

describe('Job "concept.extract"', () => {
  it('persistiert die Vorschlaege als draft und protokolliert den Aufruf', async () => {
    await seedBook(handle.db);
    const runtime = createConceptRuntime(handle.db, ANTWORT);

    const job = await enqueueJob(handle.db, {
      jobType: CONCEPT_EXTRACT_JOB,
      payload: { chapterNumber: 1, part: 1 },
    });

    const outcome = await runtime.worker.runOnce();
    expect(outcome).toMatchObject({ jobId: job.id, status: 'done' });
    expect((await findJob(handle.db, job.id))?.status).toBe('done');

    const rows = await handle.db.select().from(concept);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === 'draft')).toBe(true);
    expect(rows.every((row) => row.origin === 'ai')).toBe(true);

    // Voraussetzung innerhalb desselben Laufs aufgeloest.
    expect(await handle.db.select().from(conceptPrerequisite)).toHaveLength(1);

    // Der Aufruf lief ueber die Provider-Registry - deshalb steht er im Protokoll.
    const calls = await handle.db.select().from(llmCallLog);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'api', status: 'success' });
  });

  it('uebergibt Sektionsschluessel und bekannte Konzepte an den Prompt', async () => {
    await seedBook(handle.db);
    const runtime = createConceptRuntime(handle.db, ANTWORT);
    await enqueueJob(handle.db, {
      jobType: CONCEPT_EXTRACT_JOB,
      payload: { chapterNumber: 1, part: 1 },
    });
    await runtime.worker.runOnce();

    const prompt = runtime.provider.calls[0]?.messages[0]?.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(prompt).toContain('[sektion: ch01/grundbegriffe]');
    expect(prompt).toContain('(noch keine)');
  });

  it('kennt beim zweiten Kapitel die Konzepte des ersten', async () => {
    await seedBook(handle.db);
    const runtime = createConceptRuntime(handle.db, ANTWORT);

    await enqueueJob(handle.db, {
      jobType: CONCEPT_EXTRACT_JOB,
      payload: { chapterNumber: 1, part: 1 },
    });
    await runtime.worker.runOnce();

    await enqueueJob(handle.db, {
      jobType: CONCEPT_EXTRACT_JOB,
      payload: { chapterNumber: 2, part: 1 },
    });
    await runtime.worker.runOnce();

    const prompt = runtime.provider.calls[1]?.messages[0]?.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(prompt).toContain('- Pot Odds (Kapitel 1)');

    // Dieselben Vorschlaege ein zweites Mal: Dubletten, keine neuen Zeilen.
    expect(await handle.db.select().from(concept)).toHaveLength(2);
  });

  it('landet bei unbrauchbarer Nutzlast sofort im Dead-Letter', async () => {
    await seedBook(handle.db);
    const runtime = createConceptRuntime(handle.db, ANTWORT);
    const job = await enqueueJob(handle.db, {
      jobType: CONCEPT_EXTRACT_JOB,
      payload: { chapterNumber: 'eins' },
    });

    const outcome = await runtime.worker.runOnce();
    expect(outcome?.status).toBe('dead');
    expect((await findJob(handle.db, job.id))?.status).toBe('dead');
    // Kein Aufruf abgesetzt.
    expect(runtime.provider.calls).toHaveLength(0);
  });

  it('meldet ein fehlendes Kapitel, statt es stillschweigend zu ueberspringen', async () => {
    const runtime = createConceptRuntime(handle.db, ANTWORT);
    await enqueueJob(handle.db, {
      jobType: CONCEPT_EXTRACT_JOB,
      payload: { chapterNumber: 99, part: 1 },
    });

    const outcome = await runtime.worker.runOnce();
    expect(outcome?.status).toBe('dead');
    expect(outcome?.error).toContain('Kapitel 99');
  });

  it('verwirft eine Antwort ohne Konzeptliste', async () => {
    await seedBook(handle.db);
    const runtime = createConceptRuntime(handle.db, { irgendwas: true });
    await enqueueJob(handle.db, {
      jobType: CONCEPT_EXTRACT_JOB,
      payload: { chapterNumber: 1, part: 1 },
    });

    const outcome = await runtime.worker.runOnce();
    expect(outcome?.status).toBe('dead');
    expect(await count()).toBe(0);
  });
});

describe('Obergrenze je Teillauf', () => {
  it('kappt mehr Vorschlaege, als die Obergrenze zulaesst', async () => {
    await seedBook(handle.db);
    // Die Fixture-Sektionen sind winzig -> Obergrenze ist das Minimum (3).
    const vieleVorschlaege = suggestionsResponse(
      Array.from({ length: 7 }, (_, index) => ({
        titel: `Begriff ${index + 1}`,
        kurzdefinition: 'Eine ausreichend lange Kurzdefinition fuer den Test.',
        themenbereich: 'grundlagen-mathematik',
        ab_level: 'einsteiger',
        voraussetzungen: [],
        sektionen: ['ch01/grundbegriffe'],
      })),
    );
    const runtime = createConceptRuntime(handle.db, vieleVorschlaege);
    await enqueueJob(handle.db, {
      jobType: CONCEPT_EXTRACT_JOB,
      payload: { chapterNumber: 1, part: 1 },
    });
    await runtime.worker.runOnce();

    const rows = await handle.db.select().from(concept);
    expect(rows).toHaveLength(3);
    // Gekappt wird am Ende der Liste - der Prompt laesst nach Wichtigkeit sortieren.
    expect(rows.map((row) => row.title).sort()).toEqual(['Begriff 1', 'Begriff 2', 'Begriff 3']);
  });
});

describe('Hilfsfunktionen des Jobs', () => {
  it('leitet die Zielanzahl aus dem Textumfang ab', () => {
    expect(targetConceptCount(0)).toBe(3);
    expect(targetConceptCount(15_000)).toBe(4);
    expect(targetConceptCount(1_000_000)).toBe(8);
  });

  it('liest die Konzeptliste auch aus reinem Text', () => {
    expect(readSuggestions('{"konzepte":[{"titel":"X"}]}')).toHaveLength(1);
  });

  it('wirft bei fehlender Konzeptliste', () => {
    expect(() => readSuggestions({ falsch: [] })).toThrowError(/konzepte/);
  });
});

async function count(): Promise<number> {
  const [row] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(concept);
  return row?.n ?? 0;
}
