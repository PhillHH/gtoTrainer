import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Basisschema (AP1.T1.2) - bewusst schlankes Skelett.
 *
 * Konventionen:
 * - Tabellen- und Spaltennamen in snake_case, Tabellennamen im Singular.
 * - Primaerschluessel durchgaengig `uuid` mit `gen_random_uuid()` (pgcrypto ist
 *   in Postgres 16 als Erweiterung verfuegbar; `gen_random_uuid()` ist seit
 *   Postgres 13 im Core enthalten).
 * - Alle Zeitstempel `timestamptz` - niemals `timestamp` ohne Zeitzone.
 * - Statuswerte als `text` mit CHECK-Constraint statt pg-ENUM: neue Werte
 *   lassen sich per Migration aendern, ohne einen Enum-Typ umbauen zu muessen.
 */

/** Zeitstempel-Spalten, die praktisch jede Tabelle braucht. */
const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Benutzer. Das Projekt ist Single-User-Betrieb; die Tabelle existiert hier
 * nur als Schema. Login, Passwort-Hashing und Sessions folgen in AP1.T1.3.
 *
 * `user` ist in SQL ein reserviertes Wort - Drizzle quotet den Bezeichner,
 * in rohem SQL muss er als "user" geschrieben werden.
 */
export const user = pgTable(
  'user',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    username: text('username').notNull(),
    /** Argon2-Hash. Das Erzeugen des Hashes ist AP1.T1.3, nicht dieser Task. */
    passwordHash: text('password_hash').notNull(),
    /** Base32-TOTP-Secret. Nullable: der TOTP-Hook ist in T1.3 defaultmaessig aus. */
    totpSecret: text('totp_secret'),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_username_key').on(table.username)],
);

/**
 * Sessions.
 *
 * In der Datenbank steht ausschliesslich der **Hash** des Session-Tokens
 * (`token_hash`). Der Klartext-Token existiert nur im Cookie des Clients. Wer
 * die Datenbank liest, kann daraus keine gueltige Session herstellen.
 */
export const session = pgTable(
  'session',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /**
     * SHA-256 des Klartext-Tokens, hex-kodiert. Niemals der Token selbst.
     * Siehe `src/auth/session.ts`.
     */
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [
    uniqueIndex('session_token_hash_key').on(table.tokenHash),
    index('session_user_id_idx').on(table.userId),
    // Fuer das Aufraeumen abgelaufener Sessions.
    index('session_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * Laufzeit-Konfiguration als Key/Value. Wird ab AP2 z. B. fuer Modellwahl,
 * Provider und Mastery-Schwelle genutzt. `value` ist JSONB, damit Skalare,
 * Objekte und Listen ohne Schemaaenderung abgelegt werden koennen.
 */
export const config = pgTable('config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Zulaessige Werte fuer `llm_call_log.status`. */
export const LLM_CALL_STATUSES = ['pending', 'success', 'error'] as const;

/**
 * Protokoll der LLM-Aufrufe. Skelett - befuellt wird es in AP2.
 * `prompt`/`response` sind `text` ohne Laengenbegrenzung.
 */
export const llmCallLog = pgTable(
  'llm_call_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    prompt: text('prompt').notNull(),
    response: text('response'),
    durationMs: integer('duration_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    createdAt,
  },
  (table) => [
    index('llm_call_log_created_at_idx').on(table.createdAt),
    check('llm_call_log_status_check', sql`${table.status} in ('pending', 'success', 'error')`),
  ],
);

/** Zulaessige Werte fuer `job_queue.status`. */
export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'dead'] as const;

/**
 * Job-Queue fuer asynchrone Arbeit (ab AP2 genutzt).
 *
 * `available_at` steuert Verzoegerung und Backoff: Ein Worker beansprucht den
 * aeltesten Job mit `status = 'queued' AND available_at <= now()`. Genau dafuer
 * existiert der zusammengesetzte Index (status, available_at).
 */
export const jobQueue = pgTable(
  'job_queue',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt,
  },
  (table) => [
    index('job_queue_claim_idx').on(table.status, table.availableAt),
    check(
      'job_queue_status_check',
      sql`${table.status} in ('queued', 'running', 'done', 'failed', 'dead')`,
    ),
  ],
);

/** Alle Tabellen des Basisschemas - u. a. von den Tests genutzt. */
export const BASE_TABLES = ['user', 'session', 'config', 'llm_call_log', 'job_queue'] as const;
