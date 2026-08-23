import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { JOB_EVENT_NAME, isJobEvent } from '@gto/shared';
import type { JobEvent } from '@gto/shared';
import { buildApp } from '../../src/app.js';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { JobEventBus } from '../../src/jobs/events.js';
import { enqueueJob } from '../../src/jobs/queue.js';
import { LLM_COMPLETE_JOB } from '../../src/jobs/handlers/llm-complete.js';
import { llmCallLog } from '../../src/db/schema.js';
import { TEST_DATABASE_URL, prepareTestDatabase } from '../db/setup.js';
import { createTestUser, login, testAuthConfig } from '../auth/helpers.js';
import type { TestContext } from '../auth/helpers.js';
import { clearTables, createTestRuntime, samplePayload } from './helpers.js';

/**
 * Integrationstest des SSE-Statuskanals. Kein Browser noetig: Der Test
 * verbindet sich mit `fetch` auf einen echt lauschenden Server und liest den
 * Strom Stueck fuer Stueck.
 */

let handle: DbHandle;
let app: FastifyInstance;
let events: JobEventBus;
let baseUrl: string;
let cookieHeader: string;

beforeAll(async () => {
  await prepareTestDatabase();
  handle = createDb(TEST_DATABASE_URL, { max: 5 });
  events = new JobEventBus();

  app = await buildApp({
    db: handle.db,
    authConfig: testAuthConfig(),
    jobEvents: events,
    // Kurzer Takt, damit der Test den Keepalive sieht, ohne zu warten.
    sseKeepAliveMs: 50,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  // Die Auth-Helfer erwarten eine TestContext-Form; hier genuegt die App.
  const context = { app, handle } as unknown as TestContext;
  await createTestUser(context, 'sse-nutzer', 'ein-langes-testpasswort');
  cookieHeader = (await login(app, 'sse-nutzer', 'ein-langes-testpasswort')).cookieHeader;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

afterEach(async () => {
  await clearTables(handle.db);
});

/** Oeffnet den Stream und liefert einen Leser fuer einzelne Ereignisse. */
async function openStream(): Promise<{
  next(timeoutMs?: number): Promise<JobEvent>;
  raw(): string;
  close(): void;
}> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/jobs/events`, {
    headers: { cookie: cookieHeader },
    signal: controller.signal,
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  // Ohne diesen Header puffert Nginx den Strom und nichts kommt an.
  expect(response.headers.get('x-accel-buffering')).toBe('no');

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Alles, was je ueber die Leitung kam - auch die Kommentarzeilen, die der
  // Blockparser unten aus `buffer` entfernt.
  let seen = '';
  const pending: JobEvent[] = [];

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        seen += chunk;

        let separator = buffer.indexOf('\n\n');
        while (separator >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
          if (block.includes(`event: ${JOB_EVENT_NAME}`) && dataLine !== undefined) {
            const parsed: unknown = JSON.parse(dataLine.slice('data: '.length));
            if (isJobEvent(parsed)) pending.push(parsed);
          }
          separator = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Abbruch beim Schliessen ist erwartet.
    }
  })();

  return {
    async next(timeoutMs = 3_000): Promise<JobEvent> {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const event = pending.shift();
        if (event !== undefined) return event;
        if (Date.now() > until) throw new Error('Kein Ereignis innerhalb der Wartezeit.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    raw: () => seen,
    close: () => {
      controller.abort();
      void pump;
    },
  };
}

describe('SSE-Statuskanal', () => {
  it('verlangt eine Session', async () => {
    const response = await fetch(`${baseUrl}/api/jobs/events`);
    expect(response.status).toBe(401);
    await response.text();
  });

  it('liefert Statusaenderungen eines echten Job-Durchlaufs', async () => {
    const stream = await openStream();
    try {
      const runtime = createTestRuntime(handle.db);
      // Der Worker dieses Tests schreibt in denselben Bus wie die Route.
      runtime.events.subscribe((event) => events.publish(event));

      const job = await enqueueJob(handle.db, {
        jobType: LLM_COMPLETE_JOB,
        payload: samplePayload(),
      });
      await runtime.worker.runOnce();

      const running = await stream.next();
      expect(running).toMatchObject({ jobId: job.id, status: 'running' });

      const done = await stream.next();
      expect(done).toMatchObject({ jobId: job.id, status: 'done', jobType: LLM_COMPLETE_JOB });

      // Der Aufruf ist zugleich im Protokoll gelandet.
      expect(await handle.db.select().from(llmCallLog)).toHaveLength(1);
    } finally {
      stream.close();
    }
  });

  it('meldet auch den Dead-Letter-Zustand samt Fehlerkategorie', async () => {
    const stream = await openStream();
    try {
      const runtime = createTestRuntime(handle.db);
      runtime.events.subscribe((event) => events.publish(event));
      runtime.provider.nextError = new Error('kaputt');

      await enqueueJob(handle.db, { jobType: LLM_COMPLETE_JOB, payload: samplePayload() });
      await runtime.worker.runOnce();

      expect(await stream.next()).toMatchObject({ status: 'running' });
      const dead = await stream.next();
      expect(dead).toMatchObject({ status: 'dead' });
      expect(dead.error).toContain('kaputt');
    } finally {
      stream.close();
    }
  });

  it('meldet den Zuhoerer bei Verbindungsabbruch wieder ab', async () => {
    const before = events.size;
    const stream = await openStream();

    // Die Verbindung steht.
    expect(events.size).toBe(before + 1);

    stream.close();
    await waitFor(() => events.size === before);
    expect(events.size).toBe(before);
  });

  it('haelt die Verbindung mit Keepalive-Kommentaren offen', async () => {
    const stream = await openStream();
    try {
      await waitFor(() => stream.raw().includes('keepalive'), 2_000);
      expect(stream.raw()).toContain('keepalive');
    } finally {
      stream.close();
    }
  });
});

describe('Dead-Letter erneut einplanen', () => {
  it('setzt einen toten Job auf queued und meldet das ueber den Kanal', async () => {
    const runtime = createTestRuntime(handle.db);
    runtime.events.subscribe((event) => events.publish(event));
    runtime.provider.nextError = new Error('kaputt');

    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
    });
    await runtime.worker.runOnce();

    const response = await fetch(`${baseUrl}/api/jobs/${job.id}/retry`, {
      method: 'POST',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfFrom(cookieHeader) },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jobId: job.id, status: 'queued', attempts: 0 });
  });

  it('lehnt einen Job ab, der nicht im Dead-Letter steht', async () => {
    const job = await enqueueJob(handle.db, {
      jobType: LLM_COMPLETE_JOB,
      payload: samplePayload(),
    });

    const response = await fetch(`${baseUrl}/api/jobs/${job.id}/retry`, {
      method: 'POST',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfFrom(cookieHeader) },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });
});

/** Liest den CSRF-Token aus dem zusammengesetzten Cookie-Header. */
function csrfFrom(cookies: string): string {
  const match = /gto_csrf=([^;]+)/.exec(cookies);
  return decodeURIComponent(match?.[1] ?? '');
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error('Bedingung wurde nicht rechtzeitig erfuellt.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
