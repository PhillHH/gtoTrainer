import { sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import type { Database } from '../db/client.js';
import { loadConfig } from '../config/env.js';
import { redact } from '../db/migrate.js';
import { countLearningRows, seedLearningState } from './seed.js';

/**
 * Neuanfang des Lernstands (AP4.T4.1).
 *
 * ENTWICKLUNGS- UND BETRIEBSWERKZEUG. Verwirft **den kompletten Lernfortschritt**
 * und legt die Ersteinrichtung neu an. Buchdaten, Konzept-Graph und Charts
 * bleiben unangetastet - zurueckgesetzt wird nur, was aus Ereignissen entstand.
 *
 * Warum TRUNCATE und kein DELETE: Auf `learning_event` liegt der Append-only-
 * Trigger; ein DELETE scheitert - genau so ist es gewollt. TRUNCATE ist der
 * ausdrueckliche, dokumentierte Ausweg und keine schleichende Aenderung. Wer
 * ihn aufruft, will das Protokoll verwerfen (siehe RUNBOOK 16.3).
 *
 * Die Reihenfolge in einem einzigen TRUNCATE zu nennen ist noetig, weil
 * `error_log` und `concept_mastery` auf `learning_event` mit RESTRICT zeigen.
 */
export async function resetLearningState(db: Database): Promise<void> {
  await db.execute(
    sql`truncate table skill_rating_snapshot, skill_rating, error_log, review_queue,
        concept_mastery, learning_event, learner_state`,
  );
  await seedLearningState(db);
}

/** Fehler, wenn die Bestaetigung fuer den Neuanfang fehlt. */
export class LearningResetBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearningResetBlockedError';
  }
}

/**
 * Schutz gegen versehentliche Ausfuehrung. Anders als `db:reset` ist der
 * Lernstand-Reset auch im Produktivbetrieb ein legitimer Vorgang ("ich fange
 * neu an") - er wird deshalb nicht ueber `NODE_ENV` gesperrt, sondern
 * ausschliesslich ueber eine ausdrueckliche Bestaetigung.
 */
export function assertLearningResetAllowed(confirm: string | undefined): void {
  if (confirm !== 'yes') {
    throw new LearningResetBlockedError(
      'learning:reset ist blockiert: Bestaetigung fehlt. ' +
        'Setze LEARNING_RESET_CONFIRM=yes, um den kompletten Lernfortschritt zu verwerfen. ' +
        'Buchdaten, Konzepte und Charts bleiben erhalten.',
    );
  }
}

/** CLI-Einstieg: `pnpm learning:reset`. */
export async function main(): Promise<void> {
  assertLearningResetAllowed(process.env['LEARNING_RESET_CONFIRM']);

  const { databaseUrl } = loadConfig();
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    console.error(`[learning:reset] Verwerfe Lernstand in ${redact(databaseUrl)} ...`);
    const before = await countLearningRows(handle.db);
    await resetLearningState(handle.db);
    const after = await countLearningRows(handle.db);
    console.error(
      `[learning:reset] Ereignisse vorher: ${before.learningEvent}, nachher: ${after.learningEvent}. ` +
        `Rating-Achsen neu angelegt: ${after.skillRating}, learner_state: ${after.learnerState}.`,
    );
  } finally {
    await handle.close();
  }
}
