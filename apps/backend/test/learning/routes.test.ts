import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CSRF_COOKIE_NAME, isLearningEventErrorResponse } from '@gto/shared';
import { createTestContext, createTestUser, login } from '../auth/helpers.js';
import type { TestContext } from '../auth/helpers.js';
import { seedLearningState } from '../../src/learning/seed.js';
import { clearLearning, seedConcepts } from './helpers.js';
import type { LearningFixture } from './helpers.js';

/**
 * `POST /api/learning/events` (AP4.T4.2).
 *
 * Der Endpunkt ist eine zweite Tuer zu `recordLearningEvent`, keine zweite
 * Implementierung - geprueft wird hier deshalb vor allem die Absicherung
 * (Session, CSRF) und die Uebersetzung der Ablehnung in HTTP.
 */
describe('POST /api/learning/events', () => {
  let context: TestContext;
  let fixture: LearningFixture;
  let cookieHeader: string;
  let csrfToken: string;

  beforeAll(async () => {
    context = await createTestContext();
    await createTestUser(context, 'lernstand-tester', 'ein-langes-testpasswort');
    const session = await login(context.app, 'lernstand-tester', 'ein-langes-testpasswort');
    cookieHeader = session.cookieHeader;
    csrfToken = session.csrfToken;
  });

  afterAll(async () => {
    await clearLearning(context.handle.db);
    await context.close();
  });

  beforeEach(async () => {
    await clearLearning(context.handle.db);
    fixture = await seedConcepts(context.handle.db);
    await seedLearningState(context.handle.db);
  });

  function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: randomUUID(),
      eventType: 'question_answered',
      source: 'theory_session',
      signalClass: 'objective',
      conceptId: fixture.approvedConceptId,
      occurredAt: '2026-08-22T12:00:00.000Z',
      payload: { correct: true },
      ...overrides,
    };
  }

  it('lehnt ohne Session mit 401 ab', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/learning/events',
      headers: {
        cookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}`,
        'x-csrf-token': csrfToken,
      },
      payload: body(),
    });

    expect(response.statusCode).toBe(401);
    const events = await context.handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event`,
    );
    expect(Number(events.rows[0]?.n)).toBe(0);
  });

  it('lehnt ohne CSRF-Token ab', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/learning/events',
      headers: { cookie: cookieHeader },
      payload: body(),
    });

    expect(response.statusCode).toBe(403);
    const events = await context.handle.db.execute<{ n: string }>(
      sql`select count(*) as n from learning_event`,
    );
    expect(Number(events.rows[0]?.n)).toBe(0);
  });

  it('zeichnet mit gueltiger Session ein Ereignis auf', async () => {
    const payload = body({ payload: { correct: false } });
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/learning/events',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      status: 'recorded',
      eventId: payload['id'],
      conceptId: fixture.approvedConceptId,
    });

    // Derselbe Weg wie intern: Die Ableitungen sind gezogen.
    const mastery = await context.handle.db.execute<{ score: number }>(
      sql`select score from concept_mastery where concept_id = ${fixture.approvedConceptId}`,
    );
    expect(mastery.rows[0]?.score).toBe(0);
  });

  it('meldet ein wiederholt gesendetes Ereignis als duplicate mit 200', async () => {
    const payload = body();
    const headers = { cookie: cookieHeader, 'x-csrf-token': csrfToken };

    const first = await context.app.inject({
      method: 'POST',
      url: '/api/learning/events',
      headers,
      payload,
    });
    const second = await context.app.inject({
      method: 'POST',
      url: '/api/learning/events',
      headers,
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'duplicate' });
  });

  /* --- Lese-Endpunkte (T4.7) -------------------------------------------- */

  /** Die vier Lesestellen, gegen die AP6 baut. */
  const READ_ROUTES = [
    '/api/learning/dashboard',
    '/api/learning/queue',
    '/api/learning/ratings',
  ] as const;

  it('lehnt jeden Lese-Endpunkt ohne Session mit 401 ab', async () => {
    for (const url of [...READ_ROUTES, `/api/learning/concepts/${fixture.approvedConceptId}`]) {
      const response = await context.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('liefert die Lese-Endpunkte mit gueltiger Session aus', async () => {
    const headers = { cookie: cookieHeader };

    for (const url of READ_ROUTES) {
      const response = await context.app.inject({ method: 'GET', url, headers });
      expect(response.statusCode, url).toBe(200);
      expect(response.json()).toHaveProperty('asOf');
    }

    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/learning/concepts/${fixture.approvedConceptId}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ conceptId: fixture.approvedConceptId });
  });

  it('braucht fuer einen Lese-Endpunkt kein CSRF-Token', async () => {
    // Lesende Anfragen aendern nichts - der CSRF-Hook greift zu Recht nur bei
    // zustandsaendernden Methoden.
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/learning/dashboard',
      headers: { cookie: cookieHeader },
    });
    expect(response.statusCode).toBe(200);
  });

  it('meldet ein unbekanntes Konzept mit 404, nicht mit 500', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/learning/concepts/00000000-0000-4000-8000-000000000000',
      headers: { cookie: cookieHeader },
    });
    expect(response.statusCode).toBe(404);
  });

  it('lehnt unbrauchbare Abfrageparameter mit 400 ab', async () => {
    const headers = { cookie: cookieHeader };
    const faelle = [
      '/api/learning/dashboard?asOf=gestern',
      '/api/learning/queue?context=turnierchen',
      '/api/learning/queue?limit=viele',
      '/api/learning/ratings?days=0',
    ];

    for (const url of faelle) {
      const response = await context.app.inject({ method: 'GET', url, headers });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it('nimmt den Bezugszeitpunkt aus der Anfrage entgegen', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/learning/queue?asOf=2026-03-01T12:00:00.000Z',
      headers: { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(200);
    // Ohne Angabe gaelte "jetzt"; die Vorbelegung sitzt an der HTTP-Grenze.
    expect(response.json().asOf).toBe('2026-03-01T12:00:00.000Z');
  });

  it('lehnt ungueltige Nutzdaten feldweise mit 400 ab', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/learning/events',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: body({ eventType: 'concept_explained', payload: { quality: 5 } }),
    });

    expect(response.statusCode).toBe(400);
    const error = response.json();
    expect(isLearningEventErrorResponse(error)).toBe(true);
    expect(error.fields).toContainEqual({
      field: 'payload.quality',
      message: '"quality" muss eine Zahl zwischen 0 und 1 sein.',
    });
  });
});
