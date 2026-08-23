import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { user } from '../../src/db/schema.js';
import { LoginRateLimiter } from '../../src/auth/rate-limit.js';
import { createTestContext, createTestUser, login, testAuthConfig } from './helpers.js';
import type { TestContext } from './helpers.js';

const USERNAME = 'ratelimit-test-user';
const PASSWORD = 'wieder-ein-langes-testpasswort';
const MAX_ATTEMPTS = 3;

describe('Login-Rate-Limit', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext(testAuthConfig({ loginMaxAttempts: MAX_ATTEMPTS }));
    await createTestUser(context, USERNAME, PASSWORD);
  });

  afterAll(async () => {
    await context.handle.db.delete(user).where(eq(user.username, USERNAME));
    await context.close();
  });

  afterEach(() => {
    context.limiter.clear();
  });

  it('antwortet nach der konfigurierten Anzahl Fehlversuche mit 429', async () => {
    const statusCodes: number[] = [];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const result = await login(context.app, USERNAME, 'falsches-passwort');
      statusCodes.push(result.statusCode);
    }

    // Die ersten MAX_ATTEMPTS Versuche sind normale Fehlschlaege.
    expect(statusCodes).toEqual(Array<number>(MAX_ATTEMPTS).fill(401));

    // Der naechste Versuch wird gesperrt.
    const blocked = await login(context.app, USERNAME, 'falsches-passwort');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toMatchObject({ error: 'rate_limited' });
  });

  it('sperrt auch den Versuch mit korrektem Passwort, solange die Sperre laeuft', async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await login(context.app, USERNAME, 'falsches-passwort');
    }

    const blocked = await login(context.app, USERNAME, PASSWORD);
    expect(blocked.statusCode).toBe(429);
  });

  it('blockiert einen erfolgreichen Login nicht, wenn das Limit nicht erreicht ist', async () => {
    // Ein Fehlversuch unterhalb der Grenze ...
    await login(context.app, USERNAME, 'falsches-passwort');

    // ... darf den anschliessenden korrekten Login nicht verhindern.
    const ok = await login(context.app, USERNAME, PASSWORD);
    expect(ok.statusCode).toBe(200);
  });

  it('setzt den Zaehler nach erfolgreichem Login zurueck', async () => {
    await login(context.app, USERNAME, 'falsches-passwort');
    await login(context.app, USERNAME, 'falsches-passwort');
    const ok = await login(context.app, USERNAME, PASSWORD);
    expect(ok.statusCode).toBe(200);

    // Nach dem Reset stehen wieder alle Versuche zur Verfuegung.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const result = await login(context.app, USERNAME, 'falsches-passwort');
      expect(result.statusCode).toBe(401);
    }
  });
});

describe('LoginRateLimiter (Einheit)', () => {
  it('gibt nach Ablauf des Zeitfensters wieder frei', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 2, windowMs: 1000 });
    const now = 1_000_000;

    limiter.registerFailure('key', now);
    limiter.registerFailure('key', now);
    expect(limiter.check('key', now).allowed).toBe(false);

    // Nach dem Fenster ist der Eintrag verfallen.
    expect(limiter.check('key', now + 1001).allowed).toBe(true);
  });

  it('zaehlt Schluessel unabhaengig voneinander', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000 });
    limiter.registerFailure('a');
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
  });
});
