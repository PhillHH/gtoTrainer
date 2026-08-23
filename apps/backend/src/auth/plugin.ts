import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  type AuthErrorCode,
  type SessionUser,
} from '@gto/shared';
import type { AuthConfig } from '../config/env.js';
import type { Database } from '../db/client.js';
import { checkCsrf, generateCsrfToken } from './csrf.js';
import { resolveSession } from './session.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * preHandler-Guard fuer geschuetzte Routen.
     *
     * Verwendung:
     * ```ts
     * app.get('/api/etwas', { preHandler: app.requireSession }, handler);
     * ```
     */
    readonly requireSession: preHandlerHookHandler;
    /** Setzt ein frisches CSRF-Cookie und gibt den Token zurueck. */
    issueCsrfToken(reply: FastifyReply): string;
    /** Setzt das Session-Cookie. */
    setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void;
    /** Loescht das Session-Cookie. */
    clearSessionCookie(reply: FastifyReply): void;
  }

  interface FastifyRequest {
    /** Bei gueltiger Session gesetzt, sonst `undefined`. */
    sessionUser?: SessionUser;
  }
}

export interface AuthPluginOptions {
  readonly db: Database;
  readonly config: AuthConfig;
}

/** Einheitliche Fehlerantwort. */
export function sendAuthError(
  reply: FastifyReply,
  statusCode: number,
  error: AuthErrorCode,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send({ error, message });
}

async function authPlugin(app: FastifyInstance, options: AuthPluginOptions): Promise<void> {
  const { db, config } = options;

  await app.register(cookie);

  const cookieBase = {
    path: '/',
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
  } as const;

  app.decorate('setSessionCookie', (reply: FastifyReply, token: string, expiresAt: Date): void => {
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      ...cookieBase,
      // Der Session-Token darf fuer JavaScript nicht lesbar sein.
      httpOnly: true,
      expires: expiresAt,
    });
  });

  app.decorate('clearSessionCookie', (reply: FastifyReply): void => {
    reply.clearCookie(SESSION_COOKIE_NAME, { ...cookieBase, httpOnly: true });
  });

  app.decorate('issueCsrfToken', (reply: FastifyReply): string => {
    const token = generateCsrfToken();
    reply.setCookie(CSRF_COOKIE_NAME, token, {
      ...cookieBase,
      // Bewusst lesbar: Der Client muss den Wert in den Header spiegeln.
      httpOnly: false,
    });
    return token;
  });

  /**
   * Globaler CSRF-Hook.
   *
   * Greift fuer **alle** zustandsaendernden Requests, unabhaengig davon, ob die
   * Route geschuetzt ist. Damit kann keine neue Route den Schutz versehentlich
   * umgehen. Lesende Requests (GET/HEAD/OPTIONS) sind ausgenommen.
   */
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const result = checkCsrf(request, request.cookies[CSRF_COOKIE_NAME], config.allowedOrigins);
    if (!result.ok) {
      return sendAuthError(reply, 403, 'csrf_failed', result.reason);
    }
    return undefined;
  });

  /**
   * Haengt die Session an den Request, wenn ein gueltiges Cookie vorliegt.
   * Blockiert hier noch nichts - das entscheidet `requireSession`.
   */
  app.decorateRequest('sessionUser', undefined);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (!token) return;
    const resolved = await resolveSession(db, token);
    if (resolved) request.sessionUser = resolved.user;
  });

  /**
   * DIE zentrale Stelle, die ueber Zugriff entscheidet. Folge-APs haengen ihre
   * geschuetzten Routen hier ein und implementieren keine eigene Pruefung.
   */
  const requireSession: preHandlerHookHandler = async (request, reply) => {
    if (!request.sessionUser) {
      return sendAuthError(
        reply,
        401,
        'unauthenticated',
        'Keine gueltige Session. Bitte anmelden.',
      );
    }
    return undefined;
  };

  app.decorate('requireSession', requireSession);
}

export default fp(authPlugin, { name: 'auth-plugin' });
