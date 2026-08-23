import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { user } from '../../src/db/schema.js';
import { setPassword } from '../../src/auth/set-password.js';
import { checkPasswordPolicy, verifyPassword } from '../../src/auth/password.js';
import { countSessions, createTestContext, login } from './helpers.js';
import type { TestContext } from './helpers.js';

const USERNAME = 'cli-test-user';
const FIRST_PASSWORD = 'erstes-langes-passwort';
const SECOND_PASSWORD = 'zweites-langes-passwort';

describe('Passwort-CLI (setPassword)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
    await context.handle.db.delete(user).where(eq(user.username, USERNAME));
  });

  afterAll(async () => {
    await context.handle.db.delete(user).where(eq(user.username, USERNAME));
    await context.close();
  });

  afterEach(() => {
    context.limiter.clear();
  });

  it('legt den Benutzer an, wenn er noch nicht existiert, und ermoeglicht den Login', async () => {
    const result = await setPassword(context.handle.db, USERNAME, FIRST_PASSWORD);
    expect(result.created).toBe(true);

    const loggedIn = await login(context.app, USERNAME, FIRST_PASSWORD);
    expect(loggedIn.statusCode).toBe(200);
  });

  it('aendert das Passwort eines bestehenden Benutzers und invalidiert alte Sessions', async () => {
    // Alte Session herstellen ...
    const before = await login(context.app, USERNAME, FIRST_PASSWORD);
    expect(before.statusCode).toBe(200);
    expect(await countSessions(context, USERNAME)).toBeGreaterThan(0);

    // ... Passwort aendern ...
    const changed = await setPassword(context.handle.db, USERNAME, SECOND_PASSWORD);
    expect(changed.created).toBe(false);
    expect(changed.invalidatedSessions).toBeGreaterThan(0);
    expect(await countSessions(context, USERNAME)).toBe(0);

    // ... alte Session gilt nicht mehr ...
    const withOldCookie = await context.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: before.cookieHeader },
    });
    expect(withOldCookie.statusCode).toBe(401);

    // ... altes Passwort funktioniert nicht mehr, neues schon.
    const withOldPassword = await login(context.app, USERNAME, FIRST_PASSWORD);
    expect(withOldPassword.statusCode).toBe(401);
    context.limiter.clear();

    const withNewPassword = await login(context.app, USERNAME, SECOND_PASSWORD);
    expect(withNewPassword.statusCode).toBe(200);
  });

  it('lehnt zu kurze Passwoerter ab', async () => {
    await expect(setPassword(context.handle.db, USERNAME, 'kurz')).rejects.toThrow(
      /mindestens 12 Zeichen/,
    );
  });

  it('speichert das Passwort als argon2id-Hash, nicht im Klartext', async () => {
    await setPassword(context.handle.db, USERNAME, SECOND_PASSWORD);

    const rows = await context.handle.db
      .select({ passwordHash: user.passwordHash })
      .from(user)
      .where(eq(user.username, USERNAME))
      .limit(1);

    const stored = rows[0]!.passwordHash;
    expect(stored).not.toContain(SECOND_PASSWORD);
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(stored, SECOND_PASSWORD)).toBe(true);
    expect(await verifyPassword(stored, 'anderes-passwort')).toBe(false);
  });
});

describe('Passwort-Richtlinie', () => {
  it('verlangt mindestens 12 Zeichen', () => {
    expect(checkPasswordPolicy('kurz').ok).toBe(false);
    expect(checkPasswordPolicy('a'.repeat(12)).ok).toBe(true);
  });

  it('lehnt reine Leerzeichen ab', () => {
    expect(checkPasswordPolicy(' '.repeat(20)).ok).toBe(false);
  });
});

describe('verifyPassword ohne bekannten Benutzer', () => {
  it('liefert false, ohne zu verraten, dass kein Hash vorlag', async () => {
    expect(await verifyPassword(undefined, 'irgendwas')).toBe(false);
  });
});
