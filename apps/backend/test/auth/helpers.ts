import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '@gto/shared';
import { buildApp } from '../../src/app.js';
import { LoginRateLimiter } from '../../src/auth/rate-limit.js';
import { setPassword } from '../../src/auth/set-password.js';
import { createDb } from '../../src/db/client.js';
import type { DbHandle } from '../../src/db/client.js';
import { session, user } from '../../src/db/schema.js';
import type { AuthConfig } from '../../src/config/env.js';
import { TEST_DATABASE_URL } from '../db/setup.js';

/** Auth-Konfiguration fuer Tests - kurze Fenster, kein Secure (kein HTTPS). */
export function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    sessionTtlMs: 60 * 60 * 1000,
    cookieSecure: false,
    cookieSameSite: 'lax',
    allowedOrigins: [],
    loginMaxAttempts: 3,
    loginWindowMs: 60 * 1000,
    totpEnabled: false,
    ...overrides,
  };
}

export interface TestContext {
  readonly app: FastifyInstance;
  readonly handle: DbHandle;
  readonly limiter: LoginRateLimiter;
  close(): Promise<void>;
}

/** Zusatzoptionen, die einzelne Testsuiten an `buildApp` durchreichen. */
export interface TestContextOptions {
  /** Quellverzeichnis der Buchbilder - die Review-Ansicht liest daraus. */
  readonly bookSourceDir?: string;
}

/** Baut App + DB-Verbindung fuer einen Test. */
export async function createTestContext(
  authConfig: AuthConfig = testAuthConfig(),
  options: TestContextOptions = {},
): Promise<TestContext> {
  const handle = createDb(TEST_DATABASE_URL, { max: 3 });
  const limiter = new LoginRateLimiter({
    maxAttempts: authConfig.loginMaxAttempts,
    windowMs: authConfig.loginWindowMs,
  });
  const app = await buildApp({
    db: handle.db,
    authConfig,
    rateLimiter: limiter,
    ...(options.bookSourceDir === undefined ? {} : { bookSourceDir: options.bookSourceDir }),
  });
  await app.ready();

  return {
    app,
    handle,
    limiter,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}

/** Legt einen Testbenutzer mit Passwort an (ueber denselben Weg wie das CLI). */
export async function createTestUser(
  context: TestContext,
  username: string,
  password: string,
): Promise<void> {
  await context.handle.db.delete(user).where(eq(user.username, username));
  await setPassword(context.handle.db, username, password);
}

/** Liest einen Cookie-Wert aus den Set-Cookie-Headern einer Antwort. */
export function readSetCookie(
  headers: Record<string, unknown>,
  name: string,
): { value: string; raw: string } | undefined {
  const raw = headers['set-cookie'];
  const entries = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const match = entries.find((entry) => entry.startsWith(`${name}=`));
  if (!match) return undefined;
  const value = decodeURIComponent(match.slice(name.length + 1).split(';')[0] ?? '');
  return { value, raw: match };
}

/** Holt ein CSRF-Token und liefert Cookie-Wert plus passende Header. */
export async function getCsrf(app: FastifyInstance): Promise<{
  token: string;
  headers: Record<string, string>;
}> {
  const response = await app.inject({ method: 'GET', url: '/api/auth/csrf' });
  const cookie = readSetCookie(response.headers as Record<string, unknown>, CSRF_COOKIE_NAME);
  if (!cookie) throw new Error('CSRF-Cookie wurde nicht gesetzt.');
  return {
    token: cookie.value,
    headers: {
      cookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(cookie.value)}`,
      [CSRF_HEADER_NAME]: cookie.value,
    },
  };
}

/** Meldet einen Benutzer an und liefert die Cookies fuer Folge-Requests. */
export async function login(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<{
  statusCode: number;
  sessionToken?: string;
  csrfToken: string;
  cookieHeader: string;
  body: unknown;
}> {
  const csrf = await getCsrf(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: csrf.headers,
    payload: { username, password },
  });

  const sessionCookie = readSetCookie(
    response.headers as Record<string, unknown>,
    SESSION_COOKIE_NAME,
  );
  const parts = [`${CSRF_COOKIE_NAME}=${encodeURIComponent(csrf.token)}`];
  if (sessionCookie) {
    parts.push(`${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionCookie.value)}`);
  }

  return {
    statusCode: response.statusCode,
    ...(sessionCookie ? { sessionToken: sessionCookie.value } : {}),
    // Derselbe Token, der auch im cookieHeader steckt - Tests muessen ihn
    // spiegeln, statt ein zweites CSRF-Cookie anzuhaengen.
    csrfToken: csrf.token,
    cookieHeader: parts.join('; '),
    body: response.json(),
  };
}

/** Zaehlt die Sessions eines Benutzers. */
export async function countSessions(context: TestContext, username: string): Promise<number> {
  const rows = await context.handle.db
    .select({ id: session.id })
    .from(session)
    .innerJoin(user, eq(session.userId, user.id))
    .where(eq(user.username, username));
  return rows.length;
}
