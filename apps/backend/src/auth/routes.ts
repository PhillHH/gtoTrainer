import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  SESSION_COOKIE_NAME,
  type CsrfTokenResponse,
  type LoginResponse,
  type LogoutResponse,
  type MeResponse,
} from '@gto/shared';
import type { AuthConfig } from '../config/env.js';
import type { Database } from '../db/client.js';
import { user } from '../db/schema.js';
import { sendAuthError } from './plugin.js';
import { verifyPassword } from './password.js';
import { LoginRateLimiter } from './rate-limit.js';
import { createSession, deleteExpiredSessions, deleteSessionByToken } from './session.js';

export interface AuthRoutesOptions {
  readonly db: Database;
  readonly config: AuthConfig;
  /** Injizierbar, damit Tests den Zaehler zuruecksetzen koennen. */
  readonly rateLimiter?: LoginRateLimiter;
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
  /** Wird erst genutzt, wenn der TOTP-Hook aktiviert ist (siehe unten). */
  totp?: unknown;
}

/**
 * Schluessel fuer das Rate-Limit.
 *
 * Kombiniert IP und Benutzername: Ein Angreifer, der viele Benutzernamen
 * durchprobiert, wird ueber die IP gebremst; jemand, der ein Konto von
 * wechselnden IPs angreift, ueber den Benutzernamen.
 */
function rateLimitKey(request: FastifyRequest, username: string): string {
  return `${request.ip}|${username.toLowerCase()}`;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  const { db, config } = options;
  const limiter =
    options.rateLimiter ??
    new LoginRateLimiter({
      maxAttempts: config.loginMaxAttempts,
      windowMs: config.loginWindowMs,
    });

  /**
   * Liefert einen CSRF-Token und setzt ihn zugleich als lesbares Cookie.
   * Der Client ruft das vor dem ersten zustandsaendernden Request auf.
   */
  app.get('/api/auth/csrf', async (_request, reply): Promise<CsrfTokenResponse> => {
    const csrfToken = app.issueCsrfToken(reply);
    return { csrfToken };
  });

  app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as LoginBody;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      return sendAuthError(
        reply,
        400,
        'invalid_request',
        'Benutzername und Passwort sind erforderlich.',
      );
    }

    const key = rateLimitKey(request, username);
    const decision = limiter.check(key);
    if (!decision.allowed) {
      // Bewusst ohne Hinweis darauf, ob das Konto existiert.
      void reply.header('Retry-After', String(decision.retryAfterSeconds));
      return sendAuthError(
        reply,
        429,
        'rate_limited',
        `Zu viele Fehlversuche. Bitte in ${decision.retryAfterSeconds} Sekunden erneut versuchen.`,
      );
    }

    const rows = await db
      .select({ id: user.id, username: user.username, passwordHash: user.passwordHash })
      .from(user)
      .where(eq(user.username, username))
      .limit(1);
    const found = rows[0];

    // Bei unbekanntem Benutzer wird gegen einen Dummy-Hash verifiziert, damit
    // der Zeitaufwand identisch ist und die Kontoexistenz nicht durchsickert.
    const passwordOk = await verifyPassword(found?.passwordHash, password);

    if (!found || !passwordOk) {
      limiter.registerFailure(key);
      return sendAuthError(
        reply,
        401,
        'invalid_credentials',
        'Benutzername oder Passwort ist falsch.',
      );
    }

    // ---------------------------------------------------------------------
    // TOTP-HOOK (AP1.T1.3 vorbereitet, standardmaessig AUS)
    //
    // Ist `TOTP_ENABLED=true` gesetzt UND hat der Benutzer ein `totp_secret`,
    // gehoert hier die Pruefung von `body.totp` gegen das Secret hin. Bis
    // dahin wird der Login abgelehnt, statt den zweiten Faktor stillschweigend
    // zu ueberspringen - ein aktivierter Schalter darf nicht wirkungslos sein.
    // Die vollstaendige TOTP-Implementierung ist ausdruecklich NICHT Teil
    // dieses Tasks.
    // ---------------------------------------------------------------------
    if (config.totpEnabled) {
      const totpRows = await db
        .select({ totpSecret: user.totpSecret })
        .from(user)
        .where(eq(user.id, found.id))
        .limit(1);

      if (totpRows[0]?.totpSecret) {
        limiter.registerFailure(key);
        return sendAuthError(
          reply,
          401,
          'invalid_credentials',
          'Zweiter Faktor erforderlich, aber noch nicht implementiert (TOTP-Hook).',
        );
      }
    }

    limiter.reset(key);

    // Gelegenheit zum Aufraeumen; ein periodischer Lauf kommt mit der
    // Job-Queue in AP2.
    await deleteExpiredSessions(db);

    const created = await createSession(db, found.id, config.sessionTtlMs);
    app.setSessionCookie(reply, created.token, created.expiresAt);
    // Nach dem Login ein frisches CSRF-Token - Session-Fixation vorbeugen.
    app.issueCsrfToken(reply);

    const response: LoginResponse = { user: { id: found.id, username: found.username } };
    return reply.code(200).send(response);
  });

  app.post('/api/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token) {
      // Serverseitig loeschen - ein spaeter erneut gesendetes Cookie ist wertlos.
      await deleteSessionByToken(db, token);
    }
    app.clearSessionCookie(reply);

    const response: LogoutResponse = { loggedOut: true };
    return reply.code(200).send(response);
  });

  app.get(
    '/api/auth/me',
    { preHandler: app.requireSession },
    async (request: FastifyRequest): Promise<MeResponse> => {
      // requireSession garantiert, dass sessionUser gesetzt ist.
      return { user: request.sessionUser! };
    },
  );
}
