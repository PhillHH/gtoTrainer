import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { jobQueue, llmCallLog } from '../../src/db/schema.js';
import { claimNextJob, enqueueJob, findJob, requeueDeadJob } from '../../src/jobs/queue.js';
import { LLM_COMPLETE_JOB } from '../../src/jobs/handlers/llm-complete.js';
import { TEST_DATABASE_URL, prepareTestDatabase } from '../db/setup.js';
import {
  authError,
  clearTables,
  createTestRuntime,
  samplePayload,
  transientError,
} from './helpers.js';

/**
 * Tests des Job-Workers gegen die echte `job_queue`-Tabelle. Der Provider ist
 * eine Attrappe - kein Test setzt einen echten KI-Aufruf ab.
 */

let handle: DbHandle;

beforeAll(async () => {
  await prepareTestDatabase();
  handle = createDb(TEST_DATABASE_URL);
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await clearTables(handle.db);
});

describe('Vollstaendiger Durchlauf', () => {
  it('bringt einen Job von queued ueber running nach done und protokolliert den Aufruf', async () => {
    const runtime = createTestRuntime(handle.db);
    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
    });
    expect((await findJob(handle.db, job.id))?.status).toBe('queued');

    const outcome = await runtime.worker.runOnce();

    expect(outcome).toMatchObject({ jobId: job.id, status: 'done', attempts: 1 });
    expect((await findJob(handle.db, job.id))?.status).toBe('done');

    // Der Zustandsverlauf ist ueber die Ereignisse belegt.
    expect(runtime.received.map((event) => event.status)).toEqual(['running', 'done']);

    // Genau ein Protokolleintrag, vollstaendig gefuellt.
    const calls = await handle.db.select().from(llmCallLog);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: 'api',
      model: 'claude-sonnet-5',
      status: 'success',
      durationMs: 42,
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
    expect(calls[0]?.prompt).toContain('Du bist Lehrer');
    expect(calls[0]?.response).toBe('Antwort der Attrappe');
  });

  it('meldet "nichts zu tun", wenn die Queue leer ist', async () => {
    const runtime = createTestRuntime(handle.db);
    await expect(runtime.worker.runOnce()).resolves.toBeUndefined();
  });

  it('holt einen Job erst, wenn available_at erreicht ist', async () => {
    const runtime = createTestRuntime(handle.db);
    await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
      availableAt: new Date(Date.now() + 60_000),
    });

    await expect(runtime.worker.runOnce()).resolves.toBeUndefined();
  });
});

describe('Claim ist rennsicher', () => {
  it('gibt einen Job bei parallelen Versuchen an genau einen Worker', async () => {
    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
    });

    // Zehn gleichzeitige Versuche auf denselben einen Job.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimNextJob(handle.db, { staleAfterMs: 300_000 })),
    );

    const winners = results.filter((claimed) => claimed !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe(job.id);
    expect(winners[0]?.attempts).toBe(1);

    // Genau ein Versuch gezaehlt - kein zweiter Zugriff hat die Zeile angefasst.
    expect((await findJob(handle.db, job.id))?.attempts).toBe(1);
  });

  it('verteilt mehrere Jobs auf parallele Versuche, ohne einen doppelt zu vergeben', async () => {
    for (let index = 0; index < 3; index += 1) {
      await enqueueJob(handle.db, { jobType: LLM_COMPLETE_JOB, payload: samplePayload() });
    }

    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimNextJob(handle.db, { staleAfterMs: 300_000 })),
    );

    const ids = results.filter((claimed) => claimed !== undefined).map((claimed) => claimed.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('Retry mit Backoff', () => {
  it('plant einen wiederholbaren Fehler erneut ein: attempts steigt, available_at rueckt vor', async () => {
    const runtime = createTestRuntime(handle.db);
    runtime.provider.nextError = transientError();

    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
      maxAttempts: 3,
    });
    const before = await findJob(handle.db, job.id);

    const outcome = await runtime.worker.runOnce();

    const after = await findJob(handle.db, job.id);
    expect(outcome).toMatchObject({ status: 'queued', attempts: 1 });
    expect(after?.status).toBe('queued');
    expect(after?.attempts).toBe(1);
    expect(after?.availableAt.getTime()).toBeGreaterThan(
      (before?.availableAt.getTime() ?? 0) + 500,
    );
    expect(after?.lastError).toContain('transient:');

    // Der Fehlschlag steht auch im Aufruf-Protokoll.
    const calls = await handle.db.select().from(llmCallLog);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('error');
  });

  it('waechst der Backoff mit jedem Versuch', async () => {
    const runtime = createTestRuntime(handle.db);
    runtime.provider.nextError = transientError();

    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
      maxAttempts: 5,
    });

    await runtime.worker.runOnce();
    const firstDelay = delayMs(await availableAt(job.id));

    // Sofort wieder faellig machen, um den zweiten Versuch zu erzwingen.
    await handle.db
      .update(jobQueue)
      .set({ availableAt: new Date() })
      .where(eq(jobQueue.id, job.id));
    await runtime.worker.runOnce();
    const secondDelay = delayMs(await availableAt(job.id));

    expect(secondDelay).toBeGreaterThan(firstDelay);
  });
});

