/**
 * Vertraege rund um Authentifizierung und Session.
 *
 * Backend und Frontend teilen sich ausschliesslich diese Definitionen. Das
 * Frontend (AP1.T1.4) baut seinen API-Client darauf auf.
 */

/** Name des Cookies, das den Session-Token traegt (HttpOnly). */
export const SESSION_COOKIE_NAME = 'gto_session';

/**
 * Name des Cookies, das den CSRF-Token traegt. Bewusst **nicht** HttpOnly:
 * Der Client muss den Wert auslesen und im Header spiegeln koennen
 * (Double-Submit-Verfahren).
 */
export const CSRF_COOKIE_NAME = 'gto_csrf';

/** Header, in dem der Client den CSRF-Token zuruecksenden muss. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Anmeldedaten fuer POST /api/auth/login. */
export interface LoginRequest {
  readonly username: string;
  readonly password: string;
}

/** Basisdaten des angemeldeten Benutzers. */
export interface SessionUser {
  readonly id: string;
  readonly username: string;
}

/** Antwort auf erfolgreiches POST /api/auth/login. */
export interface LoginResponse {
  readonly user: SessionUser;
}

/** Antwort auf GET /api/auth/me bei gueltiger Session. */
export interface MeResponse {
  readonly user: SessionUser;
}

/** Antwort auf POST /api/auth/logout. */
export interface LogoutResponse {
  readonly loggedOut: true;
}

/** Antwort auf GET /api/auth/csrf - liefert den Token auch im Body. */
export interface CsrfTokenResponse {
  readonly csrfToken: string;
}

/**
 * Maschinenlesbare Fehlercodes der Auth-Endpunkte.
 *
 * `invalid_credentials` wird bewusst **sowohl** bei unbekanntem Benutzer als
 * auch bei falschem Passwort verwendet - die Antwort darf nicht verraten,
 * welches von beidem zutrifft.
 */
export const AUTH_ERROR_CODES = [
  'invalid_credentials',
  'unauthenticated',
  'csrf_failed',
  'rate_limited',
  'invalid_request',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** Einheitliche Fehlerantwort der Auth-Endpunkte. */
export interface AuthErrorResponse {
  readonly error: AuthErrorCode;
  readonly message: string;
}

/** Type-Guard fuer {@link SessionUser}. */
export function isSessionUser(value: unknown): value is SessionUser {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; username?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.username === 'string';
}

/** Type-Guard fuer {@link AuthErrorResponse}. */
export function isAuthErrorResponse(value: unknown): value is AuthErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { error?: unknown; message?: unknown };
  return (
    typeof candidate.error === 'string' &&
    (AUTH_ERROR_CODES as readonly string[]).includes(candidate.error) &&
    typeof candidate.message === 'string'
  );
}
