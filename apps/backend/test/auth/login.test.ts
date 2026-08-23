import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME } from '@gto/shared';
import { hashSessionToken } from '../../src/auth/session.js';
import { session, user } from '../../src/db/schema.js';
import {
  countSessions,
  createTestContext,
  createTestUser,
  getCsrf,
  login,
  readSetCookie,
} from './helpers.js';
import type { TestContext } from './helpers.js';

const USERNAME = 'login-test-user';
const PASSWORD = 'ein-sehr-langes-testpasswort';

describe('Login und Session', () => {
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

  it('erfolgreicher Login setzt ein HttpOnly-Cookie und legt die Session in der DB an', async () => {
    const result = await login(context.app, USERNAME, PASSWORD);

    expect(result.statusCode).toBe(200);
    expect(result.sessionToken).toBeTruthy();
    expect(result.body).toMatchObject({ user: { username: USERNAME } });

    // Die Session muss wirklich in der Datenbank stehen.
    expect(await countSessions(context, USERNAME)).toBe(1);
  });

  it('setzt das Session-Cookie mit HttpOnly, Path und SameSite', async () => {
    const csrf = await getCsrf(context.app);
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: csrf.headers,
      payload: { username: USERNAME, password: PASSWORD },
    });

    const cookie = readSetCookie(response.headers as Record<string, unknown>, SESSION_COOKIE_NAME);
    expect(cookie).toBeDefined();
    expect(cookie!.raw).toMatch(/HttpOnly/i);
    expect(cookie!.raw).toMatch(/Path=\//i);
    expect(cookie!.raw).toMatch(/SameSite=Lax/i);
  });

  it('speichert den Session-Token nicht im Klartext, sondern als Hash', async () => {
    const result = await login(context.app, USERNAME, PASSWORD);
    const token = result.sessionToken!;

    const rows = await context.handle.db
      .select({ tokenHash: session.tokenHash })
      .from(session)
      .where(eq(session.tokenHash, hashSessionToken(token)))
      .limit(1);

    expect(rows).toHaveLength(1);
    const stored = rows[0]!.tokenHash;
    // Der gespeicherte Wert weicht vom Cookie-Wert ab ...
    expect(stored).not.toBe(token);
    // ... und ist der SHA-256-Hex-Hash des Cookie-Werts.
    expect(stored).toBe(hashSessionToken(token));
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lehnt ein falsches Passwort ab, ohne eine Session anzulegen', async () => {
    const before = await countSessions(context, USERNAME);
    const result = await login(context.app, USERNAME, 'falsches-passwort-hier');

    expect(result.statusCode).toBe(401);
    expect(await countSessions(context, USERNAME)).toBe(before);
  });

  it('antwortet bei unbekanntem Benutzer identisch wie bei falschem Passwort', async () => {
    const wrongPassword = await login(context.app, USERNAME, 'falsches-passwort-hier');
    context.limiter.clear();
    const unknownUser = await login(context.app, 'gibt-es-nicht', 'falsches-passwort-hier');

    expect(unknownUser.statusCode).toBe(wrongPassword.statusCode);
    // Weder Statuscode noch Fehlertext duerfen die Kontoexistenz verraten.
    expect(unknownUser.body).toEqual(wrongPassword.body);
    expect(unknownUser.body).toMatchObject({ error: 'invalid_credentials' });
  });

  it('weist einen Login ohne Benutzername oder Passwort mit 400 ab', async () => {
    const csrf = await getCsrf(context.app);
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: csrf.headers,
      payload: { username: USERNAME },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
  });
});
