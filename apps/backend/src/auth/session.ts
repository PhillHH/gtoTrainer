import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { session, user } from '../db/schema.js';
import type { SessionUser } from '@gto/shared';

/**
 * Session-Verwaltung.
 *
 * Kernregel: In der Datenbank steht **nur der Hash** des Tokens
 * (`session.token_hash`). Der Klartext verlaesst den Server ausschliesslich im
 * HttpOnly-Cookie. Ein Datenbank-Leak erlaubt damit keine Uebernahme laufender
 * Sessions.
 */

/** Entropie des Session-Tokens in Byte (256 Bit). */
const TOKEN_BYTES = 32;

/** Standard-Lebensdauer einer Session. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Erzeugt einen kryptografisch sicheren Session-Token (base64url). */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Bildet den Speicher-Hash eines Tokens.
 *
 * SHA-256 genuegt hier - anders als bei Passwoertern ist der Token bereits
 * hochentropisch (256 Bit Zufall), es gibt nichts zu erraten. Ein langsamer
 * Passwort-Hash waere bei jedem Request unnoetiger Aufwand.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Vergleicht zwei Hex-Hashes in konstanter Zeit. */
export function safeHashEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  if (bufferA.length !== bufferB.length || bufferA.length === 0) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export interface CreatedSession {
  /** Klartext-Token - gehoert ausschliesslich ins Cookie. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

/** Legt eine neue Session an und liefert den Klartext-Token zurueck. */
export async function createSession(
  db: Database,
  userId: string,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + ttlMs);

  const inserted = await db
    .insert(session)
    .values({ tokenHash: hashSessionToken(token), userId, expiresAt })
    .returning({ id: session.id });

  const row = inserted[0];
  if (!row) throw new Error('Session konnte nicht angelegt werden.');

  return { token, sessionId: row.id, expiresAt };
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly user: SessionUser;
  readonly expiresAt: Date;
}

/**
 * Loest einen Klartext-Token zu einer gueltigen Session auf.
 *
 * Liefert `undefined`, wenn der Token unbekannt oder die Session abgelaufen
 * ist. Abgelaufene Zeilen werden hier nicht geloescht - das erledigt
 * {@link deleteExpiredSessions}.
 */
export async function resolveSession(
  db: Database,
  token: string,
): Promise<ResolvedSession | undefined> {
  if (!token) return undefined;

  const tokenHash = hashSessionToken(token);

  const rows = await db
    .select({
      sessionId: session.id,
      storedHash: session.tokenHash,
      expiresAt: session.expiresAt,
      userId: user.id,
      username: user.username,
    })
    .from(session)
    .innerJoin(user, eq(session.userId, user.id))
    .where(eq(session.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) return undefined;

  // Der Lookup lief bereits ueber den Hash; dieser Vergleich ist die
  // zusaetzliche Absicherung in konstanter Zeit.
  if (!safeHashEquals(row.storedHash, tokenHash)) return undefined;

  if (row.expiresAt.getTime() <= Date.now()) return undefined;

  await db.update(session).set({ lastSeenAt: new Date() }).where(eq(session.id, row.sessionId));

  return {
    sessionId: row.sessionId,
    expiresAt: row.expiresAt,
    user: { id: row.userId, username: row.username },
  };
}

/** Loescht eine einzelne Session (Logout). */
export async function deleteSessionByToken(db: Database, token: string): Promise<void> {
  if (!token) return;
  await db.delete(session).where(eq(session.tokenHash, hashSessionToken(token)));
}

/**
 * Loescht alle Sessions eines Benutzers.
 * Wird nach einer Passwortaenderung aufgerufen - alte Anmeldungen sollen dann
 * nicht weitergelten.
 */
export async function deleteSessionsForUser(db: Database, userId: string): Promise<number> {
  const deleted = await db
    .delete(session)
    .where(eq(session.userId, userId))
    .returning({ id: session.id });
  return deleted.length;
}

/**
 * Raeumt abgelaufene Sessions auf.
 *
 * Bewusst als einfache Funktion ohne Scheduler: Ein periodischer Lauf gehoert
 * in die Job-Queue und kommt fruehestens in AP2. Bis dahin kann der Aufruf bei
 * Bedarf manuell oder beim Login erfolgen.
 */
export async function deleteExpiredSessions(db: Database, now: Date = new Date()): Promise<number> {
  const deleted = await db
    .delete(session)
    .where(lt(session.expiresAt, now))
    .returning({ id: session.id });
  return deleted.length;
}

/** Nur fuer Tests: prueft, ob zu einem Klartext-Token eine Zeile existiert. */
export async function findSessionRowByToken(
  db: Database,
  token: string,
): Promise<{ id: string; tokenHash: string } | undefined> {
  const rows = await db
    .select({ id: session.id, tokenHash: session.tokenHash })
    .from(session)
    .where(and(eq(session.tokenHash, hashSessionToken(token))))
    .limit(1);
  return rows[0];
}
