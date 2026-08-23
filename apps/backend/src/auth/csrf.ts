import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * CSRF-Schutz: Double-Submit-Cookie **plus** Origin-Pruefung.
 *
 * Ablauf (siehe ADR-0009):
 * 1. Der Client holt sich per `GET /api/auth/csrf` einen Token. Der Server
 *    setzt ihn als lesbares Cookie `gto_csrf` und liefert ihn im Body.
 * 2. Bei jedem zustandsaendernden Request (POST/PUT/PATCH/DELETE) schickt der
 *    Client denselben Wert im Header `x-csrf-token`.
 * 3. Der Server vergleicht Cookie und Header in konstanter Zeit. Nur wenn
 *    beide uebereinstimmen, laeuft der Request weiter.
 *
 * Warum das traegt: Fremde Herkunftsseiten koennen das Cookie zwar
 * mitschicken lassen, es aber wegen der Same-Origin-Policy nicht **auslesen**
 * und damit nicht in den Header spiegeln.
 */

/** Methoden, die den Serverzustand aendern und deshalb geprueft werden. */
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Erzeugt einen neuen CSRF-Token. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Prueft, ob eine HTTP-Methode CSRF-geschuetzt werden muss. */
export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

/** Konstantzeit-Vergleich zweier Token. */
export function csrfTokensMatch(cookieToken: string, headerToken: string): boolean {
  const a = Buffer.from(cookieToken, 'utf8');
  const b = Buffer.from(headerToken, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export type CsrfCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Prueft die Herkunft des Requests.
 *
 * Fehlt sowohl `Origin` als auch `Referer`, wird durchgelassen: Nicht-Browser-
 * Clients (curl, Tests, spaetere Server-zu-Server-Aufrufe) senden keinen
 * Origin, und der Double-Submit-Token traegt die eigentliche Absicherung.
 * Ist ein Origin vorhanden, muss er zu einem erlaubten Wert passen.
 */
export function checkOrigin(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): CsrfCheckResult {
  const origin = request.headers.origin;
  const referer = request.headers.referer;
  const candidate = origin ?? referer;

  if (candidate === undefined) return { ok: true };

  let candidateOrigin: string;
  try {
    candidateOrigin = new URL(candidate).origin;
  } catch {
    return { ok: false, reason: 'Origin/Referer ist keine gueltige URL.' };
  }

  // Leere Allowlist = keine Origin-Einschraenkung (lokale Entwicklung).
  if (allowedOrigins.length === 0) return { ok: true };

  if (!allowedOrigins.includes(candidateOrigin)) {
    return { ok: false, reason: `Herkunft ${candidateOrigin} ist nicht erlaubt.` };
  }
  return { ok: true };
}

/** Fuehrt die vollstaendige CSRF-Pruefung fuer einen Request durch. */
export function checkCsrf(
  request: FastifyRequest,
  cookieToken: string | undefined,
  allowedOrigins: readonly string[],
): CsrfCheckResult {
  if (!isStateChangingMethod(request.method)) return { ok: true };

  const originCheck = checkOrigin(request, allowedOrigins);
  if (!originCheck.ok) return originCheck;

  const headerValue = request.headers['x-csrf-token'];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (!cookieToken) {
    return { ok: false, reason: 'CSRF-Cookie fehlt. Zuerst GET /api/auth/csrf aufrufen.' };
  }
  if (!headerToken) {
    return { ok: false, reason: 'Header x-csrf-token fehlt.' };
  }
  if (!csrfTokensMatch(cookieToken, headerToken)) {
    return { ok: false, reason: 'CSRF-Token stimmt nicht mit dem Cookie ueberein.' };
  }
  return { ok: true };
}