describe('Dead-Letter', () => {
  it('landet nach Erschoepfen von max_attempts im Dead-Letter, mit gespeichertem Fehler', async () => {
    const runtime = createTestRuntime(handle.db);
    runtime.provider.nextError = transientError();

    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
      maxAttempts: 2,
    });

    // Versuch 1: erneut eingeplant.
    expect(await runtime.worker.runOnce()).toMatchObject({ status: 'queued', attempts: 1 });
    await handle.db
      .update(jobQueue)
      .set({ availableAt: new Date() })
      .where(eq(jobQueue.id, job.id));

    // Versuch 2 ist der letzte - danach ist Schluss.
    expect(await runtime.worker.runOnce()).toMatchObject({ status: 'dead', attempts: 2 });

    const dead = await findJob(handle.db, job.id);
    expect(dead?.status).toBe('dead');
    expect(dead?.attempts).toBe(2);
    expect(dead?.lastError).toContain('transient: Anthropic-API voruebergehend gestoert');

    // Keine Endlosschleife: Ein weiterer Durchlauf findet nichts mehr.
    await expect(runtime.worker.runOnce()).resolves.toBeUndefined();
  });

  it('geht bei einem nicht wiederholbaren Fehler sofort in den Dead-Letter', async () => {
    const runtime = createTestRuntime(handle.db);
    runtime.provider.nextError = authError();

    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
      maxAttempts: 5,
    });

    const outcome = await runtime.worker.runOnce();

    expect(outcome).toMatchObject({ status: 'dead', attempts: 1 });
    const dead = await findJob(handle.db, job.id);
    expect(dead?.status).toBe('dead');
    // Nur ein Versuch, obwohl fuenf erlaubt gewesen waeren.
    expect(dead?.attempts).toBe(1);
    expect(dead?.lastError).toContain('auth:');
  });

  it('weist eine ungueltige Nutzlast ab, ohne einen Aufruf abzusetzen', async () => {
    const runtime = createTestRuntime(handle.db);
    await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: { values: { a: 'b' } },
      maxAttempts: 5,
    });

    const outcome = await runtime.worker.runOnce();

    expect(outcome?.status).toBe('dead');
    expect(outcome?.error).toContain('Feld "templateId" fehlt');
    expect(runtime.provider.calls).toHaveLength(0);
    expect(await handle.db.select().from(llmCallLog)).toHaveLength(0);
  });

  it('weist einen unbekannten Job-Typ ab', async () => {
    const runtime = createTestRuntime(handle.db);
    await enqueueJob(handle.db, { jobType: 'gibt.es.nicht', payload: {} });

    const outcome = await runtime.worker.runOnce();
    expect(outcome?.status).toBe('dead');
    expect(outcome?.error).toContain('Unbekannter Job-Typ "gibt.es.nicht"');
  });

  it('laesst sich aus dem Dead-Letter erneut einplanen', async () => {
    const runtime = createTestRuntime(handle.db);
    runtime.provider.nextError = authError();

    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
    });
    await runtime.worker.runOnce();
    expect((await findJob(handle.db, job.id))?.status).toBe('dead');

    // Ursache behoben - Arbeit ist nicht verloren.
    runtime.provider.nextError = undefined;
    const requeued = await requeueDeadJob(handle.db, job.id);
    expect(requeued).toMatchObject({ status: 'queued', attempts: 0 });

    expect(await runtime.worker.runOnce()).toMatchObject({ status: 'done' });
  });

  it('plant einen Job, der nicht tot ist, nicht erneut ein', async () => {
    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
    });
    await expect(requeueDeadJob(handle.db, job.id)).resolves.toBeUndefined();
  });
});

describe('Verwaiste Jobs', () => {
  it('nimmt einen haengengebliebenen running-Job nach der Frist wieder auf', async () => {
    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
    });

    // Zustand nach einem Worker-Absturz: beansprucht, nie abgeschlossen.
    await handle.db
      .update(jobQueue)
      .set({ status: 'running', claimedAt: sql`now() - interval '10 minutes'`, attempts: 1 })
      .where(eq(jobQueue.id, job.id));

    // Mit langer Frist bleibt er liegen ...
    await expect(
      claimNextJob(handle.db, { staleAfterMs: 60 * 60 * 1000 }),
    ).resolves.toBeUndefined();

    // ... mit abgelaufener Frist wird er wieder aufgenommen.
    const runtime = createTestRuntime(handle.db, { staleAfterMs: 60_000 });
    const outcome = await runtime.worker.runOnce();

    expect(outcome).toMatchObject({ jobId: job.id, status: 'done' });
    // Der Absturz zaehlt als Versuch: 1 (vor dem Absturz) + 1 (jetzt).
    expect(outcome?.attempts).toBe(2);
  });

  it('laesst einen frisch beanspruchten Job in Ruhe', async () => {
    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
    });
    await handle.db
      .update(jobQueue)
      .set({ status: 'running', claimedAt: new Date() })
      .where(eq(jobQueue.id, job.id));

    await expect(claimNextJob(handle.db, { staleAfterMs: 60_000 })).resolves.toBeUndefined();
  });
});

/** `available_at` eines Jobs. */
async function availableAt(jobId: string): Promise<Date> {
  const row = await findJob(handle.db, jobId);
  if (row === undefined) throw new Error('Job nicht gefunden.');
  return row.availableAt;
}

function delayMs(at: Date): number {
  return at.getTime() - Date.now();
}

/** Kleiner Zusatz: Reihenfolge der Protokolleintraege ist nach Zeit sortiert. */
describe('Aufruf-Protokoll', () => {
  it('legt die Eintraege in zeitlicher Reihenfolge ab', async () => {
    const runtime = createTestRuntime(handle.db);
    for (let index = 0; index < 2; index += 1) {
      await enqueueJob(handle.db, { jobType: LLM_COMPLETE_JOB, payload: samplePayload() });
      await runtime.worker.runOnce();
    }

    const calls = await handle.db.select().from(llmCallLog).orderBy(desc(llmCallLog.createdAt));
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.status === 'success')).toBe(true);
  });
});
