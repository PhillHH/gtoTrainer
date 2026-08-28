import { sql } from 'drizzle-orm';
import { createDb } from './client.js';
import type { Database } from './client.js';
import { config, user } from './schema.js';
import { loadConfig } from '../config/env.js';
import { redact } from './migrate.js';
import { countLearningRows, seedLearningState } from '../learning/seed.js';

/**
 * Basis-Konfigurationseintraege. Werte sind bewusst konservativ und werden in
 * spaeteren APs ueber die Oberflaeche geaendert, nicht hier.
 */
export const BASE_CONFIG_ENTRIES: ReadonlyArray<{ key: string; value: unknown }> = [
  { key: 'schema_version', value: 1 },
  { key: 'llm.provider', value: null },
  { key: 'llm.model', value: null },
  // Fachliche Lerneinstellungen stehen seit AP4.T4.1 in `learner_state`, nicht
  // hier. Der frueher angelegte Schluessel `learning.mastery_threshold` wird
  // nicht mehr gesetzt und nicht mehr gelesen; Abgrenzung siehe
  // INTERFACES.md 17.
];

export interface SeedResult {
  readonly configKeys: number;
  readonly userCreated: boolean;
  readonly userSkippedReason?: string;
  /** Ersteinrichtung des Lernstands (AP4.T4.1). */
  readonly learnerStateCreated: boolean;
  readonly skillRatingsTotal: number;
}

/**
 * Legt die Basisdaten an. Idempotent: Mehrfaches Ausfuehren fuegt nichts
 * hinzu und schlaegt nicht fehl.
 *
 * - Konfigurationseintraege werden per `ON CONFLICT DO NOTHING` eingefuegt,
 *   damit vom Nutzer geaenderte Werte nicht zurueckgesetzt werden.
 * - Ein initialer Benutzer entsteht nur, wenn SEED_USER_USERNAME **und**
 *   SEED_USER_PASSWORD_HASH gesetzt sind. Es wird ausschliesslich ein fertiger
 *   Hash akzeptiert - Passwort-Hashing (argon2) ist AP1.T1.3.
 */
export async function seedDatabase(db: Database): Promise<SeedResult> {
  // Der Lernstand hat eine eigene Ersteinrichtung (learner_state und je
  // Themenbereich eine Rating-Achse). Sie laeuft in einer eigenen Transaktion,
  // damit sie unabhaengig vom Benutzer-Zweig unten immer greift.
  const learning = await seedLearningState(db);

  return db.transaction(async (tx) => {
    for (const entry of BASE_CONFIG_ENTRIES) {
      await tx
        .insert(config)
        .values({
          key: entry.key,
          // `value` ist JSONB NOT NULL. Ein JS-`null` wuerde von Drizzle als
          // SQL NULL gebunden und die NOT-NULL-Bedingung verletzen; als
          // JSON-Literal gecastet landet stattdessen ein JSON-`null` in der
          // Spalte - genau das ist hier mit "noch nicht konfiguriert" gemeint.
          value: sql`${JSON.stringify(entry.value)}::jsonb`,
        })
        .onConflictDoNothing({ target: config.key });
    }

    const username = process.env['SEED_USER_USERNAME']?.trim();
    const passwordHash = process.env['SEED_USER_PASSWORD_HASH']?.trim();

    if (!username || !passwordHash) {
      return {
        configKeys: BASE_CONFIG_ENTRIES.length,
        learnerStateCreated: learning.learnerStateCreated,
        skillRatingsTotal: learning.skillRatingsTotal,
        userCreated: false,
        userSkippedReason:
          'SEED_USER_USERNAME und/oder SEED_USER_PASSWORD_HASH nicht gesetzt - kein Benutzer angelegt.',
      };
    }

    const inserted = await tx
      .insert(user)
      .values({ username, passwordHash })
      .onConflictDoNothing({ target: user.username })
      .returning({ id: user.id });

    return {
      configKeys: BASE_CONFIG_ENTRIES.length,
      learnerStateCreated: learning.learnerStateCreated,
      skillRatingsTotal: learning.skillRatingsTotal,
      userCreated: inserted.length > 0,
      ...(inserted.length === 0
        ? { userSkippedReason: `Benutzer "${username}" existiert bereits.` }
        : {}),
    };
  });
}

/** Zaehlt die Zeilen der vom Seed beschriebenen Tabellen - fuer Tests/Nachweise. */
export async function countSeedRows(db: Database): Promise<{ config: number; user: number }> {
  const result = await db.execute<{ config_count: string; user_count: string }>(
    sql`select (select count(*) from ${config}) as config_count,
               (select count(*) from ${user}) as user_count`,
  );
  const row = result.rows[0];
  return {
    config: Number(row?.config_count ?? 0),
    user: Number(row?.user_count ?? 0),
  };
}

/** CLI-Einstieg: `pnpm db:seed`. */
export async function main(): Promise<void> {
  const { databaseUrl } = loadConfig();
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    console.error(`[seed] Seede ${redact(databaseUrl)} ...`);
    const result = await seedDatabase(handle.db);
    const counts = await countSeedRows(handle.db);
    console.error(
      `[seed] Konfigurationsschluessel sichergestellt: ${result.configKeys}; ` +
        `Benutzer angelegt: ${result.userCreated ? 'ja' : 'nein'}` +
        (result.userSkippedReason ? ` (${result.userSkippedReason})` : ''),
    );
    const learning = await countLearningRows(handle.db);
    console.error(`[seed] Zeilen jetzt: config=${counts.config}, user=${counts.user}`);
    console.error(
      `[seed] Lernstand: learner_state=${learning.learnerState}, ` +
        `skill_rating=${learning.skillRating}, learning_event=${learning.learningEvent}`,
    );
  } finally {
    await handle.close();
  }
}
