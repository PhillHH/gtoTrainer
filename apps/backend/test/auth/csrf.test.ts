import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { CSRF_COOKIE_NAME } from '@gto/shared';
import { user } from '../../src/db/schema.js';
import { createTestContext, createTestUser, getCsrf, testAuthConfig } from './helpers.js';
import type { TestContext } from './helpers.js';

const USERNAME = 'csrf-test-user';
const PASSWORD = 'csrf-test-passwort-lang';

describe('CSRF-Schutz', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
    await createTestUser(context, USERNAME, PASSWORD);
  });

  afterAll(async () => {
    await context.handle.db.delete(user).where(eq(user.username, USERNAME));
    await context.close();
  });

  it('lehnt einen POST ohne CSRF-Cookie und -Header mit 403 ab', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: PASSWORD },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'csrf_failed' });
  });

  it('lehnt einen POST mit Cookie, aber ohne Header ab', async () => {
    const csrf = await getCsrf(context.app);
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrf.token)}` },
      payload: { username: USERNAME, password: PASSWORD },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'csrf_failed' });
  });

  it('lehnt einen POST ab, wenn Header und Cookie nicht uebereinstimmen', async () => {
    const csrf = await getCsrf(context.app);
    const other = await getCsrf(context.app);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        cookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrf.token)}`,
        'x-csrf-token': other.token,
      },
      payload: { username: USERNAME, password: PASSWORD },
    });

    expect(response.statusCode).toBe(403);
  });

  it('akzeptiert einen POST mit uebereinstimmendem Cookie und Header', async () => {
    const csrf = await getCsrf(context.app);
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: csrf.headers,
      payload: { username: USERNAME, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
  });

  it('laesst lesende Requests ohne CSRF-Token zu', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });

  it('setzt das CSRF-Cookie lesbar (nicht HttpOnly), damit der Client es spiegeln kann', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/auth/csrf' });
    const raw = response.headers['set-cookie'];
    const entries = Array.isArray(raw) ? raw : [String(raw)];
    const cookie = entries.find((entry) => entry.startsWith(`${CSRF_COOKIE_NAME}=`));

    expect(cookie).toBeDefined();
    expect(cookie).not.toMatch(/HttpOnly/i);
    expect(response.json()).toHaveProperty('csrfToken');
  });

  it('lehnt einen POST von einer fremden Herkunft ab, wenn eine Allowlist gilt', async () => {
    const strict = await createTestContext(
      testAuthConfig({ allowedOrigins: ['https://gto.growento.com'] }),
    );
    try {
      const csrf = await getCsrf(strict.app);
      const response = await strict.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...csrf.headers, origin: 'https://angreifer.example' },
        payload: { username: USERNAME, password: PASSWORD },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'csrf_failed' });
    } finally {
      await strict.close();
    }
  });
});
