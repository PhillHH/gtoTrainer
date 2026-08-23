import { and, desc, eq, sql } from 'drizzle-orm';
import type { JobStatus } from '@gto/shared';
import type { Database } from '../db/client.js';
import { jobQueue } from '../db/schema.js';
import type { ClaimedJob } from './types.js';

/**
 * Zugriff auf die `job_queue`-Tabelle aus AP1 (AP2.T2.5).
 *
 * Die Queue lebt in Postgres - keine zusaetzliche Infrastruktur. Das traegt
 * fuer einen Einzelnutzer und macht Jobs mit denselben Mitteln inspizierbar
 * wie alle anderen Daten.
 */

export interface EnqueueOptions {
  readonly jobType: string;
  readonly payload: unknown;
  readonly maxAttempts?: number;
  /** Fruehester Startzeitpunkt. Ohne Angabe: sofort. */
  readonly availableAt?: Date;
}

export interface EnqueuedJob {
  readonly id: string;
  readonly jobType: string;
  readonly status: JobStatus;
}

/** Plant einen Job ein. */
export async function enqueueJob(db: Database, options: EnqueueOptions): Promise<EnqueuedJob> {
  const rows = await db
    .insert(jobQueue)
    .values({
      jobType: options.jobType,
      payload: options.payload as never,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.availableAt === undefined ? {} : { availableAt: options.availableAt }),
    })
    .returning({ id: jobQueue.id, jobType: jobQueue.jobType, status: jobQueue.status });

  const row = rows[0];
  if (row === undefined) throw new Error('Der Job liess sich nicht einplanen.');
  return { id: row.id, jobType: row.jobType, status: row.status as JobStatus };
}

/**
 * Holt den naechsten faelligen Job **atomar**.
 *
 * Der Kern ist `FOR UPDATE SKIP LOCKED` im Unterabfrage-Teil: Postgres sperrt
 * genau die eine Zeile, und ein zweiter Worker ueberspringt sie, statt zu
 * warten oder sie ebenfalls zu ziehen. Damit gibt es kein Read-then-Update-
 * Rennen - auch nicht bei mehreren Worker-Instanzen.
 *
 * Aufgenommen werden zwei Faelle:
 *
 * 1. `queued` mit erreichtem `available_at` - der Normalfall,
 * 2. `running`, dessen `claimed_at` laenger als `staleAfterMs` zurueckliegt -
 *    ein Job, dessen Worker abgestuerzt ist. Ohne diesen Zweig wuerde ein
 *    Absturz die Zeile dauerhaft blockieren.
 *
 * `attempts` wird **beim Holen** erhoeht, nicht erst beim Fehlschlag. So zaehlt
 * auch ein Absturz als Versuch, und ein Job, der den Worker reproduzierbar
 * umbringt, landet nach `max_attempts` im Dead-Letter statt in einer Schleife.
 */
export async function claimNextJob(
  db: Database,
  options: { readonly staleAfterMs: number },
): Promise<ClaimedJob | undefined> {
  const staleSeconds = Math.max(1, Math.round(options.staleAfterMs / 1000));

  const result = await db.execute(sql`
    update job_queue
       set status      = 'running',
           claimed_at  = now(),
           attempts    = attempts + 1
     where id = (
       select id
         from job_queue
        where (status = 'queued'  and available_at <= now())
           or (status = 'running' and claimed_at   <  now() - make_interval(secs => ${staleSeconds}))
        order by available_at asc, created_at asc
        limit 1
        for update skip locked
     )
    returning id, job_type, payload, attempts, max_attempts
  `);

  const row = (result.rows as readonly Record<string, unknown>[])[0];
  if (row === undefined) return undefined;

  return {
    id: String(row['id']),
    jobType: String(row['job_type']),
    payload: row['payload'],
    attempts: Number(row['attempts']),
    maxAttempts: Number(row['max_attempts']),
  };
}

/** Schliesst einen Job erfolgreich ab. */
export async function markDone(db: Database, jobId: string): Promise<void> {
  await db
    .update(jobQueue)
    .set({ status: 'done', finishedAt: new Date(), lastError: null })
    .where(eq(jobQueue.id, jobId));
}

/** Plant einen Job erneut ein - mit Backoff ueber `available_at`. */
export async function scheduleRetry(
  db: Database,
  jobId: string,
  options: { readonly nextAttemptAt: Date; readonly error: string },
): Promise<void> {
  await db
    .update(jobQueue)
    .set({
      status: 'queued',
      availableAt: options.nextAttemptAt,
      claimedAt: null,
      lastError: options.error,
    })
    .where(eq(jobQueue.id, jobId));
}

/**
 * Verschiebt einen Job in den Dead-Letter-Zustand.
 *
 * `last_error` bleibt erhalten: Ein Job verschwindet nicht still, und die
 * Ursache ist ohne Log-Suche sichtbar.
 */
export async function markDead(db: Database, jobId: string, error: string): Promise<void> {
  await db
    .update(jobQueue)
    .set({ status: 'dead', finishedAt: new Date(), lastError: error })
    .where(eq(jobQueue.id, jobId));
}

export interface JobRow {
  readonly id: string;
  readonly jobType: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: Date;
  readonly lastError: string | null;
}

/** Liest einen Job - fuer Endpunkte, Tests und Diagnose. */
export async function findJob(db: Database, jobId: string): Promise<JobRow | undefined> {
  const rows = await db.select().from(jobQueue).where(eq(jobQueue.id, jobId)).limit(1);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    jobType: row.jobType,
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    lastError: row.lastError,
  };
}

/**
 * Plant einen Dead-Letter-Job erneut ein.
 *
 * Damit ist behobene Ursache gleich wiederholbare Arbeit - ohne den Job neu
 * bauen zu muessen. `attempts` wird zurueckgesetzt, sonst waere der Job nach
 * einem Versuch sofort wieder tot.
 */
export async function requeueDeadJob(db: Database, jobId: string): Promise<JobRow | undefined> {
  const rows = await db
    .update(jobQueue)
    .set({
      status: 'queued',
      attempts: 0,
      availableAt: new Date(),
      claimedAt: null,
      finishedAt: null,
    })
    .where(and(eq(jobQueue.id, jobId), eq(jobQueue.status, 'dead')))
    .returning();

  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    jobType: row.jobType,
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    lastError: row.lastError,
  };
}

/** Die zuletzt angelegten Jobs - fuer Diagnose und RUNBOOK. */
export async function listRecentJobs(db: Database, limit = 20): Promise<readonly JobRow[]> {
  const rows = await db.select().from(jobQueue).orderBy(desc(jobQueue.createdAt)).limit(limit);
  return rows.map((row) => ({
    id: row.id,
    jobType: row.jobType,
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    lastError: row.lastError,
  }));
}
