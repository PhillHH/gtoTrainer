import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME } from '@gto/shared';
import {
  createSession,
  findSessionRowByToken,
  generateSessionToken,
} from '../../src/auth/session.js';
import { user } from '../../src/db/schema.js';
import { countSessions, createTestContext, createTestUser, login } from './helpers.js';
import type { TestContext } from './helpers.js';

const USERNAME = 'guard-test-user';
const PASSWORD = 'noch-ein-langes-testpasswort';

describe('Auth-Guard auf geschuetzten Routen', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
    await createTestUser(context, USERNAME, PASSWORD);
  });

  afterAll(async () => {
    await context.handle.db.delete(user).where(eq(user.username, USERNAME));
    await context.close();
  });

  afterEach(() => {
    context.limiter.clear();
  });

  it('geschuetzte Route ohne Session antwortet mit 401', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('geschuetzte Route mit ungueltigem Token antwortet mit 401', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${generateSessionToken()}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('geschuetzte Route mit abgelaufener Session antwortet mit 401', async () => {
    const rows = await context.handle.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.username, USERNAME))
      .limit(1);

    // TTL in der Vergangenheit -> Session ist sofort abgelaufen.
    const expired = await createSession(context.handle.db, rows[0]!.id, -1000);

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(expired.token)}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('geschuetzte Route mit gueltiger Session antwortet mit 200', async () => {
    const session = await login(context.app, USERNAME, PASSWORD);
    expect(session.statusCode).toBe(200);

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookieHeader },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { username: USERNAME } });
  });

  it('GET /healthz bleibt ohne Session oeffentlich erreichbar', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('Logout invalidiert die Session serverseitig: derselbe Cookie fuehrt danach zu 401', async () => {
    const session = await login(context.app, USERNAME, PASSWORD);
    const sessionsBefore = await countSessions(context, USERNAME);

    const logout = await context.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: session.cookieHeader,
        // Muss zum CSRF-Cookie aus cookieHeader passen.
        'x-csrf-token': session.csrfToken,
      },
    });

    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ loggedOut: true });
    // Genau diese eine Session ist weg (frueheren Tests gehoerende bleiben).
    expect(await countSessions(context, USERNAME)).toBe(sessionsBefore - 1);
    expect(await findSessionRowByToken(context.handle.db, session.sessionToken!)).toBeUndefined();

    // Derselbe Cookie-Wert wie vorher - jetzt wertlos.
    const after = await context.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookieHeader },
    });
    expect(after.statusCode).toBe(401);
  });
});
