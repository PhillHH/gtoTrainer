import { createInterface } from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { loadConfig, loadEnvFile } from '../config/env.js';
import { createDb } from '../db/client.js';
import type { Database } from '../db/client.js';
import { user } from '../db/schema.js';
import { checkPasswordPolicy, hashPassword } from './password.js';
import { deleteSessionsForUser } from './session.js';

/**
 * CLI: Passwort setzen oder aendern.
 *
 *   pnpm auth:set-password <benutzername>
 *
 * Das Passwort wird **niemals** als Argument entgegengenommen - es landete
 * sonst in der Shell-History und in der Prozessliste. Zwei Wege sind erlaubt:
 *
 * 1. Verdeckte interaktive Eingabe (Standard).
 * 2. Umgebungsvariable `NEW_PASSWORD` - fuer Automatisierung und Tests.
 */

/**
 * Liest eine Zeile, ohne die eingetippten Zeichen anzuzeigen.
 *
 * `readline` schreibt jedes Zeichen auf den Output-Stream. Deshalb wird
 * `process.stdout.write` fuer die Dauer der Eingabe stummgeschaltet.
 */
async function promptHidden(question: string): Promise<string> {
  const stdout = process.stdout;
  const originalWrite = stdout.write.bind(stdout);
  let muted = false;

  const rl = createInterface({ input: process.stdin, output: stdout, terminal: true });

  type WriteFn = typeof stdout.write;
  const mutedWrite = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (muted) return true;
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as WriteFn;

  try {
    originalWrite(question);
    stdout.write = mutedWrite;
    muted = true;
    const answer = await rl.question('');
    muted = false;
    stdout.write = originalWrite;
    originalWrite('\n');
    return answer;
  } finally {
    muted = false;
    stdout.write = originalWrite;
    rl.close();
  }
}

export interface SetPasswordResult {
  readonly username: string;
  readonly created: boolean;
  readonly invalidatedSessions: number;
}

/**
 * Legt den Benutzer an oder aendert sein Passwort und invalidiert danach alle
 * bestehenden Sessions dieses Benutzers.
 */
export async function setPassword(
  db: Database,
  username: string,
  plaintext: string,
): Promise<SetPasswordResult> {
  const policy = checkPasswordPolicy(plaintext);
  if (!policy.ok) throw new Error(policy.reason);

  const passwordHash = await hashPassword(plaintext);

  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, username))
    .limit(1);
  const found = existing[0];

  if (!found) {
    const inserted = await db
      .insert(user)
      .values({ username, passwordHash })
      .returning({ id: user.id });
    const row = inserted[0];
    if (!row) throw new Error('Benutzer konnte nicht angelegt werden.');
    return { username, created: true, invalidatedSessions: 0 };
  }

  await db.update(user).set({ passwordHash, updatedAt: new Date() }).where(eq(user.id, found.id));

  // Nach einer Passwortaenderung duerfen alte Anmeldungen nicht weitergelten.
  const invalidatedSessions = await deleteSessionsForUser(db, found.id);

  return { username, created: false, invalidatedSessions };
}

/** CLI-Einstieg: `pnpm auth:set-password <benutzername>`. */
export async function main(): Promise<void> {
  loadEnvFile();

  const username = process.argv[2]?.trim();
  if (!username) {
    console.error('Aufruf: pnpm auth:set-password <benutzername>');
    console.error('Das Passwort wird verdeckt abgefragt oder aus NEW_PASSWORD gelesen.');
    process.exit(2);
  }

  const fromEnv = process.env['NEW_PASSWORD'];
  let plaintext: string;

  if (fromEnv !== undefined && fromEnv !== '') {
    plaintext = fromEnv;
  } else {
    plaintext = await promptHidden(`Neues Passwort fuer "${username}": `);
    const repeat = await promptHidden('Passwort wiederholen: ');
    if (plaintext !== repeat) {
      console.error('Die Eingaben stimmen nicht ueberein. Abgebrochen.');
      process.exit(1);
    }
  }

  const { databaseUrl } = loadConfig();
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    const result = await setPassword(handle.db, username, plaintext);
    if (result.created) {
      console.error(`[auth] Benutzer "${result.username}" wurde angelegt.`);
    } else {
      console.error(
        `[auth] Passwort fuer "${result.username}" geaendert; ` +
          `${result.invalidatedSessions} bestehende Session(s) invalidiert.`,
      );
    }
  } finally {
    await handle.close();
  }
}
