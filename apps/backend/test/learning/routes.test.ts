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
